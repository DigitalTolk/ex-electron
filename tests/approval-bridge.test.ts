import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_BRIDGE_SOURCE,
  APPROVAL_DECIDED_EVENT,
  APPROVAL_DECISION_ATTR,
  APPROVAL_DECISION_EVENT,
  APPROVAL_REQUEST_ATTR,
  APPROVAL_REQUEST_EVENT,
  installApprovalAnswerer,
  type ApprovalDecision,
  type ApprovalNotifyPayload,
} from '../src/lib/approval-bridge';

// Shared fake document standing in for the DOM both worlds share. The verdict
// round-trip that silently broke did so because it crossed the isolated↔main
// boundary via CustomEvent detail (arrives null); this exercises the
// attribute-based crossing end to end so that can't regress.
type Handler = (e: { type: string; detail?: unknown }) => void;

function makeFakeDoc() {
  const listeners = new Map<string, Set<Handler>>();
  const attrs = new Map<string, string>();
  const doc = {
    addEventListener(type: string, handler: Handler) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(handler);
    },
    removeEventListener(type: string, handler: Handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event: { type: string; detail?: unknown }) {
      for (const handler of [...(listeners.get(event.type) ?? [])]) handler(event);
      return true;
    },
    documentElement: {
      setAttribute: (name: string, value: string) => void attrs.set(name, value),
      getAttribute: (name: string) => attrs.get(name) ?? null,
    },
  };
  return { doc, attrs };
}

class FakeEvent {
  detail?: unknown;
  constructor(public type: string, init?: { detail?: unknown }) {
    this.detail = init?.detail;
  }
}

describe('approval bridge round trip', () => {
  let fake: ReturnType<typeof makeFakeDoc>;

  beforeEach(() => {
    fake = makeFakeDoc();
    (globalThis as any).window = globalThis;
    (globalThis as any).document = fake.doc;
    (globalThis as any).Event = FakeEvent;
    (globalThis as any).CustomEvent = FakeEvent;
  });

  afterEach(() => {
    for (const k of ['__EX_APPROVAL_NOTIFY__', 'window', 'document', 'Event', 'CustomEvent']) {
      delete (globalThis as any)[k];
    }
  });

  it('crosses the request payload page → preload via a JSON attribute, not event detail', () => {
    new Function(APPROVAL_BRIDGE_SOURCE)();
    const received: ApprovalNotifyPayload[] = [];
    installApprovalAnswerer(fake.doc as unknown as Document, (p) => received.push(p), () => {});

    const payload: ApprovalNotifyPayload = { approvalID: 'ap1', runID: 'run1', title: 'T', body: 'B', choices: ['Yes', 'No'] };
    (globalThis as any).__EX_APPROVAL_NOTIFY__(payload);

    // The payload rode the DOM attribute (a string), so the preload got the
    // real object — never a null CustomEvent detail.
    expect(fake.attrs.get(APPROVAL_REQUEST_ATTR)).toBe(JSON.stringify(payload));
    expect(received).toEqual([payload]);
  });

  it('crosses the verdict preload → SPA and re-emits it as a same-world CustomEvent', () => {
    new Function(APPROVAL_BRIDGE_SOURCE)();
    let relay: ((d: ApprovalDecision) => void) | null = null;
    installApprovalAnswerer(fake.doc as unknown as Document, () => {}, (r) => {
      relay = r;
    });

    // The SPA's listener: the bug was this firing with a null detail.
    const seen: ApprovalDecision[] = [];
    fake.doc.addEventListener(APPROVAL_DECISION_EVENT, (e) => seen.push((e as { detail?: ApprovalDecision }).detail!));

    const decision: ApprovalDecision = { approvalID: 'ap1', runID: 'run1', approve: false };
    relay!(decision);

    expect(fake.attrs.get(APPROVAL_DECISION_ATTR)).toBe(JSON.stringify(decision));
    expect(seen).toEqual([decision]); // the SPA got the real verdict
  });

  it('ignores a request event with nothing stamped, and a malformed payload', () => {
    const received: ApprovalNotifyPayload[] = [];
    installApprovalAnswerer(fake.doc as unknown as Document, (p) => received.push(p), () => {});
    // No attribute stamped: nothing to notify.
    fake.doc.dispatchEvent(new FakeEvent(APPROVAL_REQUEST_EVENT));
    // Malformed JSON stamped: swallowed, the SPA card is the fallback.
    fake.attrs.set(APPROVAL_REQUEST_ATTR, '{not json');
    fake.doc.dispatchEvent(new FakeEvent(APPROVAL_REQUEST_EVENT));
    expect(received).toEqual([]);
  });

  it('ignores a signal with no stamped attribute (no phantom decisions)', () => {
    new Function(APPROVAL_BRIDGE_SOURCE)();
    const seen: unknown[] = [];
    fake.doc.addEventListener(APPROVAL_DECISION_EVENT, (e) => seen.push((e as { detail?: unknown }).detail));
    // A bare decided event with nothing stamped must not emit a decision.
    fake.doc.dispatchEvent(new FakeEvent(APPROVAL_DECIDED_EVENT));
    expect(seen).toEqual([]);
  });
});

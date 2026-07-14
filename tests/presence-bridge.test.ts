import { describe, expect, it, vi } from 'vitest';
import {
  applyPresenceState,
  installPresenceReceiver,
  PRESENCE_CHANGED_EVENT,
  PRESENCE_STATE_ATTR,
  type PresenceDoc,
} from '../src/lib/presence-bridge';

// Fake document standing in for the DOM both worlds share (same idiom as
// dnd-bridge.test.ts): an attribute map plus a dispatch log.
function makeFakeDoc() {
  const attrs = new Map<string, string>();
  const dispatched: string[] = [];
  const doc: PresenceDoc = {
    dispatchEvent(event: Event) {
      dispatched.push(event.type);
      return true;
    },
    documentElement: {
      setAttribute(name: string, value: string) {
        attrs.set(name, value);
      },
    },
  };
  return { doc, attrs, dispatched };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('applyPresenceState', () => {
  it('stamps the attribute and fires the change event', () => {
    const { doc, attrs, dispatched } = makeFakeDoc();
    applyPresenceState(doc, 'locked');
    expect(attrs.get(PRESENCE_STATE_ATTR)).toBe('locked');
    expect(dispatched).toEqual([PRESENCE_CHANGED_EVENT]);
  });
});

describe('installPresenceReceiver', () => {
  it('applies every pushed state', async () => {
    const { doc, attrs, dispatched } = makeFakeDoc();
    let push: ((state: string) => void) | null = null;
    installPresenceReceiver(
      doc,
      (cb) => {
        push = cb;
      },
      () => Promise.resolve('active'),
    );
    await flushMicrotasks();
    expect(attrs.get(PRESENCE_STATE_ATTR)).toBe('active'); // initial pull
    push!('idle');
    push!('locked');
    expect(attrs.get(PRESENCE_STATE_ATTR)).toBe('locked');
    expect(dispatched).toEqual([
      PRESENCE_CHANGED_EVENT,
      PRESENCE_CHANGED_EVENT,
      PRESENCE_CHANGED_EVENT,
    ]);
  });

  it('a failed initial pull leaves the attribute unset (web floor governs) but pushes still apply', async () => {
    const { doc, attrs } = makeFakeDoc();
    let push: ((state: string) => void) | null = null;
    installPresenceReceiver(
      doc,
      (cb) => {
        push = cb;
      },
      () => Promise.reject(new Error('ipc torn')),
    );
    await flushMicrotasks();
    expect(attrs.has(PRESENCE_STATE_ATTR)).toBe(false);
    push!('suspended');
    expect(attrs.get(PRESENCE_STATE_ATTR)).toBe('suspended');
  });

  it('subscribes before pulling so no transition can slip between the two', () => {
    const order: string[] = [];
    const { doc } = makeFakeDoc();
    installPresenceReceiver(
      doc,
      () => order.push('subscribe'),
      () => {
        order.push('pull');
        return new Promise<string>(() => {}); // never resolves — order is what matters
      },
    );
    expect(order).toEqual(['subscribe', 'pull']);
    vi.restoreAllMocks();
  });
});

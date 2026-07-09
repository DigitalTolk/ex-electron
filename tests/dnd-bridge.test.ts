import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DND_ANSWER_EVENT,
  DND_ANSWER_TIMEOUT_MS,
  DND_BRIDGE_SOURCE,
  DND_QUERY_EVENT,
  DND_STATE_ATTR,
  installDndAnswerer,
} from '../src/lib/dnd-bridge';

// Shared fake document: listener registry + <html> attribute map, standing in
// for the DOM both worlds share. The page-side source and the preload-side
// answerer are exercised against the same instance, so a full round trip
// (query → stamp → answer → resolve) runs exactly as it does in the real
// chat window.
type Handler = () => void;

function makeFakeDoc() {
  const listeners = new Map<string, Set<Handler>>();
  const attrs = new Map<string, string>();
  const doc = {
    addEventListener(type: string, handler: Handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: Handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event: { type: string }) {
      for (const handler of [...(listeners.get(event.type) ?? [])]) handler();
      return true;
    },
    documentElement: {
      setAttribute(name: string, value: string) {
        attrs.set(name, value);
      },
      getAttribute(name: string) {
        return attrs.get(name) ?? null;
      },
    },
  };
  return { doc, listeners, attrs };
}

// Minimal Event stand-in for the node test environment.
class FakeEvent {
  constructor(public type: string) {}
}

describe('DND_BRIDGE_SOURCE (page world)', () => {
  let fake: ReturnType<typeof makeFakeDoc>;

  beforeEach(() => {
    fake = makeFakeDoc();
    (globalThis as any).window = globalThis;
    (globalThis as any).document = fake.doc;
    (globalThis as any).Event = FakeEvent;
  });

  afterEach(() => {
    delete (globalThis as any).__EX_DND__;
    delete (globalThis as any).__EX_DESKTOP__;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).Event;
    vi.useRealTimers();
  });

  it('installs the desktop marker and the DnD query function', () => {
    new Function(DND_BRIDGE_SOURCE)();
    expect((globalThis as any).__EX_DESKTOP__).toBe(true);
    expect(typeof (globalThis as any).__EX_DND__).toBe('function');
  });

  it('is idempotent — re-running keeps the installed function', () => {
    new Function(DND_BRIDGE_SOURCE)();
    const installed = (globalThis as any).__EX_DND__;
    new Function(DND_BRIDGE_SOURCE)();
    expect((globalThis as any).__EX_DND__).toBe(installed);
  });

  it('resolves true from the stamped attribute when the answer event lands', async () => {
    new Function(DND_BRIDGE_SOURCE)();
    const pending = (globalThis as any).__EX_DND__() as Promise<boolean>;
    // The query event went out to the (preload) side…
    fake.attrs.set(DND_STATE_ATTR, '1');
    fake.doc.dispatchEvent(new FakeEvent(DND_ANSWER_EVENT));
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the stamp says Focus is off', async () => {
    new Function(DND_BRIDGE_SOURCE)();
    const pending = (globalThis as any).__EX_DND__() as Promise<boolean>;
    fake.attrs.set(DND_STATE_ATTR, '0');
    fake.doc.dispatchEvent(new FakeEvent(DND_ANSWER_EVENT));
    await expect(pending).resolves.toBe(false);
  });

  it('dispatches the query event for the preload side to hear', () => {
    new Function(DND_BRIDGE_SOURCE)();
    const heard: string[] = [];
    fake.doc.addEventListener(DND_QUERY_EVENT, () => heard.push(DND_QUERY_EVENT));
    void (globalThis as any).__EX_DND__();
    expect(heard).toEqual([DND_QUERY_EVENT]);
  });

  it('resolves false via the timeout when no answer ever arrives (fail toward audible)', async () => {
    vi.useFakeTimers();
    new Function(DND_BRIDGE_SOURCE)();
    const pending = (globalThis as any).__EX_DND__() as Promise<boolean>;
    vi.advanceTimersByTime(DND_ANSWER_TIMEOUT_MS);
    await expect(pending).resolves.toBe(false);
  });

  it('cleans up its answer listener and settles only once', async () => {
    new Function(DND_BRIDGE_SOURCE)();
    const pending = (globalThis as any).__EX_DND__() as Promise<boolean>;
    fake.attrs.set(DND_STATE_ATTR, '1');
    fake.doc.dispatchEvent(new FakeEvent(DND_ANSWER_EVENT));
    // A second (stray) answer must find no listener left behind.
    fake.doc.dispatchEvent(new FakeEvent(DND_ANSWER_EVENT));
    expect(fake.listeners.get(DND_ANSWER_EVENT)?.size ?? 0).toBe(0);
    await expect(pending).resolves.toBe(true);
  });

  it('supports concurrent queries, each resolving from the shared stamp', async () => {
    new Function(DND_BRIDGE_SOURCE)();
    const first = (globalThis as any).__EX_DND__() as Promise<boolean>;
    const second = (globalThis as any).__EX_DND__() as Promise<boolean>;
    fake.attrs.set(DND_STATE_ATTR, '1');
    fake.doc.dispatchEvent(new FakeEvent(DND_ANSWER_EVENT));
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });
});

describe('installDndAnswerer (preload world)', () => {
  let fake: ReturnType<typeof makeFakeDoc>;

  beforeEach(() => {
    fake = makeFakeDoc();
    (globalThis as any).Event = FakeEvent;
  });

  afterEach(() => {
    delete (globalThis as any).Event;
  });

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('stamps the state and fires the answer event on each query', async () => {
    const answers: string[] = [];
    fake.doc.addEventListener(DND_ANSWER_EVENT, () => answers.push(fake.attrs.get(DND_STATE_ATTR) ?? ''));
    installDndAnswerer(fake.doc as unknown as Document, async () => true);
    fake.doc.dispatchEvent(new FakeEvent(DND_QUERY_EVENT));
    await flush();
    expect(answers).toEqual(['1']);
  });

  it('stamps 0 when the OS reports Focus off', async () => {
    installDndAnswerer(fake.doc as unknown as Document, async () => false);
    fake.doc.dispatchEvent(new FakeEvent(DND_QUERY_EVENT));
    await flush();
    expect(fake.attrs.get(DND_STATE_ATTR)).toBe('0');
  });

  it('still answers (keeping the last stamp) when the IPC query fails', async () => {
    const answers: number[] = [];
    fake.doc.addEventListener(DND_ANSWER_EVENT, () => answers.push(1));
    fake.attrs.set(DND_STATE_ATTR, '1');
    installDndAnswerer(fake.doc as unknown as Document, async () => {
      throw new Error('ipc dead');
    });
    fake.doc.dispatchEvent(new FakeEvent(DND_QUERY_EVENT));
    await flush();
    expect(answers).toEqual([1]);
    expect(fake.attrs.get(DND_STATE_ATTR)).toBe('1');
  });

  it('answers every query in a burst', async () => {
    let calls = 0;
    installDndAnswerer(fake.doc as unknown as Document, async () => {
      calls += 1;
      return calls % 2 === 1;
    });
    const answers: number[] = [];
    fake.doc.addEventListener(DND_ANSWER_EVENT, () => answers.push(1));
    fake.doc.dispatchEvent(new FakeEvent(DND_QUERY_EVENT));
    fake.doc.dispatchEvent(new FakeEvent(DND_QUERY_EVENT));
    await flush();
    expect(answers).toHaveLength(2);
    expect(calls).toBe(2);
  });
});

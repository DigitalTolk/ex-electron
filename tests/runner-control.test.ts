import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUNNER_CONTROL_BRIDGE_SOURCE,
  RUNNER_PAGE_TIMEOUT_MS,
  RUNNER_REQUEST_ATTR,
  RUNNER_REQUEST_EVENT,
  RUNNER_RESULT_ATTR,
  RUNNER_RESULT_EVENT,
  RUNNER_STATE_ATTR,
  RUNNER_STATE_EVENT,
  installRunnerControlAnswerer,
  type RunnerControlResult,
} from '../src/lib/runner-control';

// Shared fake document: listener registry + <html> attribute map, standing in
// for the DOM both worlds share (same harness as the other bridge tests).
type Handler = () => void;

function makeFakeDoc() {
  const listeners = new Map<string, Set<Handler>>();
  const attrs = new Map<string, string>();
  const doc = {
    addEventListener(type: string, handler: Handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
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
      removeAttribute(name: string) {
        attrs.delete(name);
      },
    },
  };
  return { doc, listeners, attrs };
}

class FakeEvent {
  constructor(public type: string) {}
}

type Bridge = {
  call: (op: string, arg?: unknown) => Promise<unknown>;
  subscribe: (l: unknown) => () => void;
};

describe('RUNNER_CONTROL_BRIDGE_SOURCE (page world)', () => {
  let fake: ReturnType<typeof makeFakeDoc>;
  const bridge = () => (globalThis as any).__EX_RUNNER__ as Bridge;
  const answer = (value: unknown) => {
    fake.attrs.set(RUNNER_RESULT_ATTR, typeof value === 'string' ? value : JSON.stringify(value));
    fake.doc.dispatchEvent(new FakeEvent(RUNNER_RESULT_EVENT));
  };
  const push = (raw: string) => {
    fake.attrs.set(RUNNER_STATE_ATTR, raw);
    fake.doc.dispatchEvent(new FakeEvent(RUNNER_STATE_EVENT));
  };

  beforeEach(() => {
    fake = makeFakeDoc();
    (globalThis as any).window = globalThis;
    (globalThis as any).document = fake.doc;
    (globalThis as any).Event = FakeEvent;
    new Function(RUNNER_CONTROL_BRIDGE_SOURCE)();
  });

  afterEach(() => {
    delete (globalThis as any).__EX_RUNNER__;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).Event;
    vi.useRealTimers();
  });

  it('installs once', () => {
    const first = bridge();
    new Function(RUNNER_CONTROL_BRIDGE_SOURCE)();
    expect(bridge()).toBe(first);
  });

  it('stamps each request with its own id and resolves each by id', async () => {
    const seen: string[] = [];
    fake.doc.addEventListener(RUNNER_REQUEST_EVENT, () => seen.push(fake.attrs.get(RUNNER_REQUEST_ATTR) ?? ''));
    const a = bridge().call('getState');
    const b = bridge().call('setAutoStart', { on: true });
    expect(seen.map((s) => JSON.parse(s))).toEqual([
      { id: 1, op: 'getState', arg: null },
      { id: 2, op: 'setAutoStart', arg: { on: true } },
    ]);
    answer({ id: 2, ok: true, value: 'two' });
    answer({ id: 1, ok: false, error: 'boom' });
    await expect(b).resolves.toBe('two');
    await expect(a).rejects.toThrow('boom');
    expect(fake.attrs.has(RUNNER_RESULT_ATTR)).toBe(false);
  });

  it('ignores garbage and unknown ids, and words a missing error', async () => {
    const p = bridge().call('start');
    answer('not json');
    answer({ id: 99, ok: true });
    answer(null);
    answer({ id: 1, ok: false });
    await expect(p).rejects.toThrow('ex-runner action failed');
  });

  it('gives up when the app never answers', async () => {
    vi.useFakeTimers();
    const p = bridge().call('install');
    vi.advanceTimersByTime(RUNNER_PAGE_TIMEOUT_MS);
    await expect(p).rejects.toThrow('the ex app did not answer');
  });

  it('rejects when the request cannot be stamped', async () => {
    fake.doc.documentElement.setAttribute = () => {
      throw new Error('detached');
    };
    await expect(bridge().call('stop')).rejects.toThrow('detached');
    fake.doc.documentElement.setAttribute = () => {
      throw 'odd';
    };
    await expect(bridge().call('stop')).rejects.toThrow('ex-runner action failed');
  });

  it('pushes state to every subscriber until it unsubscribes', () => {
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error('listener bug');
    });
    const offA = bridge().subscribe(a);
    bridge().subscribe(b);
    expect(bridge().subscribe('nope')()).toBe(undefined);
    push(JSON.stringify({ process: 'running' }));
    expect(a).toHaveBeenCalledWith({ process: 'running' });
    expect(b).toHaveBeenCalled();
    offA();
    push('{oops');
    push(JSON.stringify({ process: 'stopped' }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(fake.attrs.has(RUNNER_STATE_ATTR)).toBe(false);
  });
});

describe('installRunnerControlAnswerer (preload world)', () => {
  let fake: ReturnType<typeof makeFakeDoc>;
  let relay: (state: unknown) => void = () => {};
  const results: unknown[] = [];

  beforeEach(() => {
    fake = makeFakeDoc();
    results.length = 0;
    (globalThis as any).Event = FakeEvent;
    fake.doc.addEventListener(RUNNER_RESULT_EVENT, () => results.push(JSON.parse(fake.attrs.get(RUNNER_RESULT_ATTR)!)));
  });

  afterEach(() => {
    delete (globalThis as any).Event;
  });

  const request = (raw: string | null) => {
    if (raw !== null) fake.attrs.set(RUNNER_REQUEST_ATTR, raw);
    fake.doc.dispatchEvent(new FakeEvent(RUNNER_REQUEST_EVENT));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('forwards requests to main and stamps the answers by id', async () => {
    const invoke = vi.fn(async (op: string): Promise<RunnerControlResult> =>
      op === 'getState' ? { ok: true, value: { supported: true } } : { ok: false, error: 'nope' },
    );
    installRunnerControlAnswerer(fake.doc as unknown as Document, invoke, (r) => (relay = r));
    request(JSON.stringify({ id: 7, op: 'getState', arg: null }));
    request(JSON.stringify({ id: 8, op: 'stop' }));
    await flush();
    expect(invoke).toHaveBeenCalledWith('getState', null);
    expect(results).toEqual([
      { id: 7, ok: true, value: { supported: true } },
      { id: 8, ok: false, error: 'nope' },
    ]);
    expect(fake.attrs.has(RUNNER_REQUEST_ATTR)).toBe(false);
  });

  it('answers even when main fails or returns nothing', async () => {
    let mode = 'throw';
    const invoke = vi.fn(async () => {
      if (mode === 'throw') throw new Error('main died');
      if (mode === 'odd') throw 'odd';
      return undefined as unknown as RunnerControlResult;
    });
    installRunnerControlAnswerer(fake.doc as unknown as Document, invoke, () => {});
    request(JSON.stringify({ id: 1, op: 'start' }));
    await flush();
    mode = 'odd';
    request(JSON.stringify({ id: 2, op: 'start' }));
    await flush();
    mode = 'empty';
    request(JSON.stringify({ id: 3, op: 'start' }));
    await flush();
    expect(results).toEqual([
      { id: 1, ok: false, error: 'main died' },
      { id: 2, ok: false, error: 'ex-runner action failed' },
      { id: 3, ok: false, error: 'ex-runner action failed' },
    ]);
  });

  it('drops malformed requests without asking main', async () => {
    const invoke = vi.fn();
    installRunnerControlAnswerer(fake.doc as unknown as Document, invoke, () => {});
    request(null);
    request('{oops');
    request('null');
    request(JSON.stringify({ id: 'x', op: 'start' }));
    request(JSON.stringify({ id: 1, op: 5 }));
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('relays state pushes to the page, surviving a torn-down page', () => {
    installRunnerControlAnswerer(fake.doc as unknown as Document, vi.fn(), (r) => (relay = r));
    const heard: string[] = [];
    fake.doc.addEventListener(RUNNER_STATE_EVENT, () => heard.push(fake.attrs.get(RUNNER_STATE_ATTR)!));
    relay({ process: 'running' });
    expect(heard).toEqual([JSON.stringify({ process: 'running' })]);
    fake.doc.documentElement.setAttribute = () => {
      throw new Error('gone');
    };
    expect(() => relay({ process: 'stopped' })).not.toThrow();
  });
});

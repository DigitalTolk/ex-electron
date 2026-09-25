import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_SSO_BRIDGE_SOURCE,
  CONNECTOR_SSO_PAGE_TIMEOUT_MS,
  CONNECTOR_SSO_REQUEST_ATTR,
  CONNECTOR_SSO_REQUEST_EVENT,
  CONNECTOR_SSO_RESULT_ATTR,
  CONNECTOR_SSO_RESULT_EVENT,
  bearerFromAuthHeader,
  installConnectorSSOAnswerer,
  scrubbedUserAgent,
  tokenFromCaptureURL,
  type ConnectorSSORequest,
  type ConnectorSSOResult,
} from '../src/lib/connector-sso';

// Shared fake document: listener registry + <html> attribute map, standing in
// for the DOM both worlds share (same harness as the DnD bridge tests).
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

const req: ConnectorSSORequest = {
  startURL: 'https://hub.example.net/api/auth/microsoft',
  capturePattern: '/callback?token={token}',
  apiOrigin: 'https://hub.example.net',
};

function answerWith(fake: ReturnType<typeof makeFakeDoc>, result: unknown) {
  fake.attrs.set(CONNECTOR_SSO_RESULT_ATTR, JSON.stringify(result));
  fake.doc.dispatchEvent(new FakeEvent(CONNECTOR_SSO_RESULT_EVENT));
}

describe('CONNECTOR_SSO_BRIDGE_SOURCE (page world)', () => {
  let fake: ReturnType<typeof makeFakeDoc>;

  beforeEach(() => {
    fake = makeFakeDoc();
    (globalThis as any).window = globalThis;
    (globalThis as any).document = fake.doc;
    (globalThis as any).Event = FakeEvent;
  });

  afterEach(() => {
    delete (globalThis as any).__EX_CONNECTOR_SSO__;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    delete (globalThis as any).Event;
    vi.useRealTimers();
  });

  const bridge = () => (globalThis as any).__EX_CONNECTOR_SSO__ as (opts: ConnectorSSORequest) => Promise<string>;

  it('installs the sign-in function and is idempotent', () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    const installed = bridge();
    expect(typeof installed).toBe('function');
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    expect(bridge()).toBe(installed);
  });

  it('accepts the legacy positional (startURL, capturePattern) call shape', () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    let stamped = '';
    fake.doc.addEventListener(CONNECTOR_SSO_REQUEST_EVENT, () => {
      stamped = fake.attrs.get(CONNECTOR_SSO_REQUEST_ATTR) ?? '';
    });
    void (bridge() as unknown as (a: string, b: string) => Promise<string>)(
      'https://hub.example.net/api/auth/microsoft',
      '/callback?token={token}',
    ).catch(() => {});
    expect(JSON.parse(stamped)).toEqual({
      startURL: 'https://hub.example.net/api/auth/microsoft',
      capturePattern: '/callback?token={token}',
    });
  });

  it('normalizes an unusable first argument to an empty request', () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    let stamped = '';
    fake.doc.addEventListener(CONNECTOR_SSO_REQUEST_EVENT, () => {
      stamped = fake.attrs.get(CONNECTOR_SSO_REQUEST_ATTR) ?? '';
    });
    void (bridge() as unknown as (a: unknown) => Promise<string>)(42).catch(() => {});
    expect(JSON.parse(stamped)).toEqual({});
  });

  it('stamps the request as JSON and dispatches the request event', () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    const heard: string[] = [];
    fake.doc.addEventListener(CONNECTOR_SSO_REQUEST_EVENT, () => {
      heard.push(fake.attrs.get(CONNECTOR_SSO_REQUEST_ATTR) ?? '');
    });
    void bridge()(req).catch(() => {});
    expect(heard).toEqual([JSON.stringify(req)]);
  });

  it('resolves with the captured token and clears the result attribute', async () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    const pending = bridge()(req);
    answerWith(fake, { ok: true, token: '12|abc' } satisfies ConnectorSSOResult);
    await expect(pending).resolves.toBe('12|abc');
    expect(fake.attrs.has(CONNECTOR_SSO_RESULT_ATTR)).toBe(false);
  });

  it('rejects with the shell-reported error text', async () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    const pending = bridge()(req);
    answerWith(fake, { ok: false, error: 'sign-in window was closed' });
    await expect(pending).rejects.toThrow('sign-in window was closed');
  });

  it('rejects generically on an ok result without a token, or malformed JSON', async () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    const first = bridge()(req);
    answerWith(fake, { ok: true });
    await expect(first).rejects.toThrow('sign-in window failed');

    const second = bridge()(req);
    fake.attrs.set(CONNECTOR_SSO_RESULT_ATTR, 'not json');
    fake.doc.dispatchEvent(new FakeEvent(CONNECTOR_SSO_RESULT_EVENT));
    await expect(second).rejects.toThrow('sign-in window failed');
  });

  it('is single-flight: a second concurrent request is refused', async () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    const first = bridge()(req);
    await expect(bridge()(req)).rejects.toThrow('a sign-in window is already open');
    answerWith(fake, { ok: true, token: 't' });
    await expect(first).resolves.toBe('t');
  });

  it('a stray result with nothing pending only clears the attribute', () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    answerWith(fake, { ok: true, token: 'ghost' });
    expect(fake.attrs.has(CONNECTOR_SSO_RESULT_ATTR)).toBe(false);
  });

  it('rejects via the backstop timeout when the shell never answers, freeing the slot', async () => {
    vi.useFakeTimers();
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    const pending = bridge()(req);
    vi.advanceTimersByTime(CONNECTOR_SSO_PAGE_TIMEOUT_MS);
    await expect(pending).rejects.toThrow('sign-in timed out');
    // The slot is free again.
    const again = bridge()(req);
    answerWith(fake, { ok: true, token: 't2' });
    await expect(again).resolves.toBe('t2');
  });

  it('rejects immediately when stamping the request throws', async () => {
    new Function(CONNECTOR_SSO_BRIDGE_SOURCE)();
    fake.doc.documentElement.setAttribute = () => {
      throw new Error('page torn down');
    };
    await expect(bridge()(req)).rejects.toThrow('page torn down');
  });
});

describe('installConnectorSSOAnswerer (preload world)', () => {
  let fake: ReturnType<typeof makeFakeDoc>;

  beforeEach(() => {
    fake = makeFakeDoc();
    (globalThis as any).Event = FakeEvent;
  });

  afterEach(() => {
    delete (globalThis as any).Event;
  });

  function request(payload: string) {
    fake.attrs.set(CONNECTOR_SSO_REQUEST_ATTR, payload);
    fake.doc.dispatchEvent(new FakeEvent(CONNECTOR_SSO_REQUEST_EVENT));
  }

  function lastResult(): ConnectorSSOResult | null {
    const raw = fake.attrs.get(CONNECTOR_SSO_RESULT_ATTR);
    return raw ? (JSON.parse(raw) as ConnectorSSOResult) : null;
  }

  it('forwards the parsed request to main, clears the stamp, and answers with the token', async () => {
    const capture = vi.fn(async (): Promise<ConnectorSSOResult> => ({ ok: true, token: '12|abc' }));
    installConnectorSSOAnswerer(fake.doc as unknown as Document, capture);
    const events: string[] = [];
    fake.doc.addEventListener(CONNECTOR_SSO_RESULT_EVENT, () => events.push('result'));

    request(JSON.stringify(req));
    expect(capture).toHaveBeenCalledWith(req);
    expect(fake.attrs.has(CONNECTOR_SSO_REQUEST_ATTR)).toBe(false);
    await vi.waitFor(() => expect(events).toEqual(['result']));
    expect(lastResult()).toEqual({ ok: true, token: '12|abc' });
  });

  it('ignores a request event with no stamp and a malformed stamp', () => {
    const capture = vi.fn(async (): Promise<ConnectorSSOResult> => ({ ok: true, token: 't' }));
    installConnectorSSOAnswerer(fake.doc as unknown as Document, capture);
    fake.doc.dispatchEvent(new FakeEvent(CONNECTOR_SSO_REQUEST_EVENT));
    request('not json');
    expect(capture).not.toHaveBeenCalled();
  });

  it('answers a rejected capture with its error message, and non-Errors generically', async () => {
    let fail: unknown = new Error('sign-in timed out');
    installConnectorSSOAnswerer(fake.doc as unknown as Document, () => Promise.reject(fail));
    request(JSON.stringify(req));
    await vi.waitFor(() => expect(lastResult()).toEqual({ ok: false, error: 'sign-in timed out' }));

    fail = 'kaput';
    request(JSON.stringify(req));
    await vi.waitFor(() => expect(lastResult()).toEqual({ ok: false, error: 'sign-in window failed' }));
  });

  it('answers a non-object resolution as a generic failure', async () => {
    installConnectorSSOAnswerer(
      fake.doc as unknown as Document,
      () => Promise.resolve(null as unknown as ConnectorSSOResult),
    );
    request(JSON.stringify(req));
    await vi.waitFor(() => expect(lastResult()).toEqual({ ok: false, error: 'sign-in window failed' }));
  });

  it('swallows a torn-down document when answering', async () => {
    const capture = vi.fn(async (): Promise<ConnectorSSOResult> => ({ ok: true, token: 't' }));
    installConnectorSSOAnswerer(fake.doc as unknown as Document, capture);
    fake.doc.documentElement.setAttribute = () => {
      throw new Error('gone');
    };
    request(JSON.stringify(req));
    // Nothing to assert beyond "no unhandled rejection": give the microtask a tick.
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
  });
});

describe('tokenFromCaptureURL', () => {
  const pattern = '/callback?token={token}';

  it('captures the token from the redirect URL, decoding percent-encoding', () => {
    expect(tokenFromCaptureURL('https://app.example.net/callback?token=12%7Cabcdef', pattern)).toBe('12|abcdef');
  });

  it('is host-agnostic — the pattern matches anywhere in the URL', () => {
    expect(tokenFromCaptureURL('https://other-front.example.io/callback?token=tok-1', pattern)).toBe('tok-1');
  });

  it('an unterminated {token} stops at the next query or fragment delimiter', () => {
    expect(tokenFromCaptureURL('https://a.b/callback?token=tok&state=x', pattern)).toBe('tok');
    expect(tokenFromCaptureURL('https://a.b/callback?token=tok#done', pattern)).toBe('tok');
  });

  it('honors a suffix after the placeholder', () => {
    expect(tokenFromCaptureURL('https://a.b/cb/tok-9/done', '/cb/{token}/done')).toBe('tok-9');
    expect(tokenFromCaptureURL('https://a.b/cb/tok-9', '/cb/{token}/done')).toBeNull();
  });

  it('returns null without a pattern, a placeholder, a prefix, a match, or a token', () => {
    expect(tokenFromCaptureURL('https://a.b/callback?token=t', undefined)).toBeNull();
    expect(tokenFromCaptureURL('https://a.b/callback?token=t', '/callback')).toBeNull();
    expect(tokenFromCaptureURL('https://a.b/callback?token=t', '{token}')).toBeNull();
    expect(tokenFromCaptureURL('https://a.b/login', pattern)).toBeNull();
    expect(tokenFromCaptureURL('https://a.b/callback?token=', pattern)).toBeNull();
    expect(tokenFromCaptureURL('', pattern)).toBeNull();
  });

  it('keeps the raw value when percent-decoding fails', () => {
    expect(tokenFromCaptureURL('https://a.b/callback?token=%E0%A4%A', pattern)).toBe('%E0%A4%A');
  });
});

describe('bearerFromAuthHeader', () => {
  it('extracts the bearer, case-insensitively on header name and scheme', () => {
    expect(bearerFromAuthHeader({ Authorization: 'Bearer tok-1' })).toBe('tok-1');
    expect(bearerFromAuthHeader({ authorization: 'bearer tok-2' })).toBe('tok-2');
    expect(bearerFromAuthHeader({ AUTHORIZATION: ['Bearer tok-3'] })).toBe('tok-3');
  });

  it('returns null for missing, non-string, or non-bearer values', () => {
    expect(bearerFromAuthHeader({})).toBeNull();
    expect(bearerFromAuthHeader({ 'content-type': 'application/json' })).toBeNull();
    expect(bearerFromAuthHeader({ authorization: 42 })).toBeNull();
    expect(bearerFromAuthHeader({ authorization: 'Basic dXNlcg==' })).toBeNull();
    expect(bearerFromAuthHeader({ authorization: [] })).toBeNull();
  });
});

describe('scrubbedUserAgent', () => {
  const ua = 'Mozilla/5.0 (Macintosh) ex/0.0.68 Chrome/128.0.0.0 Electron/32.1.0 Safari/537.36';

  it('drops the app and Electron tokens, leaving plain Chrome', () => {
    expect(scrubbedUserAgent(ua, 'ex')).toBe('Mozilla/5.0 (Macintosh) Chrome/128.0.0.0 Safari/537.36');
  });

  it('escapes regex metacharacters in the app name', () => {
    expect(scrubbedUserAgent('Mozilla/5.0 ex+stg/1.0 Chrome/1.0', 'ex+stg')).toBe('Mozilla/5.0 Chrome/1.0');
  });
});

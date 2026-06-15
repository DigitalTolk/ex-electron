import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_EXPIRY_THRESHOLD,
  authStateForXhr,
  bannerContent,
  CONNECTION_BANNER_ID,
  createConnectionBanner,
  isAuthExpiryStatus,
  type ConnectionState,
} from '../src/lib/connection';

describe('bannerContent', () => {
  it('hides the banner only when connected', () => {
    expect(bannerContent('connected')).toEqual({ visible: false, message: '', action: null });
  });

  it('shows a no-action banner for offline and reconnecting', () => {
    expect(bannerContent('offline').visible).toBe(true);
    expect(bannerContent('offline').action).toBeNull();
    expect(bannerContent('reconnecting').visible).toBe(true);
    expect(bannerContent('reconnecting').action).toBeNull();
  });

  it('offers a sign-in action when the session expired', () => {
    expect(bannerContent('auth-expired')).toEqual({
      visible: true,
      message: 'Your session has expired.',
      action: 'signin',
    });
  });

  it('falls back to hidden for an unknown state', () => {
    expect(bannerContent('bogus' as ConnectionState).visible).toBe(false);
  });
});

describe('isAuthExpiryStatus', () => {
  it('treats 401 and 419 as expiry', () => {
    expect(isAuthExpiryStatus(401)).toBe(true);
    expect(isAuthExpiryStatus(419)).toBe(true);
  });

  it('ignores success and other failures', () => {
    for (const code of [200, 204, 302, 400, 403, 404, 429, 500]) {
      expect(isAuthExpiryStatus(code)).toBe(false);
    }
  });
});

describe('authStateForXhr', () => {
  // Replay a sequence of [status, pathname] responses through the reducer,
  // threading the failure counter the way main.ts does, and return the final
  // outcome plus the connection state arrived at.
  function replay(
    responses: Array<[number, string]>,
    start: ConnectionState = 'connected',
  ): { state: ConnectionState; failures: number } {
    let state = start;
    let failures = 0;
    for (const [status, pathname] of responses) {
      const outcome = authStateForXhr(state, failures, status, pathname);
      failures = outcome.failures;
      if (outcome.state) state = outcome.state;
    }
    return { state, failures };
  }

  it('does not raise the banner before the threshold is reached', () => {
    expect(authStateForXhr('connected', 0, 401, '/api/messages')).toEqual({
      state: null,
      failures: 1,
    });
    expect(authStateForXhr('connected', 1, 419, '/api/messages')).toEqual({
      state: null,
      failures: 2,
    });
  });

  it('raises auth-expired only once AUTH_EXPIRY_THRESHOLD failures accumulate', () => {
    const burst: Array<[number, string]> = Array(AUTH_EXPIRY_THRESHOLD).fill([401, '/api/messages']);
    expect(replay(burst)).toEqual({ state: 'auth-expired', failures: AUTH_EXPIRY_THRESHOLD });
  });

  it('does not latch on a lone 401: a success before the threshold resets the streak', () => {
    const { state, failures } = replay([
      [401, '/api/messages'],
      [200, '/api/messages'],
      [401, '/api/messages'],
    ]);
    expect(state).toBe('connected');
    expect(failures).toBe(1);
  });

  it('clears the banner when a 2xx proves the session recovered', () => {
    expect(authStateForXhr('auth-expired', AUTH_EXPIRY_THRESHOLD, 200, '/api/messages')).toEqual({
      state: 'connected',
      failures: 0,
    });
    expect(authStateForXhr('auth-expired', AUTH_EXPIRY_THRESHOLD, 204, '/api/messages')).toEqual({
      state: 'connected',
      failures: 0,
    });
  });

  it('leaves state unchanged on a 2xx when not currently auth-expired', () => {
    expect(authStateForXhr('connected', 0, 200, '/api/messages')).toEqual({
      state: null,
      failures: 0,
    });
    expect(authStateForXhr('reconnecting', 0, 200, '/api/messages')).toEqual({
      state: null,
      failures: 0,
    });
  });

  it('does not let a 2xx clear connectivity states', () => {
    // Only auth-expired is cleared by a success; offline/reconnecting are owned
    // by the load/online handlers, not the auth watch.
    expect(authStateForXhr('reconnecting', 0, 200, '/api/messages').state).toBeNull();
    expect(authStateForXhr('offline', 0, 200, '/api/messages').state).toBeNull();
  });

  it('ignores the /auth/ login flow entirely, leaving the counter untouched', () => {
    expect(authStateForXhr('connected', 2, 401, '/auth/oidc/login')).toEqual({
      state: null,
      failures: 2,
    });
    expect(authStateForXhr('auth-expired', 0, 200, '/auth/desktop/complete')).toEqual({
      state: null,
      failures: 0,
    });
  });

  it('ignores non-expiry failures: they neither count nor reset the streak', () => {
    for (const code of [403, 404, 429, 500]) {
      expect(authStateForXhr('connected', 2, code, '/api/messages')).toEqual({
        state: null,
        failures: 2,
      });
      // ...and such a failure never spuriously clears an existing banner.
      expect(authStateForXhr('auth-expired', 5, code, '/api/messages')).toEqual({
        state: null,
        failures: 5,
      });
    }
  });
});

// Minimal fake DOM so the banner factory can be exercised under the node test
// environment, mirroring the approach used for the notification override.
class FakeElement {
  id = '';
  className = '';
  textContent = '';
  hidden = false;
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, Array<() => void>> = {};

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  addEventListener(type: string, handler: () => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  click(): void {
    for (const handler of this.listeners.click ?? []) handler();
  }
}

function fakeDocument(): { doc: Document; documentElement: FakeElement } {
  const documentElement = new FakeElement();
  const doc = {
    createElement: () => new FakeElement(),
    documentElement,
  } as unknown as Document;
  return { doc, documentElement };
}

describe('createConnectionBanner', () => {
  it('mounts a hidden banner on the document element', () => {
    const { doc, documentElement } = fakeDocument();
    createConnectionBanner(doc, { onAction: vi.fn() });

    expect(documentElement.children).toHaveLength(1);
    const container = documentElement.children[0];
    expect(container.id).toBe(CONNECTION_BANNER_ID);
    expect(container.hidden).toBe(true);
    expect(container.children).toHaveLength(2);
  });

  it('reflects each state onto the banner and action button', () => {
    const { doc, documentElement } = fakeDocument();
    const banner = createConnectionBanner(doc, { onAction: vi.fn() });
    const container = documentElement.children[0];
    const message = container.children[0];
    const action = container.children[1];

    banner.setState('reconnecting');
    expect(container.hidden).toBe(false);
    expect(message.textContent).toBe('Reconnecting…');
    expect(action.hidden).toBe(true);

    banner.setState('auth-expired');
    expect(container.hidden).toBe(false);
    expect(action.hidden).toBe(false);

    banner.setState('connected');
    expect(container.hidden).toBe(true);
    expect(action.hidden).toBe(true);
  });

  it('invokes the handler when the action button is clicked', () => {
    const { doc, documentElement } = fakeDocument();
    const onAction = vi.fn();
    createConnectionBanner(doc, { onAction });
    const action = documentElement.children[0].children[1];

    (action as unknown as FakeElement).click();
    expect(onAction).toHaveBeenCalledOnce();
  });
});

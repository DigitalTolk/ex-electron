import { describe, expect, it, vi } from 'vitest';
import {
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

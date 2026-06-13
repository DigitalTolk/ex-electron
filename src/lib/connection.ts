// Connection-state handling for the chat window. The shell owns no SPA code,
// so the main process is blind to the chat app's own WebSocket/API state. What
// it *can* observe — renderer online/offline events, power resume, page load
// failures, and HTTP status codes via session.webRequest — is mapped onto a
// small set of states. Those states drive a thin banner injected over the SPA
// (built here, wired in chat-preload) so the user always sees when the desktop
// app is reconnecting or needs them to sign in again.

export type ConnectionState = 'connected' | 'offline' | 'reconnecting' | 'auth-expired';

export interface BannerContent {
  // Whether the banner is shown at all. 'connected' is the only hidden state.
  visible: boolean;
  message: string;
  // The optional call-to-action button. Only re-auth needs a user click; the
  // connectivity states recover on their own.
  action: 'signin' | null;
}

// Pure mapping from a connection state to what the banner should render, so the
// presentation can be unit-tested without a DOM.
export function bannerContent(state: ConnectionState): BannerContent {
  switch (state) {
    case 'offline':
      return {
        visible: true,
        message: "You're offline — waiting for your connection to return…",
        action: null,
      };
    case 'reconnecting':
      return { visible: true, message: 'Reconnecting…', action: null };
    case 'auth-expired':
      return { visible: true, message: 'Your session has expired.', action: 'signin' };
    case 'connected':
    default:
      return { visible: false, message: '', action: null };
  }
}

// HTTP status codes that unambiguously mean "the saved session is no longer
// valid, re-authenticate". 401 is the standard unauthenticated response; 419 is
// Laravel's "session/CSRF token expired" page, which the chat backend uses.
// 403 is intentionally excluded — it covers legitimate per-resource
// authorization failures that don't mean the whole session is dead.
export function isAuthExpiryStatus(status: number): boolean {
  return status === 401 || status === 419;
}

export const CONNECTION_BANNER_ID = 'ex-connection-banner';

// Injected via webFrame.insertCSS from the chat preload. Scoped to our id and
// forced with !important / an `all: initial`-style reset so the untrusted SPA's
// own stylesheet can't restyle or hide our banner. Colours follow the
// DigitalTolk brand used on the auth callback page.
export const CONNECTION_BANNER_CSS = `
  #${CONNECTION_BANNER_ID} {
    all: initial !important;
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    z-index: 2147483647 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 12px !important;
    box-sizing: border-box !important;
    padding: 8px 16px !important;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    color: #ffffff !important;
    background: #231F20 !important;
    border-bottom: 2px solid #DE5D83 !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35) !important;
    text-align: center !important;
  }
  #${CONNECTION_BANNER_ID}[hidden] {
    display: none !important;
  }
  #${CONNECTION_BANNER_ID} .${CONNECTION_BANNER_ID}__action {
    all: unset !important;
    cursor: pointer !important;
    font: inherit !important;
    font-weight: 600 !important;
    color: #231F20 !important;
    background: #DE5D83 !important;
    padding: 4px 12px !important;
    border-radius: 6px !important;
    white-space: nowrap !important;
  }
  #${CONNECTION_BANNER_ID} .${CONNECTION_BANNER_ID}__action[hidden] {
    display: none !important;
  }
`;

export interface BannerHandlers {
  // Fired when the user clicks the call-to-action (sign in).
  onAction: () => void;
}

export interface ConnectionBanner {
  setState(state: ConnectionState): void;
}

// Builds the banner element and returns a controller. Called from the chat
// preload's isolated world: the element lives in the page DOM, but its click
// handler is an isolated-world closure, so the untrusted page can never reach
// the IPC channel it triggers. Attached to <html> rather than <body> so the
// SPA re-rendering its body root doesn't drop the banner.
export function createConnectionBanner(doc: Document, handlers: BannerHandlers): ConnectionBanner {
  const container = doc.createElement('div');
  container.id = CONNECTION_BANNER_ID;
  container.hidden = true;

  const message = doc.createElement('span');

  const action = doc.createElement('button');
  action.className = `${CONNECTION_BANNER_ID}__action`;
  action.textContent = 'Sign in';
  action.hidden = true;
  action.addEventListener('click', () => handlers.onAction());

  container.append(message, action);
  doc.documentElement.append(container);

  return {
    setState(state: ConnectionState): void {
      const content = bannerContent(state);
      container.hidden = !content.visible;
      message.textContent = content.message;
      action.hidden = content.action !== 'signin';
    },
  };
}

// Bridge for the chat SPA's `window.__EX_CONNECTOR_SSO__` contract (see the
// ex repo's src/types/global.d.ts): connecting an sso_window connector opens
// the service's own SSO entry point in a shell window — the user signs in
// with their Microsoft account there — and the shell captures the bearer the
// service mints, either from the redirect URL matching the connector's
// capture pattern (cliffhub ends its flow on "/callback?token=...") or, as a
// fallback, from the first Authorization header the signed-in app sends to
// its own API. The SPA then installs the captured token exactly like a paste,
// with its own session — the shell never stores it.
//
// Crossing the world boundary works exactly like the DnD/approval bridges:
// the chat window exposes NO contextBridge surface, so requests and results
// travel as JSON strings stamped on a shared <html> attribute, signalled by
// PLAIN Events (never CustomEvent detail, which does not survive the isolated
// world boundary).
//
//   page (main world)                preload (isolated world)          main
//   __EX_CONNECTOR_SSO__(opts)
//     stamp req attr + Event ──────▶ read+clear attr ─ipc invoke────▶ open capture window
//     promise pends                                                    user signs in
//     read+clear result attr ◀────── stamp result attr + Event ◀────── token captured
//     resolve(token) / reject

export const CONNECTOR_SSO_REQUEST_EVENT = 'ex:connector-sso-request'; // page → isolated (plain Event)
export const CONNECTOR_SSO_REQUEST_ATTR = 'data-ex-connector-sso-request'; // JSON request on <html>
export const CONNECTOR_SSO_RESULT_EVENT = 'ex:connector-sso-result'; // isolated → page (plain Event)
export const CONNECTOR_SSO_RESULT_ATTR = 'data-ex-connector-sso-result'; // JSON result on <html>
export const CONNECTOR_SSO_IPC = 'connector:sso'; // preload → main (invoke)

// A human is typing their Microsoft password behind this promise: the main
// process owns the real 5-minute limit, the page-side backstop only covers a
// torn-down shell that never answers.
export const CONNECTOR_SSO_PAGE_TIMEOUT_MS = 6 * 60_000;

// What the SPA asks the shell to capture.
export interface ConnectorSSORequest {
  startURL: string;
  capturePattern?: string;
  apiOrigin?: string;
}

// What the shell answers with. Main always RESOLVES the invoke with one of
// these (never throws) so error text reaches the page verbatim instead of
// wrapped in Electron's "Error invoking remote method …" prefix.
export interface ConnectorSSOResult {
  ok: boolean;
  token?: string;
  error?: string;
}

// Page-side source, injected into the main world via webFrame.executeJavaScript
// (kept as a string for that mechanism, like the other bridges). Single-flight:
// a capture opens a real window, so a second concurrent request is refused
// rather than queued.
export const CONNECTOR_SSO_BRIDGE_SOURCE = `(() => {
  if (window.__EX_CONNECTOR_SSO__) return;
  // Tolerate both call shapes so a shell/SPA version skew during rollout never
  // throws: the canonical form is a single options object, but an older SPA
  // calls (startURL, capturePattern) positionally.
  const normalizeReq = (a, b) => {
    if (a && typeof a === 'object') return a;
    if (typeof a === 'string') return { startURL: a, capturePattern: typeof b === 'string' ? b : undefined };
    return {};
  };
  let pending = null;
  document.addEventListener('${CONNECTOR_SSO_RESULT_EVENT}', () => {
    const raw = document.documentElement.getAttribute('${CONNECTOR_SSO_RESULT_ATTR}');
    // Token hygiene: the attribute is cleared the moment it is read, whether
    // or not anything still waits on it.
    document.documentElement.removeAttribute('${CONNECTOR_SSO_RESULT_ATTR}');
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    let res = null;
    try {
      res = JSON.parse(raw || '');
    } catch {
      // fall through to the generic failure below
    }
    if (res && res.ok === true && typeof res.token === 'string' && res.token) {
      p.resolve(res.token);
    } else {
      p.reject(new Error(res && typeof res.error === 'string' && res.error ? res.error : 'sign-in window failed'));
    }
  });
  window.__EX_CONNECTOR_SSO__ = (a, b) => new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('a sign-in window is already open'));
      return;
    }
    const timer = setTimeout(() => {
      pending = null;
      reject(new Error('sign-in timed out'));
    }, ${CONNECTOR_SSO_PAGE_TIMEOUT_MS});
    pending = { resolve, reject, timer };
    try {
      document.documentElement.setAttribute('${CONNECTOR_SSO_REQUEST_ATTR}', JSON.stringify(normalizeReq(a, b)));
      document.dispatchEvent(new Event('${CONNECTOR_SSO_REQUEST_EVENT}'));
    } catch (err) {
      pending = null;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error('sign-in window failed'));
    }
  });
})();`;

// installConnectorSSOAnswerer wires the preload (isolated-world) half: on each
// page request, read+clear the stamped request, hand it to main (which owns
// the capture window), and stamp+signal whatever comes back. The invoke's own
// rejection (a killed main, not a sign-in failure) still answers, so the page
// never waits out its long backstop on a healthy preload.
export function installConnectorSSOAnswerer(
  doc: Document,
  capture: (req: ConnectorSSORequest) => Promise<ConnectorSSOResult>,
): void {
  doc.addEventListener(CONNECTOR_SSO_REQUEST_EVENT, () => {
    const raw = doc.documentElement.getAttribute(CONNECTOR_SSO_REQUEST_ATTR);
    doc.documentElement.removeAttribute(CONNECTOR_SSO_REQUEST_ATTR);
    if (!raw) return;
    let req: ConnectorSSORequest;
    try {
      req = JSON.parse(raw) as ConnectorSSORequest;
    } catch {
      return;
    }
    const answer = (result: ConnectorSSOResult) => {
      try {
        doc.documentElement.setAttribute(CONNECTOR_SSO_RESULT_ATTR, JSON.stringify(result));
        doc.dispatchEvent(new Event(CONNECTOR_SSO_RESULT_EVENT));
      } catch {
        // The page tore down mid-sign-in; nothing left to answer into.
      }
    };
    capture(req).then(
      (result) => answer(result && typeof result === 'object' ? result : { ok: false, error: 'sign-in window failed' }),
      (err: unknown) => answer({ ok: false, error: err instanceof Error ? err.message : 'sign-in window failed' }),
    );
  });
}

// tokenFromCaptureURL extracts the service-minted token from a navigation URL
// using the connector's capture pattern, e.g. "/callback?token={token}". The
// pattern is matched anywhere in the URL (host-agnostic: the redirect lands on
// the service's own frontend, whose host the connector doesn't declare). An
// unterminated {token} captures up to the next query/fragment delimiter.
export function tokenFromCaptureURL(url: string, pattern?: string): string | null {
  if (!url || !pattern) return null;
  const at = pattern.indexOf('{token}');
  if (at < 1) return null; // absent, or a bare "{token}" that would match anything
  const prefix = pattern.slice(0, at);
  const suffix = pattern.slice(at + '{token}'.length);
  const start = url.indexOf(prefix);
  if (start < 0) return null;
  const from = start + prefix.length;
  let end: number;
  if (suffix) {
    end = url.indexOf(suffix, from);
    if (end < 0) return null;
  } else {
    const stop = url.slice(from).search(/[&#]/);
    end = stop < 0 ? url.length : from + stop;
  }
  const raw = url.slice(from, end);
  if (!raw) return null;
  try {
    // Sanctum tokens URL-encode their "id|secret" pipe as %7C.
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// bearerFromAuthHeader pulls the bearer out of a request's headers — the
// fallback capture for services that never expose the token in a URL: the
// signed-in app's first API call carries it.
export function bearerFromAuthHeader(headers: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    const v = Array.isArray(value) ? value[0] : value;
    if (typeof v !== 'string') continue;
    const m = /^Bearer\s+(\S+)$/i.exec(v.trim());
    if (m) return m[1];
  }
  return null;
}

// scrubbedUserAgent drops the Electron and app-name tokens from the session's
// user agent, leaving the plain Chrome string. Microsoft's sign-in pages
// refuse user agents they classify as embedded browsers; the same Chromium
// minus those two tokens is accepted.
export function scrubbedUserAgent(ua: string, appName: string): string {
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ua
    .replace(new RegExp(`\\s?${escaped}/\\S+`, 'g'), '')
    .replace(/\s?Electron\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

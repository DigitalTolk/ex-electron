// Why the chat page couldn't open, and what the full-window status screen says
// about it. Without this a failed load leaves the window on Chromium's empty
// error page (black, from the window background), and a Cloudflare block shows
// Cloudflare's own page with no way back. Pure, so it is unit-tested.

// What support needs to trace a Cloudflare refusal from a screenshot: the Ray
// ID finds the request in Cloudflare (Security → Events), and the IP, country
// and time find it even when that event has aged out.
export interface CloudflareTrace {
  code: string;
  rayId: string | null;
  ip: string | null;
  country: string | null;
}

export type LoadProblem =
  // No network at all: the OS says offline, or Chromium saw no connection.
  | { kind: 'offline' }
  // The network is up but the server never answered (DNS, refused, timeout,
  // TLS, a VPN or firewall in the way).
  | { kind: 'unreachable'; host: string; error: string; at: Date }
  // Cloudflare answered for a server that is down or erroring (52x).
  | ({ kind: 'server-down'; host: string; at: Date } & CloudflareTrace)
  // Cloudflare refused the connection: a country/region block (error 1009) or
  // a firewall rule (1020 and friends — a geo rule shows up as one of these).
  | ({ kind: 'blocked'; host: string; at: Date } & CloudflareTrace);

// Chromium net error codes (net/base/net_error_list.h).
const ERR_ABORTED = -3;
const ERR_INTERNET_DISCONNECTED = -106;

// A main-frame did-fail-load → the problem to show, or null when nothing went
// wrong (ERR_ABORTED is a navigation the app or user cancelled).
export function loadFailureProblem(
  errorCode: number,
  errorDescription: string,
  online: boolean,
  host: string,
  at: Date,
): LoadProblem | null {
  if (errorCode === ERR_ABORTED) return null;
  if (!online || errorCode === ERR_INTERNET_DISCONNECTED) return { kind: 'offline' };
  return { kind: 'unreachable', host, error: errorDescription || `error ${errorCode}`, at };
}

// What cloudflareProblem reads off a loaded page.
export interface PageFacts {
  // The visible text.
  text: string;
  // Cloudflare's footer IP. Newer pages hide it behind "Click to reveal", so
  // it is missing from the visible text but still in the element.
  footerIp: string | null;
}

// Reads PageFacts from a loaded page. Run in an isolated world: it only reads,
// and the page can't interfere with it.
export const PAGE_FACTS_SCRIPT = `({
  text: document.body ? document.body.innerText.slice(0, 20000) : '',
  footerIp: (document.getElementById('cf-footer-ip') || {}).textContent || null,
})`;

// Normalises what executeJavaScript handed back (anything, from an untrusted
// page) into PageFacts.
export function pageFacts(value: unknown): PageFacts {
  const v = (value ?? {}) as { text?: unknown; footerIp?: unknown };
  return {
    text: typeof v.text === 'string' ? v.text : '',
    footerIp: typeof v.footerIp === 'string' ? v.footerIp : null,
  };
}

const IP = /((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})/i;

function cleanIp(raw: string | null): string | null {
  const m = raw ? IP.exec(raw.trim()) : null;
  return m && m[1].trim() === raw?.trim() ? m[1] : null;
}

function traceFrom(page: PageFacts, code: string): CloudflareTrace {
  const { text } = page;
  return {
    code,
    rayId: /\bray\s+id:?\s*([0-9a-f]{8,})/i.exec(text)?.[1] ?? null,
    ip: cleanIp(page.footerIp) ?? new RegExp(`your ip:?\\s*${IP.source}`, 'i').exec(text)?.[1] ?? null,
    // 1009 names the country: "…banned the country or region your IP address is in (US)…".
    country: /your ip address is in \(([A-Z]{2})\)/i.exec(text)?.[1]?.toUpperCase() ?? null,
  };
}

// A finished main-frame load → the problem, or null for a normal page.
//
// Cloudflare's own error pages are recognised by what they print: an error
// status, the Cloudflare name, and "Error 1009" / "Error code 1020" /
// "Error code 522". An error page from the ex server itself never names
// Cloudflare, and a human-check challenge ("Just a moment…") has no error
// code, so both are left on screen untouched.
export function cloudflareProblem(status: number, page: PageFacts, host: string, at: Date): LoadProblem | null {
  if (status < 400 || !/cloudflare/i.test(page.text)) return null;
  const code = /\berror(?:\s+code)?:?\s*(\d{3,4})\b/i.exec(page.text)?.[1];
  if (!code) return null;
  if (CF_BLOCK_CODES.has(code)) return { kind: 'blocked', host, at, ...traceFrom(page, code) };
  if (status >= 500) return { kind: 'server-down', host, at, ...traceFrom(page, code) };
  return null;
}

// Cloudflare error 1009: "the owner has banned the country or region".
const CF_COUNTRY_BANNED = '1009';

// Cloudflare's "access denied" family: banned IP (1006-1008), banned country
// (1009), browser signature (1010), access denied (1012), firewall/WAF rule
// (1020). Other 1xxx codes (1015 rate limit, 1016 origin DNS…) aren't a
// block on where the user is.
const CF_BLOCK_CODES = new Set(['1006', '1007', '1008', CF_COUNTRY_BANNED, '1010', '1012', '1020']);

export interface StatusContent {
  // Which icon the screen shows (one per problem kind).
  icon: LoadProblem['kind'];
  title: string;
  message: string;
  // Small print for support, one fact per line (error, Ray ID, IP, time); may be ''.
  detail: string;
  // The app keeps retrying on its own, and the screen says so.
  retrying: boolean;
  // Offer "Change server" (the address itself may be what's wrong).
  canChangeServer: boolean;
}

// "2026-11-10 09:12:44 UTC" — the format Cloudflare prints, so the two match.
export function utcStamp(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function traceLines(p: CloudflareTrace & { host: string; at: Date }): string {
  return [
    `Cloudflare error ${p.code}`,
    p.rayId ? `Ray ID: ${p.rayId}` : '',
    p.ip ? `Your IP: ${p.ip}${p.country ? ` (${p.country})` : ''}` : '',
    `Server: ${p.host}`,
    `Time: ${utcStamp(p.at)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function statusContent(problem: LoadProblem): StatusContent {
  switch (problem.kind) {
    case 'offline':
      return {
        icon: 'offline',
        title: "You're offline",
        message: 'ex will open as soon as your internet connection is back.',
        detail: '',
        retrying: true,
        canChangeServer: false,
      };
    case 'unreachable':
      return {
        icon: 'unreachable',
        title: "Can't reach ex",
        message: `We couldn't connect to ${problem.host}. Check your internet connection, VPN or firewall, and that the server address is right.`,
        detail: `${problem.error}\nTime: ${utcStamp(problem.at)}`,
        retrying: true,
        canChangeServer: true,
      };
    case 'server-down':
      return {
        icon: 'server-down',
        title: "ex isn't responding",
        message: `${problem.host} is having trouble right now. ex will keep trying to connect.`,
        detail: traceLines(problem),
        retrying: true,
        canChangeServer: false,
      };
    case 'blocked':
      return {
        icon: 'blocked',
        title: "ex isn't available where you are",
        message:
          (problem.code === CF_COUNTRY_BANNED
            ? `${problem.host} doesn't accept connections from the country or region you're in. If you're travelling or using a VPN, switch to a network in an allowed country.`
            : `${problem.host} blocked this connection from your current location or network. If you're travelling or using a VPN, try another network.`) +
          ' If you need access, send a screenshot of this screen to your ex administrator.',
        detail: traceLines(problem),
        retrying: false,
        canChangeServer: true,
      };
  }
}

// Only failures that can heal by themselves are retried on a timer. A block
// won't lift on its own, so it waits for "Try again", a network change or a
// wake from sleep instead of hammering the firewall.
export function retriesAutomatically(problem: LoadProblem): boolean {
  return problem.kind !== 'blocked';
}

// IPC between the main process and the status screen's preload.
export const STATUS_CONTENT_IPC = 'status:content';
export const STATUS_RETRY_IPC = 'status:retry';
export const STATUS_CHANGE_SERVER_IPC = 'status:change-server';

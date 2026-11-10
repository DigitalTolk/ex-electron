import { describe, expect, it } from 'vitest';
import {
  cloudflareProblem,
  loadFailureProblem,
  pageFacts,
  PAGE_FACTS_SCRIPT,
  retriesAutomatically,
  statusContent,
  utcStamp,
  type LoadProblem,
} from '../src/lib/load-status';

const HOST = 'ex.example.com';
const AT = new Date('2026-11-10T09:12:44.123Z');
const page = (text: string, footerIp: string | null = null) => ({ text, footerIp });

// innerText of Cloudflare's own pages, trimmed to what matters.
const COUNTRY_BANNED = `Access denied
Error code 1009
What happened?
The owner of this website (ex.example.com) has banned the country or region your IP address is in (US) from accessing this website.
Was this page helpful? Yes No
Cloudflare Ray ID: 8f3a2b1c9d0e7f61 • Your IP: 203.0.113.9 • Performance & security by Cloudflare`;

const WAF_BLOCKED = `Sorry, you have been blocked
You are unable to access ex.example.com
Why have I been blocked?
This website is using a security service to protect itself from online attacks.
Error 1020
Ray ID: 8f3a2b1c9d0e7f62 • 2026-11-10 09:12:44 UTC
Access denied
Performance & security by Cloudflare`;

const ORIGIN_DOWN = `Web server is down Error code 522
Visit cloudflare.com for more information.
2026-11-10 09:12:44 UTC
Cloudflare Ray ID: 8f3a2b1c9d0e7f63`;

const CHALLENGE = `Just a moment...
ex.example.com needs to review the security of your connection before proceeding.
Verification successful. Waiting for ex.example.com to respond...
Ray ID: 8f3a2b1c9d0e7f64
Performance & security by Cloudflare`;

describe('loadFailureProblem', () => {
  it('ignores a cancelled navigation', () => {
    expect(loadFailureProblem(-3, 'ERR_ABORTED', true, HOST, AT)).toBeNull();
  });

  it('says offline when the OS is offline, whatever the error', () => {
    expect(loadFailureProblem(-105, 'ERR_NAME_NOT_RESOLVED', false, HOST, AT)).toEqual({ kind: 'offline' });
  });

  it('says offline when Chromium saw no connection', () => {
    expect(loadFailureProblem(-106, 'ERR_INTERNET_DISCONNECTED', true, HOST, AT)).toEqual({ kind: 'offline' });
  });

  it('says unreachable, with the error name, when online', () => {
    expect(loadFailureProblem(-105, 'ERR_NAME_NOT_RESOLVED', true, HOST, AT)).toEqual({
      kind: 'unreachable',
      host: HOST,
      error: 'ERR_NAME_NOT_RESOLVED',
      at: AT,
    });
  });

  it('falls back to the numeric code without a description', () => {
    expect(loadFailureProblem(-118, '', true, HOST, AT)).toEqual({
      kind: 'unreachable',
      host: HOST,
      error: 'error -118',
      at: AT,
    });
  });
});

describe('pageFacts', () => {
  it('keeps the fields the page script returned', () => {
    expect(pageFacts({ text: 'hi', footerIp: '203.0.113.9' })).toEqual({ text: 'hi', footerIp: '203.0.113.9' });
  });

  it('turns anything else into an empty page', () => {
    expect(pageFacts(null)).toEqual({ text: '', footerIp: null });
    expect(pageFacts({ text: 42, footerIp: {} })).toEqual({ text: '', footerIp: null });
  });

  it('is a script that reads the text and the hidden footer IP', () => {
    const body = { innerText: 'x'.repeat(30000) };
    const doc = { body, getElementById: (id: string) => (id === 'cf-footer-ip' ? { textContent: '203.0.113.9' } : null) };
    const run = new Function('document', `return ${PAGE_FACTS_SCRIPT}`);
    expect(run(doc)).toEqual({ text: 'x'.repeat(20000), footerIp: '203.0.113.9' });
    expect(run({ body: null, getElementById: () => null })).toEqual({ text: '', footerIp: null });
  });
});

describe('cloudflareProblem', () => {
  it('recognises a country/region block (1009) with everything support needs', () => {
    expect(cloudflareProblem(403, page(COUNTRY_BANNED), HOST, AT)).toEqual({
      kind: 'blocked',
      host: HOST,
      at: AT,
      code: '1009',
      rayId: '8f3a2b1c9d0e7f61',
      ip: '203.0.113.9',
      country: 'US',
    });
  });

  it('recognises a firewall-rule block (1020), IP hidden behind "Click to reveal"', () => {
    const text = WAF_BLOCKED.replace('Access denied', 'Your IP: Click to reveal');
    expect(cloudflareProblem(403, page(text, ' 2001:db8::7 '), HOST, AT)).toEqual({
      kind: 'blocked',
      host: HOST,
      at: AT,
      code: '1020',
      rayId: '8f3a2b1c9d0e7f62',
      ip: '2001:db8::7',
      country: null,
    });
  });

  it('ignores a footer IP that is not an IP', () => {
    expect(cloudflareProblem(403, page(WAF_BLOCKED, 'Click to reveal'), HOST, AT)).toMatchObject({ ip: null });
  });

  it('recognises an origin outage behind Cloudflare', () => {
    expect(cloudflareProblem(522, page(ORIGIN_DOWN), HOST, AT)).toEqual({
      kind: 'server-down',
      host: HOST,
      at: AT,
      code: '522',
      rayId: '8f3a2b1c9d0e7f63',
      ip: null,
      country: null,
    });
  });

  it('keeps a block without a Ray ID', () => {
    expect(cloudflareProblem(403, page('Error 1009 · Cloudflare'), HOST, AT)).toMatchObject({
      kind: 'blocked',
      code: '1009',
      rayId: null,
    });
  });

  it('leaves normal pages alone', () => {
    expect(cloudflareProblem(200, page(COUNTRY_BANNED), HOST, AT)).toBeNull();
    expect(cloudflareProblem(304, page(''), HOST, AT)).toBeNull();
  });

  it("leaves the ex server's own error pages alone", () => {
    expect(cloudflareProblem(403, page('Error 403: forbidden'), HOST, AT)).toBeNull();
    expect(cloudflareProblem(500, page('Internal Server Error'), HOST, AT)).toBeNull();
  });

  it('leaves a human-check challenge on screen for the user to solve', () => {
    expect(cloudflareProblem(403, page(CHALLENGE), HOST, AT)).toBeNull();
  });

  it("leaves Cloudflare codes that aren't a block or an outage alone", () => {
    // 1015: rate limited (429).
    expect(cloudflareProblem(429, page('Error 1015 You are being rate limited Cloudflare'), HOST, AT)).toBeNull();
  });

  it('treats a non-block 1xxx code on a 5xx as an outage', () => {
    // 1016: origin DNS error (530).
    expect(cloudflareProblem(530, page('Error 1016 Origin DNS error Cloudflare'), HOST, AT)).toMatchObject({
      kind: 'server-down',
      code: '1016',
    });
  });
});

describe('utcStamp', () => {
  it('prints UTC to the second, like Cloudflare', () => {
    expect(utcStamp(AT)).toBe('2026-11-10 09:12:44 UTC');
  });
});

describe('statusContent', () => {
  it('offline: retries, no server change', () => {
    expect(statusContent({ kind: 'offline' })).toEqual({
      icon: 'offline',
      title: "You're offline",
      message: 'ex will open as soon as your internet connection is back.',
      detail: '',
      retrying: true,
      canChangeServer: false,
    });
  });

  it('unreachable: names the host, the error and the time, offers a server change', () => {
    const c = statusContent({ kind: 'unreachable', host: HOST, error: 'ERR_CONNECTION_REFUSED', at: AT });
    expect(c.icon).toBe('unreachable');
    expect(c.title).toBe("Can't reach ex");
    expect(c.message).toContain(HOST);
    expect(c.detail).toBe('ERR_CONNECTION_REFUSED\nTime: 2026-11-10 09:12:44 UTC');
    expect(c.retrying).toBe(true);
    expect(c.canChangeServer).toBe(true);
  });

  it('server down: retries with the Cloudflare reference', () => {
    const c = statusContent({
      kind: 'server-down', host: HOST, at: AT, code: '522', rayId: 'abc12345', ip: null, country: null,
    });
    expect(c.icon).toBe('server-down');
    expect(c.title).toBe("ex isn't responding");
    expect(c.detail).toBe(
      'Cloudflare error 522\nRay ID: abc12345\nServer: ex.example.com\nTime: 2026-11-10 09:12:44 UTC',
    );
    expect(c.retrying).toBe(true);
    expect(c.canChangeServer).toBe(false);
  });

  it('country block: says it is the country, asks for a screenshot, lists the trace, does not retry', () => {
    const c = statusContent({
      kind: 'blocked', host: HOST, at: AT, code: '1009', rayId: 'abc12345', ip: '203.0.113.9', country: 'US',
    });
    expect(c.icon).toBe('blocked');
    expect(c.title).toBe("ex isn't available where you are");
    expect(c.message).toContain('country or region');
    expect(c.message).toContain('send a screenshot of this screen');
    expect(c.detail).toBe(
      'Cloudflare error 1009\nRay ID: abc12345\nYour IP: 203.0.113.9 (US)\nServer: ex.example.com\nTime: 2026-11-10 09:12:44 UTC',
    );
    expect(c.retrying).toBe(false);
    expect(c.canChangeServer).toBe(true);
  });

  it('rule block: says location or network; IP without a country', () => {
    const c = statusContent({
      kind: 'blocked', host: HOST, at: AT, code: '1020', rayId: null, ip: '2001:db8::7', country: null,
    });
    expect(c.message).toContain('location or network');
    expect(c.detail).toBe(
      'Cloudflare error 1020\nYour IP: 2001:db8::7\nServer: ex.example.com\nTime: 2026-11-10 09:12:44 UTC',
    );
  });
});

describe('retriesAutomatically', () => {
  it('retries everything but a block', () => {
    const trace = { code: '1009', rayId: null, ip: null, country: null };
    const cases: [LoadProblem, boolean][] = [
      [{ kind: 'offline' }, true],
      [{ kind: 'unreachable', host: HOST, error: 'x', at: AT }, true],
      [{ kind: 'server-down', host: HOST, at: AT, ...trace, code: '522' }, true],
      [{ kind: 'blocked', host: HOST, at: AT, ...trace }, false],
    ];
    for (const [problem, want] of cases) expect(retriesAutomatically(problem)).toBe(want);
  });
});

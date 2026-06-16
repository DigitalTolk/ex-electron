import { describe, expect, it } from 'vitest';
import { isHttpUrl, isSameHost, normalizeChatUrl, safeUrl, trimTrailingSlash } from '../src/lib/url';

describe('safeUrl', () => {
  it('returns a URL for valid input', () => {
    expect(safeUrl('https://chat.example.com/x')?.host).toBe('chat.example.com');
  });

  it('returns null for garbage', () => {
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl('')).toBeNull();
  });
});

describe('trimTrailingSlash', () => {
  it('removes a single trailing slash', () => {
    expect(trimTrailingSlash('https://x.com/')).toBe('https://x.com');
  });

  it('leaves un-slashed strings alone', () => {
    expect(trimTrailingSlash('https://x.com')).toBe('https://x.com');
  });

  it('leaves empty strings alone', () => {
    expect(trimTrailingSlash('')).toBe('');
  });
});

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl(new URL('http://x.com'))).toBe(true);
    expect(isHttpUrl(new URL('https://x.com'))).toBe(true);
  });

  it('rejects other schemes', () => {
    expect(isHttpUrl(new URL('file:///etc/passwd'))).toBe(false);
    expect(isHttpUrl(new URL('javascript:void(0)'))).toBe(false);
    expect(isHttpUrl(new URL('ftp://x.com'))).toBe(false);
  });
});

describe('isSameHost', () => {
  const chatUrl = 'https://ex.digitaltolk.net';

  it('matches a message permalink on the chat host', () => {
    const target = new URL('https://ex.digitaltolk.net/channel/service-status#msg-01KV8DRDNYPP32W24ZY7DDP7CY');
    expect(isSameHost(target, chatUrl)).toBe(true);
  });

  it('matches regardless of scheme or path differences', () => {
    expect(isSameHost(new URL('http://ex.digitaltolk.net/x'), chatUrl)).toBe(true);
  });

  it('rejects a foreign host', () => {
    expect(isSameHost(new URL('https://evil.example.com/x'), chatUrl)).toBe(false);
  });

  it('treats a different port as a different host', () => {
    expect(isSameHost(new URL('https://ex.digitaltolk.net:8443/x'), chatUrl)).toBe(false);
  });

  it('returns false when the chat URL is unparseable', () => {
    expect(isSameHost(new URL('https://ex.digitaltolk.net/x'), 'not a url')).toBe(false);
  });
});

describe('normalizeChatUrl', () => {
  it('adds https when missing', () => {
    expect(normalizeChatUrl('chat.example.com')).toBe('https://chat.example.com');
  });

  it('preserves explicit http', () => {
    expect(normalizeChatUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('strips trailing slash and trailing path', () => {
    expect(normalizeChatUrl('https://chat.example.com/')).toBe('https://chat.example.com');
  });

  it('strips paths to origin only', () => {
    expect(normalizeChatUrl('https://chat.example.com/some/path')).toBe('https://chat.example.com');
  });

  it('rejects empty input', () => {
    expect(normalizeChatUrl('   ')).toBeNull();
    expect(normalizeChatUrl('')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(normalizeChatUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeChatUrl('file:///etc/passwd')).toBeNull();
  });
});

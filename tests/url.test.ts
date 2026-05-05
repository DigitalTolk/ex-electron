import { describe, expect, it } from 'vitest';
import { isHttpUrl, normalizeChatUrl, safeUrl, trimTrailingSlash } from '../src/lib/url';

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

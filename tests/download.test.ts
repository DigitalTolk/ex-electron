import { describe, expect, it } from 'vitest';
import { imageFilename, uniqueDownloadPath } from '../src/lib/download';

describe('imageFilename', () => {
  it('keeps the URL basename when it already has an extension', () => {
    expect(imageFilename('https://ex.example.com/files/cat.png', '')).toBe('cat.png');
  });

  it('ignores query strings when deriving the basename', () => {
    expect(imageFilename('https://ex.example.com/files/cat.jpg?token=abc', '')).toBe('cat.jpg');
  });

  it('decodes percent-encoded names', () => {
    expect(imageFilename('https://ex.example.com/files/my%20photo.png', '')).toBe('my photo.png');
  });

  it('appends an extension from the Content-Type when the URL lacks one', () => {
    expect(imageFilename('https://ex.example.com/files/12345', 'image/jpeg')).toBe('12345.jpg');
  });

  it('honours Content-Type parameters', () => {
    expect(imageFilename('https://ex.example.com/files/12345', 'image/png; charset=binary')).toBe(
      '12345.png',
    );
  });

  it('falls back to a generic name for data: URLs, using the MIME extension', () => {
    expect(imageFilename('data:image/gif;base64,R0lGOD', 'image/gif')).toBe('image.gif');
  });

  it('falls back to image.png when nothing is known', () => {
    expect(imageFilename('data:application/octet-stream;base64,AAAA', '')).toBe('image.png');
  });

  it('falls back for a trailing-slash path', () => {
    expect(imageFilename('https://ex.example.com/files/', 'image/webp')).toBe('image.webp');
  });

  it('falls back for an unparseable URL', () => {
    expect(imageFilename('not a url', 'image/png')).toBe('image.png');
  });

  it('strips path separators and illegal characters from the derived name', () => {
    expect(imageFilename('https://ex.example.com/a/b/c/..%2f..%2fevil.png', '')).toBe('....evil.png');
  });
});

describe('uniqueDownloadPath', () => {
  it('returns the plain path when nothing exists', () => {
    expect(uniqueDownloadPath('/dl', 'cat.png', () => false)).toBe('/dl/cat.png');
  });

  it('suffixes a counter when the name is taken', () => {
    const taken = new Set(['/dl/cat.png', '/dl/cat (1).png']);
    expect(uniqueDownloadPath('/dl', 'cat.png', (p) => taken.has(p))).toBe('/dl/cat (2).png');
  });

  it('handles extension-less names', () => {
    const taken = new Set(['/dl/image']);
    expect(uniqueDownloadPath('/dl', 'image', (p) => taken.has(p))).toBe('/dl/image (1)');
  });
});

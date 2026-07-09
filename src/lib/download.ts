import path from 'node:path';

// Map the image MIME types the chat server is likely to serve onto file
// extensions, used when the source URL carries no usable name of its own
// (data: URLs, or attachment endpoints like /files/123 with the real type only
// in the Content-Type header).
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/x-icon': '.ico',
};

function extFromContentType(contentType: string): string {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return MIME_EXT[type] ?? '';
}

// Derive a sensible download filename for an image from its URL and the
// server's Content-Type. Prefers the URL's own basename (keeping whatever
// extension it already has), and only falls back to the MIME type for the
// extension — and a generic "image" stem — when the URL carries no usable name
// (data: URLs, extension-less attachment endpoints, trailing-slash paths).
export function imageFilename(rawUrl: string, contentType: string): string {
  const mimeExt = extFromContentType(contentType);
  let base = '';
  try {
    const u = new URL(rawUrl);
    // data: URLs put the whole payload in the pathname — never a filename.
    if (u.protocol !== 'data:') {
      // split('/') always yields at least one element, so the last is a string.
      const segments = u.pathname.split('/');
      base = decodeURIComponent(segments[segments.length - 1]);
    }
  } catch {
    // Unparseable URL — fall through to the generic name.
  }
  // Strip path separators and characters that are illegal in filenames on
  // Windows so an attacker-controlled src can't escape the download directory.
  base = base.replace(/[<>:"/\\|?*]/g, '').trim();
  if (!base) return `image${mimeExt || '.png'}`;
  if (path.extname(base)) return base;
  return `${base}${mimeExt}`;
}

// Pick a path in `dir` for `filename` that doesn't collide with an existing
// file: "photo.png", then "photo (1).png", "photo (2).png", … so an unattended
// "Save Image" never silently overwrites. The `exists` probe is injected to
// keep this pure and testable.
export function uniqueDownloadPath(
  dir: string,
  filename: string,
  exists: (candidate: string) => boolean,
): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (exists(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

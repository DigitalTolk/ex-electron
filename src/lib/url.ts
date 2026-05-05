export function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

export function isHttpUrl(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:';
}

export function normalizeChatUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // If the user typed any scheme, accept it only if it's http/https. Otherwise
  // assume they typed a bare hostname and prepend https://.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  const parsed = safeUrl(candidate);
  if (!parsed || !isHttpUrl(parsed)) return null;
  return trimTrailingSlash(parsed.origin);
}

// Codex credential sync between the user's ~/.codex and each thread's
// CODEX_HOME.
//
// Codex rotates its refresh token on every refresh and writes the new pair
// into the CODEX_HOME it ran with. Every thread runs in its own home holding a
// COPY of auth.json, so a refresh never reached the user's file — the next new
// thread copied the stale, already-spent token and codex failed with
// "refresh_token_reused" until the user signed in again. Freshness is read
// from auth.json's own last_refresh (file times are useless: a copy is new).
import fs from 'node:fs';
import path from 'node:path';

// lastRefresh returns the file's last_refresh as epoch ms; 0 when the file is
// missing, unreadable or carries no usable timestamp.
export function lastRefresh(file: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { last_refresh?: unknown };
    const t = typeof raw.last_refresh === 'string' ? Date.parse(raw.last_refresh) : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

// copyAtomic writes src over dst via a temp file + rename, owner-only, so a
// reader never sees a half-written credential.
function copyAtomic(src: string, dst: string): void {
  const tmp = path.join(path.dirname(dst), `.auth.json.${process.pid}.tmp`);
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dst);
}

// syncAuthIn seeds a thread's auth.json from the user's — unless the thread
// already holds a fresher one (it refreshed on an earlier turn). Returns false
// when the user has no auth.json to give.
export function syncAuthIn(userFile: string, threadFile: string): boolean {
  if (!fs.existsSync(userFile)) return false;
  if (lastRefresh(threadFile) > lastRefresh(userFile)) return true;
  copyAtomic(userFile, threadFile);
  return true;
}

// syncAuthOut hands a refresh made during the run back to the user's file, so
// the next thread starts from the live token. Returns whether it wrote.
export function syncAuthOut(threadFile: string, userFile: string): boolean {
  if (lastRefresh(threadFile) <= lastRefresh(userFile)) return false;
  copyAtomic(threadFile, userFile);
  return true;
}

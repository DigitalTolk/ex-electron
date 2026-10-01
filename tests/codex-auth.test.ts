import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lastRefresh, syncAuthIn, syncAuthOut } from '../src/runner/codex-auth';

let dir: string;
let user: string;
let thread: string;

const write = (file: string, lastRefreshAt: string | number | undefined, token: string) =>
  fs.writeFileSync(file, JSON.stringify({ last_refresh: lastRefreshAt, tokens: { refresh_token: token } }));
const token = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: { refresh_token: string } }).tokens.refresh_token;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'));
  user = path.join(dir, 'user-auth.json');
  thread = path.join(dir, 'thread-auth.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('lastRefresh', () => {
  it('reads last_refresh, and is 0 for anything unusable', () => {
    write(user, '2026-09-30T09:43:58.744667Z', 'a');
    expect(lastRefresh(user)).toBe(Date.parse('2026-09-30T09:43:58.744667Z'));
    expect(lastRefresh(path.join(dir, 'missing.json'))).toBe(0);
    fs.writeFileSync(thread, 'not json');
    expect(lastRefresh(thread)).toBe(0);
    write(thread, 'not a date', 'b');
    expect(lastRefresh(thread)).toBe(0);
    write(thread, 12345, 'c');
    expect(lastRefresh(thread)).toBe(0);
  });
});

describe('syncAuthIn', () => {
  it('seeds a new thread from the user, owner-only', () => {
    write(user, '2026-09-07T12:46:44Z', 'user-token');
    expect(syncAuthIn(user, thread)).toBe(true);
    expect(token(thread)).toBe('user-token');
    expect(fs.statSync(thread).mode & 0o777).toBe(0o600);
  });

  it('keeps a thread copy that refreshed more recently than the user file', () => {
    write(user, '2026-09-07T12:46:44Z', 'spent');
    write(thread, '2026-09-30T09:43:58Z', 'live');
    expect(syncAuthIn(user, thread)).toBe(true);
    expect(token(thread)).toBe('live');
  });

  it('replaces an older thread copy', () => {
    write(user, '2026-09-30T10:00:00Z', 'newer');
    write(thread, '2026-09-30T09:00:00Z', 'older');
    syncAuthIn(user, thread);
    expect(token(thread)).toBe('newer');
  });

  it('reports when the user has no credentials to give', () => {
    expect(syncAuthIn(user, thread)).toBe(false);
    expect(fs.existsSync(thread)).toBe(false);
  });
});

describe('syncAuthOut', () => {
  it('hands a refresh made during the run back to the user', () => {
    write(user, '2026-09-07T12:46:44Z', 'spent');
    write(thread, '2026-09-30T09:43:58Z', 'rotated');
    expect(syncAuthOut(thread, user)).toBe(true);
    expect(token(user)).toBe('rotated');
    expect(fs.statSync(user).mode & 0o777).toBe(0o600);
  });

  it('leaves the user file alone when the run did not refresh', () => {
    write(user, '2026-09-30T09:43:58Z', 'same');
    write(thread, '2026-09-30T09:43:58Z', 'same-copy');
    expect(syncAuthOut(thread, user)).toBe(false);
    expect(token(user)).toBe('same');
    expect(syncAuthOut(path.join(dir, 'missing.json'), user)).toBe(false);
  });
});

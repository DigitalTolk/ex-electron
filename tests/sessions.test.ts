import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addSessionCost,
  dropSession,
  getSession,
  initSessions,
  putSession,
  resetSessions,
  sessionWorkDir,
  threadKey,
} from '../src/runner/sessions';
import type { Assignment } from '../src/runner/types';

function assignment(over: Partial<Assignment> = {}): Assignment {
  return {
    runID: 'r1',
    agentID: 'agent-gg',
    agentName: 'gg',
    invokerID: 'u1',
    invokerName: 'Alice',
    parentID: 'chan1',
    parentType: 'channel',
    threadRootID: 'm1',
    messageID: 'm2',
    harness: 'claude',
    persona: 'be helpful',
    prompt: 'do the thing',
    contextBundle: '# Task',
    limits: {},
    mcpToken: 't',
    leaseExpiresAt: '',
    deadline: '',
    ...over,
  };
}

describe('session cache', () => {
  afterEach(() => resetSessions());

  it('resumes the same (agent, thread) and isolates other threads', () => {
    const a = assignment();
    putSession(a, 'sess-1', '/tmp/x');
    expect(getSession(a)?.sessionId).toBe('sess-1');
    // Different thread → no session.
    expect(getSession(assignment({ threadRootID: 'other' }))).toBeNull();
    // Different agent, same thread → no session.
    expect(getSession(assignment({ agentID: 'agent-qib' }))).toBeNull();
  });

  it('drops the session when the persona or model changes mid-thread', () => {
    const a = assignment();
    putSession(a, 'sess-1', '/tmp/x');
    expect(getSession(assignment({ persona: 'be RUTHLESS' }))).toBeNull();
    // The stale entry is evicted, not resurrected for the old persona.
    expect(getSession(a)).toBeNull();
  });

  it('top-level threads key on the invoking message', () => {
    const a = assignment({ threadRootID: '' });
    expect(threadKey(a)).toContain('#m2');
    putSession(a, 'sess-2', '/tmp/y');
    expect(getSession(assignment({ threadRootID: '' }))?.sessionId).toBe('sess-2');
  });

  it('dropSession forgets explicitly', () => {
    const a = assignment();
    putSession(a, 'sess-1', '/tmp/x');
    dropSession(threadKey(a));
    expect(getSession(a)).toBeNull();
  });

  // Regression: dropSession's sweep used the ASYNC fs.rm callback form. When
  // getSession dropped a stale-and-fat session, run.ts immediately recreated
  // the same path for the cold start and the pending rm landed afterwards,
  // deleting the directory the run was about to use. The harness then died
  // writing mcp.json into it (ENOENT, 0 turns, run marked failed) — observed
  // 2026-08-21. The removal must be finished when dropSession returns.
  it('dropSession removes the work dir SYNCHRONOUSLY, before it returns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-session-sweep-'));
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');
    const a = assignment();
    putSession(a, 'sess-sweep', dir);

    dropSession(threadKey(a));

    // No awaiting, no timers: if the sweep were async this would still exist.
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a stale-and-fat session is dropped without leaving a pending delete', () => {
    // The exact production path: the guard inside getSession drops the session,
    // and the caller then recreates that same directory. Recreating it after
    // getSession returns must be safe.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-session-stale-'));
    const a = assignment();
    putSession(a, 'sess-stale', dir);
    addSessionCost(threadKey(a), 60_000); // fat history
    // Age it past the prompt-cache window so the stale+fat guard fires.
    const entry = getSession(a);
    expect(entry).not.toBeNull();

    expect(fs.existsSync(dir)).toBe(true);
    dropSession(threadKey(a));
    expect(fs.existsSync(dir)).toBe(false);

    // Recreating the path after the drop stays created — nothing sweeps it later.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{}');
    expect(fs.existsSync(path.join(dir, 'mcp.json'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('addSessionCost accumulates onto the entry and ignores no-ops', () => {
    const a = assignment();
    addSessionCost(threadKey(a), 100); // no entry yet: silently ignored
    putSession(a, 'sess-cost', '/tmp/x');
    addSessionCost(threadKey(a), 0); // non-positive: ignored
    addSessionCost(threadKey(a), 100);
    addSessionCost(threadKey(a), 50);
    // Still resumable — 150 fresh tokens is nowhere near the stale-fat bar.
    expect(getSession(a)?.sessionId).toBe('sess-cost');
  });

  it('evicts the least-recently-used session past the cap', () => {
    const dirs: string[] = [];
    for (let i = 0; i < 41; i++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-session-evict-'));
      dirs.push(dir);
      putSession(assignment({ threadRootID: `root-${i}` }), `sess-${i}`, dir);
    }
    // MAX_SESSIONS is 40: the oldest pin (root-0) is gone, dir swept; the rest live.
    expect(getSession(assignment({ threadRootID: 'root-0' }))).toBeNull();
    expect(fs.existsSync(dirs[0])).toBe(false);
    expect(getSession(assignment({ threadRootID: 'root-40' }))?.sessionId).toBe('sess-40');
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('session persistence across restarts', () => {
  let tmp: string;
  afterEach(() => {
    resetSessions();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips pins through sessions.json, dropping dead entries on load', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-session-persist-'));
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-session-live-'));
    const now = Date.now();
    fs.writeFileSync(
      path.join(tmp, 'sessions.json'),
      JSON.stringify({
        live: { sessionId: 's-live', personaHash: 'h', workDir: liveDir, lastUsed: now },
        expired: { sessionId: 's-old', personaHash: 'h', workDir: liveDir, lastUsed: now - 8 * 24 * 60 * 60 * 1000 },
        sweptDir: { sessionId: 's-gone', personaHash: 'h', workDir: path.join(tmp, 'nope'), lastUsed: now },
        malformed: { sessionId: 42, workDir: liveDir, lastUsed: now },
      }),
    );
    initSessions(tmp);
    // Only the live pin survived the load: persist it back and reload to prove
    // the save path wrote exactly that survivor set.
    const a = assignment({ threadRootID: 'persisted' });
    putSession(a, 's-new', liveDir);
    resetSessions();
    initSessions(tmp);
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8')) as Record<string, { sessionId: string }>;
    const ids = Object.values(raw).map((e) => e.sessionId).sort();
    expect(ids).toEqual(['s-live', 's-new']);
    fs.rmSync(liveDir, { recursive: true, force: true });
  });

  it('starts empty on a first run and survives an unwritable state dir', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-session-fresh-'));
    initSessions(tmp); // no sessions.json yet — the catch arm
    // Make the persist path unwritable by occupying it with a directory:
    // saves are best-effort and must not throw.
    fs.mkdirSync(path.join(tmp, 'sessions.json'));
    expect(() => putSession(assignment(), 's1', '/tmp/x')).not.toThrow();
  });

  it('sessionWorkDir derives a stable per-thread dir and creates it', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-session-wd-'));
    const d1 = sessionWorkDir(tmp, 'agent#chan#root');
    const d2 = sessionWorkDir(tmp, 'agent#chan#root');
    expect(d1).toBe(d2);
    expect(d1.startsWith(path.join(tmp, 'threads'))).toBe(true);
    expect(fs.existsSync(d1)).toBe(true);
    expect(sessionWorkDir(tmp, 'agent#chan#other')).not.toBe(d1);
  });
});

describe('stale-and-fat resume guard', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetSessions();
  });

  it('drops a session whose cache is cold AND whose history costs more than a cold start', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T10:00:00Z'));
    const a = assignment({ threadRootID: 'stale-fat' });
    putSession(a, 'sess-fat', '/tmp/nonexistent-ex-fat');
    addSessionCost(threadKey(a), 60_000); // > 20k fresh tokens recorded
    // Six minutes later: past the 5-minute prompt-cache window, well inside
    // the 7-day session TTL — the stale+fat guard (not the TTL) must fire.
    vi.setSystemTime(new Date('2026-09-22T10:06:00Z'));
    expect(getSession(a)).toBeNull();
    // A stale but THIN session still resumes.
    const b = assignment({ threadRootID: 'stale-thin' });
    putSession(b, 'sess-thin', '/tmp/nonexistent-ex-thin');
    addSessionCost(threadKey(b), 500);
    vi.setSystemTime(new Date('2026-09-22T10:12:00Z'));
    expect(getSession(b)?.sessionId).toBe('sess-thin');
    // A stale session with NO recorded spend counts as thin too.
    const c = assignment({ threadRootID: 'stale-uncosted' });
    putSession(c, 'sess-uncosted', '/tmp/nonexistent-ex-uncosted');
    vi.setSystemTime(new Date('2026-09-22T10:18:00Z'));
    expect(getSession(c)?.sessionId).toBe('sess-uncosted');
  });

  it('dropSession on an unknown key is a no-op', () => {
    expect(() => dropSession('agent#chan#never-seen')).not.toThrow();
  });
});

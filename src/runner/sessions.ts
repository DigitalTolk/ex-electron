// Warm-session cache (buzz-pool-inspired, adapted to headless claude):
// chained conversation rounds resume the SAME claude session per
// (agent, thread) via `claude -p --resume <id>` instead of cold-starting and
// re-sending the whole context bundle every round. The session — and its
// working directory, which claude ties sessions to — lives on this machine
// exactly as long as the conversation stays warm.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Assignment } from './types';

const MAX_SESSIONS = 40;
// A thread IS a session: coming back to an old thread days later should
// land in the same warm session. The TTL is hygiene for truly dead threads,
// not a conversation boundary.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Resuming replays the session's WHOLE recorded history through the model.
// Within the provider's prompt-cache lifetime that replay is nearly free;
// after it expires the full history is re-billed as cache writes. So a
// session that is both STALE (cache certainly cold) and FAT (history costs
// more to replay than a cold start's trimmed bundle) must not be resumed.
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;
const RESUME_MAX_STALE_HISTORY_TOKENS = 20_000;

interface SessionEntry {
  sessionId: string;
  personaHash: string;
  workDir: string;
  lastUsed: number;
  // Accumulated fresh tokens spent across this session's runs — a proxy for
  // how big a history a resume would replay.
  historyTokens?: number;
}

const sessions = new Map<string, SessionEntry>();

// Pins survive app restarts: the map mirrors to <stateDir>/sessions.json.
// The harness-side conversation state (claude session files, codex rollouts)
// already lives on disk — losing only the pin map was what forced cold
// restarts after every app relaunch.
let persistPath: string | null = null;

export function initSessions(stateDir: string): void {
  persistPath = path.join(stateDir, 'sessions.json');
  try {
    const raw = JSON.parse(fs.readFileSync(persistPath, 'utf8')) as Record<string, SessionEntry>;
    const now = Date.now();
    for (const [key, e] of Object.entries(raw)) {
      if (
        e &&
        typeof e.sessionId === 'string' &&
        typeof e.workDir === 'string' &&
        now - e.lastUsed <= SESSION_TTL_MS &&
        fs.existsSync(e.workDir)
      ) {
        sessions.set(key, e);
      }
    }
  } catch {
    // First run or corrupt file — start empty.
  }
}

function save(): void {
  if (!persistPath) return;
  try {
    fs.writeFileSync(persistPath, JSON.stringify(Object.fromEntries(sessions)));
  } catch {
    // Best-effort: an unsaved pin just means a cold start after restart.
  }
}

// threadKey identifies one agent's seat in one conversation thread.
export function threadKey(a: Assignment): string {
  return `${a.agentID}#${a.parentID}#${a.threadRootID || a.messageID}`;
}

export function personaHash(a: Assignment): string {
  return crypto.createHash('sha256').update(`${a.persona}\u0000${a.model ?? ''}`).digest('hex').slice(0, 16);
}

// sessionWorkDir returns a STABLE per-thread working directory — claude
// sessions are bound to their cwd, so resuming requires the same dir.
export function sessionWorkDir(stateDir: string, key: string): string {
  const slug = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const dir = path.join(stateDir, 'threads', slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// getSession returns a resumable session for this assignment, or null when
// none exists / the persona or model changed (a re-pin mid-thread must not
// resume a session primed with the old persona).
export function getSession(a: Assignment): SessionEntry | null {
  const e = sessions.get(threadKey(a));
  if (!e) return null;
  if (Date.now() - e.lastUsed > SESSION_TTL_MS || e.personaHash !== personaHash(a)) {
    dropSession(threadKey(a));
    return null;
  }
  // Stale + fat → a resume would re-bill the whole history as cache writes,
  // costing MORE than a cold start's trimmed bundle. Start cold instead;
  // conversational continuity survives via the thread window in the bundle.
  if (
    Date.now() - e.lastUsed > PROMPT_CACHE_TTL_MS &&
    (e.historyTokens ?? 0) > RESUME_MAX_STALE_HISTORY_TOKENS
  ) {
    dropSession(threadKey(a));
    return null;
  }
  return e;
}

// addSessionCost accumulates a finished run's fresh-token spend onto its
// session — the resume-vs-cold decision above reads it.
export function addSessionCost(key: string, tokens: number): void {
  const e = sessions.get(key);
  if (!e || tokens <= 0) return;
  e.historyTokens = (e.historyTokens ?? 0) + tokens;
  save();
}

// putSession records the session the harness reported for this thread.
export function putSession(a: Assignment, sessionId: string, workDir: string): void {
  sessions.set(threadKey(a), {
    sessionId,
    personaHash: personaHash(a),
    workDir,
    lastUsed: Date.now(),
  });
  evict();
  save();
}

// dropSession forgets a session (failed resume, eviction) and sweeps its dir.
//
// The sweep MUST be synchronous. getSession drops a stale-and-fat session and
// returns null, whereupon run.ts immediately recreates the SAME path via
// sessionWorkDir() for the cold start. An async rm loses that race: it lands
// after the mkdir and deletes the directory the run is about to work in, and
// the harness then dies writing mcp.json into it ("ENOENT ... /mcp.json",
// 0 turns, run marked failed). Ordering here is load-bearing, not hygiene.
export function dropSession(key: string): void {
  const e = sessions.get(key);
  sessions.delete(key);
  if (e) {
    try {
      fs.rmSync(e.workDir, { recursive: true, force: true });
    } catch {
      // Best effort: a dir we cannot remove is stale state, not a reason to
      // fail the run that is about to start.
    }
  }
  save();
}

function evict(): void {
  if (sessions.size <= MAX_SESSIONS) return;
  const entries = [...sessions.entries()].sort((x, y) => x[1].lastUsed - y[1].lastUsed);
  for (const [key] of entries.slice(0, sessions.size - MAX_SESSIONS)) {
    dropSession(key);
  }
}

// resetSessions clears everything (tests / logout).
export function resetSessions(): void {
  for (const key of [...sessions.keys()]) sessions.delete(key);
}

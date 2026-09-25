// Runner entry point: register → claim long-poll → execute → heartbeat.
// Deliberately Electron-free (plan-v2 §2): main.ts calls startRunner() with
// paths and a token; a headless ex-agentd later is a thin wrapper over the
// same function.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RunnerApi, RunnerApiError, type RunnerIdentity } from './api';
import { detectHarnesses, loginShellPath, type DetectedHarness } from './detect';
import { executeAssignment } from './run';
import { initSessions } from './sessions';
import type { RunnerLogger } from './types';

const HEARTBEAT_MS = 10_000;
const CLAIM_WAIT_SEC = 20; // server caps at 20s; global timeout is 30s
const CLAIM_BACKOFF_MS = 5_000; // after an error, not after an empty poll
const MAX_CONCURRENT = 2;

export interface RunnerConfig {
  baseUrl: string; // chat server origin
  token: string; // runner-scoped JWT (minted by the SPA, handed over IPC)
  stateDir: string; // where the stable runnerID persists
  // Code workspace root for coding tasks (unset → ~/ex-workspace).
  workspaceRoot?: string;
  mcpEntry: { command: string; args: string[] }; // how the CLI spawns our MCP server
  log?: RunnerLogger;
}

export interface RunnerHandle {
  stop(): Promise<void>;
  status(): { runnerID: string; harnesses: string[]; activeRuns: number };
}

// stableRunnerID persists one ID per install so the backend sees the same
// runner across restarts (multiple machines = multiple IDs, by design).
function stableRunnerID(stateDir: string): string {
  const file = path.join(stateDir, 'runner-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // first boot
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, id, 'utf8');
  return id;
}

export async function startRunner(cfg: RunnerConfig): Promise<RunnerHandle> {
  const log: RunnerLogger = cfg.log ?? ((msg, extra) => console.log('[runner]', msg, extra ?? ''));
  const api = new RunnerApi(cfg.baseUrl, cfg.token);
  const runnerID = stableRunnerID(cfg.stateDir);
  initSessions(cfg.stateDir); // reload per-thread session pins from last app run
  const searchPath = await loginShellPath(log);
  const harnesses: DetectedHarness[] = await detectHarnesses(log);

  const identity: RunnerIdentity = {
    runnerID,
    host: os.hostname(),
    os: process.platform,
    harnesses: harnesses.map(({ name, version, authed }) => ({ name, version, authed })),
  };

  const reg = await api.register(identity);
  log('registered', { runnerID, agents: reg.agents.map((a) => a.slug) });

  let stopped = false;
  const active = new Map<string, Promise<void>>();
  // Kill switches for spawned harnesses, keyed by runID. The heartbeat kill
  // list must be able to terminate a WEDGED harness — one that isn't sending
  // event batches and so will never hear the pump's "abort" response.
  const kills = new Map<string, (reason: string) => void>();

  // Heartbeat: refreshes the runner lease + every active run's lease, and
  // learns which runs to kill (terminal server-side). A missed heartbeat is
  // exactly how the backend detects a closed laptop — never block it on run
  // work.
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const res = await api.heartbeat(identity, [...active.keys()]);
        // kill is null (not []) when there's nothing to kill — Go marshals a
        // nil slice as JSON null.
        for (const runID of res.kill ?? []) {
          log('server says kill', { runID });
          // Actually terminate the harness tree — previously this only
          // dropped the bookkeeping entry, and a silent harness (no event
          // batches → no abort response) kept burning until its deadline.
          kills.get(runID)?.('server_kill');
          active.delete(runID);
        }
      } catch (err) {
        log('heartbeat failed', { error: String(err) });
      }
    })();
  }, HEARTBEAT_MS);

  // Claim loop: park on the server's long-poll; execute what it hands out.
  const claimLoop = (async () => {
    while (!stopped) {
      try {
        const slots = MAX_CONCURRENT - active.size;
        if (slots <= 0) {
          await sleep(1000);
          continue;
        }
        const assignments = await api.claim(identity, slots, CLAIM_WAIT_SEC);
        for (const a of assignments) {
          log('claimed run', { runID: a.runID, agent: a.agentName, harness: a.harness });
          const p = executeAssignment(a, {
            api,
            runnerID,
            baseUrl: cfg.baseUrl,
            harnesses,
            searchPath,
            mcpEntry: cfg.mcpEntry,
            onHarness: (runID, kill) => kills.set(runID, kill),
            stateDir: cfg.stateDir,
            workspaceRoot: cfg.workspaceRoot,
            log,
          }).finally(() => {
            active.delete(a.runID);
            kills.delete(a.runID);
          });
          active.set(a.runID, p);
        }
      } catch (err) {
        if (stopped) break;
        if (err instanceof RunnerApiError && err.status === 401) {
          // Token revoked/expired: surface loudly and stop — the shell must
          // re-mint via the SPA, not spin on 401s.
          log('runner token rejected; stopping', { error: err.message });
          break;
        }
        log('claim failed; backing off', { error: String(err) });
        await sleep(CLAIM_BACKOFF_MS);
      }
    }
  })();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(heartbeatTimer);
      await Promise.allSettled([...active.values()]);
      await claimLoop.catch(() => {});
    },
    status() {
      return {
        runnerID,
        harnesses: harnesses.map((h) => h.name),
        activeRuns: active.size,
      };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

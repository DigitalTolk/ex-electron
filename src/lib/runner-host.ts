// Main-process host for the agent runner: token custody and runner
// lifecycle. This is the only file that couples the Electron shell to
// src/runner/ — the runner itself stays Electron-free.
//
// The runner token lives in MEMORY ONLY. It used to be encrypted to disk with
// safeStorage so agents could come online before the SPA finished loading,
// but that key lives in the login keychain: any build whose code signature
// does not match the ACL that created the item makes macOS demand the
// keychain password, which is not something to put in front of a user for a
// token we can simply mint again. The SPA holds the session and re-mints on
// every load, so there is nothing here worth persisting — and a 30-day
// runner JWT no longer sits at rest on disk, which matters while per-token
// revocation does not exist server-side.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { startRunner, type RunnerHandle } from '../runner';

const TOKEN_FILE = 'runner-token.bin'; // legacy: written by v0.0.16 only

interface HostState {
  handle: RunnerHandle | null;
  starting: boolean;
  token: string | null;
  chatUrl: string | null;
}

const state: HostState = { handle: null, starting: false, token: null, chatUrl: null };

function tokenPath(): string {
  return path.join(app.getPath('userData'), TOKEN_FILE);
}

// dropLegacyToken removes the encrypted token file v0.0.16 left behind. It
// deletes the file WITHOUT decrypting it — reading it is what triggered the
// keychain prompt — so upgrading users never see the dialog again. The
// keychain item itself stays (safeStorage has no delete API); unused, it is
// inert.
export function dropLegacyToken(): void {
  try {
    fs.rmSync(tokenPath(), { force: true });
  } catch {
    // best-effort
  }
}

// onRunnerToken handles a fresh token from the SPA (over the chat-preload
// bridge): hold it and (re)start the runner with it. This is the ONLY way the
// runner gets a token, so the runner comes online once a session exists — and
// goes offline with it, which is what a signed-out user's agents should do.
export function onRunnerToken(token: string, chatUrl: string): void {
  if (state.token === token && state.handle) return; // same token, running
  state.token = token;
  state.chatUrl = chatUrl;
  void restartRunner();
}

async function restartRunner(): Promise<void> {
  if (state.starting) return;
  state.starting = true;
  try {
    if (state.handle) {
      await state.handle.stop();
      state.handle = null;
    }
    if (!state.token || !state.chatUrl) return;
    state.handle = await startRunner({
      baseUrl: state.chatUrl,
      token: state.token,
      stateDir: path.join(app.getPath('userData'), 'agent-runner'),
      // The harness CLI spawns our MCP server as: <electron> dist/mcp-server.js
      // with ELECTRON_RUN_AS_NODE=1 (set by the runner) — no system Node needed.
      mcpEntry: {
        command: process.execPath,
        args: [path.join(__dirname, 'mcp-server.js')],
      },
      log: (msg, extra) => console.log('[agent-runner]', msg, extra ?? ''),
    });
  } catch (err) {
    console.error('agent runner start failed:', err);
    state.handle = null;
  } finally {
    state.starting = false;
  }
}

// stopRunner is called on app quit and on sign-out (a signed-out user's
// agents must go offline). Dropping the in-memory token is the whole of it
// now — nothing was written down.
export async function stopRunner(): Promise<void> {
  const handle = state.handle;
  state.handle = null;
  state.token = null;
  if (handle) await handle.stop().catch(() => {});
}

// pauseRunner stops execution but keeps the in-memory token (app quit, server
// change) — the SPA re-mints on the next load either way.
export async function pauseRunner(): Promise<void> {
  const handle = state.handle;
  state.handle = null;
  if (handle) await handle.stop().catch(() => {});
}

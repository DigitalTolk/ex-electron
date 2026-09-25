// Main-process host for the agent runner: token custody (safeStorage) and
// runner lifecycle. This is the only file that couples the Electron shell to
// src/runner/ — the runner itself stays Electron-free.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { startRunner, type RunnerHandle } from '../runner';

const TOKEN_FILE = 'runner-token.bin';

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

// persistToken encrypts with the OS keychain when available; a machine
// without safeStorage (some Linux setups) keeps the token in memory only —
// re-minted by the SPA on next launch, which is acceptable.
function persistToken(token: string): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(tokenPath(), safeStorage.encryptString(token));
  } catch (err) {
    console.error('runner token persist failed:', err);
  }
}

function loadPersistedToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const raw = fs.readFileSync(tokenPath());
    return safeStorage.decryptString(raw);
  } catch {
    return null; // first boot, or the OS key changed
  }
}

// onRunnerToken handles a fresh token from the SPA (over the chat-preload
// bridge): store it and (re)start the runner with it.
export function onRunnerToken(token: string, chatUrl: string): void {
  if (state.token === token && state.handle) return; // same token, running
  state.token = token;
  state.chatUrl = chatUrl;
  persistToken(token);
  void restartRunner();
}

// startFromPersisted boots the runner from a previously stored token so
// agents come online with the app, before the SPA finishes loading.
export function startFromPersisted(chatUrl: string): void {
  const token = loadPersistedToken();
  if (!token) return;
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
// agents must go offline).
export async function stopRunner(): Promise<void> {
  const handle = state.handle;
  state.handle = null;
  state.token = null;
  try {
    fs.rmSync(tokenPath(), { force: true });
  } catch {
    // best-effort
  }
  if (handle) await handle.stop().catch(() => {});
}

// pauseRunner stops execution without discarding the stored token (app quit,
// server change) — next boot resumes from the persisted token.
export async function pauseRunner(): Promise<void> {
  const handle = state.handle;
  state.handle = null;
  if (handle) await handle.stop().catch(() => {});
}

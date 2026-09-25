// Harness detection with the GUI-PATH fix (plan-v2 §6): an Electron app
// launched from Finder/Dock inherits launchd's minimal PATH and will not see
// CLIs installed via a shell-profile-managed prefix (homebrew, nvm, volta,
// bun). We resolve the user's interactive-shell PATH once and search that.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { RunnerHarness, RunnerLogger } from './types';

const execFileP = promisify(execFile);

// Fallback locations probed when the shell PATH itself misses (rare, but a
// broken profile shouldn't blind us completely).
const COMMON_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), 'bin'),
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.codex', 'bin'),
];

let cachedPath: string | null = null;

// loginShellPath asks the user's own shell for its interactive PATH. Cached
// for the process lifetime — spawning a login shell is slow (~100-500ms with
// heavy profiles) and the answer doesn't change under us.
export async function loginShellPath(log: RunnerLogger): Promise<string> {
  if (cachedPath) return cachedPath;
  const fallback = process.env.PATH ?? '';
  if (process.platform === 'win32') {
    cachedPath = fallback;
    return cachedPath;
  }
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    // -i so profile-managed prefixes (nvm, volta) land; -l for login-only
    // profiles. 5s timeout: a hung profile must not hang runner startup.
    const { stdout } = await execFileP(shell, ['-ilc', 'echo -n "$PATH"'], {
      timeout: 5000,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    });
    const resolved = stdout.trim();
    cachedPath = resolved.length > 0 ? resolved : fallback;
  } catch (err) {
    log('login shell PATH probe failed; using process PATH', { error: String(err) });
    cachedPath = fallback;
  }
  // Union with the common dirs so one broken profile can't hide a CLI.
  const parts = new Set(cachedPath.split(path.delimiter).filter(Boolean));
  for (const dir of COMMON_BIN_DIRS) parts.add(dir);
  cachedPath = [...parts].join(path.delimiter);
  return cachedPath;
}

// findExecutable searches the resolved PATH for a binary.
export function findExecutable(name: string, searchPath: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export interface DetectedHarness extends RunnerHarness {
  path: string;
}

// detectHarnesses probes for the CLIs the runner can drive. "Found but not
// working" (--version fails) is reported distinctly from "not installed" —
// the fixes differ (plan-v2 §6).
export async function detectHarnesses(log: RunnerLogger): Promise<DetectedHarness[]> {
  const searchPath = await loginShellPath(log);
  const out: DetectedHarness[] = [];
  for (const name of ['claude', 'codex']) {
    const bin = findExecutable(name, searchPath);
    if (!bin) {
      log(`harness ${name}: not found on PATH`);
      continue;
    }
    try {
      const { stdout } = await execFileP(bin, ['--version'], {
        timeout: 10_000,
        env: { ...process.env, PATH: searchPath },
      });
      out.push({
        name,
        version: stdout.trim().split('\n')[0] ?? '',
        // Auth probing without burning a model call is per-CLI and flaky;
        // report installed as authed and let the first run surface auth
        // errors legibly instead.
        authed: true,
        path: bin,
      });
      log(`harness ${name}: ${bin}`);
    } catch (err) {
      log(`harness ${name}: found at ${bin} but --version failed`, { error: String(err) });
    }
  }
  // Bedrock is an API harness — no local binary. Advertise it when the
  // machine has AWS credentials the SDK's default chain can use, so
  // runner-side Bedrock agents become claimable here. path is empty (unused).
  if (hasAwsCredentials()) {
    out.push({ name: 'bedrock', version: 'converse', authed: true, path: '' });
    log('harness bedrock: AWS credentials detected');
  } else {
    log('harness bedrock: no AWS credentials — not advertised');
  }
  return out;
}

// hasAwsCredentials is a cheap heuristic for "the SDK's default provider
// chain will find credentials": explicit env keys, a named profile, an SSO/
// web-identity token, or a shared credentials/config file. Does NOT validate
// them — the first Converse call surfaces auth errors legibly.
function hasAwsCredentials(): boolean {
  if (
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_PROFILE ||
    process.env.AWS_ROLE_ARN ||
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  ) {
    return true;
  }
  const home = os.homedir();
  return (
    fs.existsSync(path.join(home, '.aws', 'credentials')) ||
    fs.existsSync(path.join(home, '.aws', 'config'))
  );
}

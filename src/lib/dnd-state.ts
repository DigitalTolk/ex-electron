import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// OS Do-Not-Disturb / Focus detection for the main process. The chat SPA asks
// (via the dnd-bridge) before playing its custom notification ping, so the
// ping can go quiet while the OS is on Focus — Slack/Mattermost behavior.
//
// macOS: read the Focus assertions database that donotdisturbd maintains
// (~/Library/DoNotDisturb/DB/Assertions.json). The file holds assertion
// records while a Focus mode is engaged and is absent/empty otherwise. This
// is deliberately NOT the INFocusStatusCenter route (macos-notification-state
// et al.): that API hard-aborts the calling process when the
// com.apple.developer.focus-status entitlement is missing — a crash no
// try/catch can contain in the main process.
//
// Windows: the windows-focus-assist native addon queries the Focus Assist
// WNF state. It is an optionalDependency — it only builds on Windows and is
// lazily imported here so other platforms never load it.
//
// Linux: no portable DnD signal across desktop environments — never DnD.
//
// Every failure path resolves false: an extra ping is the accepted failure
// direction, a silently swallowed alert is not.

type FocusAssistModule = { getFocusAssist: () => { value: number } };

export function assertionsPath(home: string = homedir()): string {
  return join(home, 'Library', 'DoNotDisturb', 'DB', 'Assertions.json');
}

// parseAssertions reports whether the Assertions.json payload records at
// least one engaged Focus assertion. Shape (macOS 12+):
//   { "data": [ { "storeAssertionRecords": [ {…} ] } ] }
export function parseAssertions(raw: string): boolean {
  const parsed = JSON.parse(raw) as { data?: Array<{ storeAssertionRecords?: unknown[] }> };
  if (!Array.isArray(parsed.data)) return false;
  return parsed.data.some((entry) => Array.isArray(entry?.storeAssertionRecords) && entry.storeAssertionRecords.length > 0);
}

// unwrapModule tolerates both CJS-interop shapes a dynamic import can yield.
function unwrapModule(mod: unknown): FocusAssistModule {
  const withDefault = mod as { default?: FocusAssistModule };
  return withDefault.default ?? (mod as FocusAssistModule);
}

export interface DndStateDeps {
  readTextFile?: (path: string) => Promise<string>;
  loadFocusAssist?: () => Promise<unknown>;
}

export async function getDndState(
  platform: NodeJS.Platform = process.platform,
  deps: DndStateDeps = {},
): Promise<boolean> {
  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const loadFocusAssist = deps.loadFocusAssist ?? (() => import('windows-focus-assist'));
  try {
    if (platform === 'darwin') {
      return parseAssertions(await readTextFile(assertionsPath()));
    }
    if (platform === 'win32') {
      const { getFocusAssist } = unwrapModule(await loadFocusAssist());
      // 1 = PRIORITY_ONLY, 2 = ALARMS_ONLY; 0 = off, negative = unsupported
      // or failed — only a positive state means Focus Assist is engaged.
      return getFocusAssist().value > 0;
    }
    return false;
  } catch {
    return false;
  }
}

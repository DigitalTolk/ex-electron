import fs from 'node:fs';
import path from 'node:path';

export interface Settings {
  chatUrl?: string;
  // "Start when ex opens" on the Runners tab: start ex-runner when the app
  // launches. Off unless the person turns it on.
  runnerAutoStart?: boolean;
}

export function loadSettings(file: string): Settings {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Settings;
    return {};
  } catch {
    return {};
  }
}

export function saveSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash between truncate and finish can't leave an
  // empty settings.json (which loadSettings silently treats as "no chat URL"
  // and drops the user back into the setup screen).
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

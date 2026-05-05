import fs from 'node:fs';
import path from 'node:path';

export interface Settings {
  chatUrl?: string;
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
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
}

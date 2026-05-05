import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings, saveSettings } from '../src/lib/settings';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-settings-'));
  file = path.join(dir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadSettings', () => {
  it('returns {} when file is missing', () => {
    expect(loadSettings(file)).toEqual({});
  });

  it('returns {} when file is invalid JSON', () => {
    fs.writeFileSync(file, '{not json');
    expect(loadSettings(file)).toEqual({});
  });

  it('returns {} when file is valid JSON but not an object', () => {
    fs.writeFileSync(file, '"string"');
    expect(loadSettings(file)).toEqual({});
  });

  it('returns the parsed settings', () => {
    fs.writeFileSync(file, JSON.stringify({ chatUrl: 'https://x.com' }));
    expect(loadSettings(file)).toEqual({ chatUrl: 'https://x.com' });
  });
});

describe('saveSettings', () => {
  it('writes JSON to disk', () => {
    saveSettings(file, { chatUrl: 'https://chat.example.com' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      chatUrl: 'https://chat.example.com',
    });
  });

  it('creates parent directories', () => {
    const nested = path.join(dir, 'a/b/c/settings.json');
    saveSettings(nested, { chatUrl: 'https://x.com' });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('round-trips with loadSettings', () => {
    const data = { chatUrl: 'https://chat.example.com' };
    saveSettings(file, data);
    expect(loadSettings(file)).toEqual(data);
  });
});

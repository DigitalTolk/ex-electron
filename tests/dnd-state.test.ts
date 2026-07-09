import { describe, expect, it, vi } from 'vitest';
import { assertionsPath, getDndState, parseAssertions } from '../src/lib/dnd-state';

// Every failure path must resolve false ("not DnD"): an extra notification
// ping is the accepted failure direction, a silently swallowed alert is not.

describe('assertionsPath', () => {
  it('points into the given home directory', () => {
    expect(assertionsPath('/Users/tess')).toBe('/Users/tess/Library/DoNotDisturb/DB/Assertions.json');
  });

  it('defaults to the current user home', () => {
    expect(assertionsPath()).toContain('/Library/DoNotDisturb/DB/Assertions.json');
  });
});

describe('parseAssertions', () => {
  it('reports an engaged Focus assertion', () => {
    const raw = JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionDetails: {} }] }] });
    expect(parseAssertions(raw)).toBe(true);
  });

  it('reports false for an empty record list', () => {
    expect(parseAssertions(JSON.stringify({ data: [{ storeAssertionRecords: [] }] }))).toBe(false);
  });

  it('reports false when records are missing entirely', () => {
    expect(parseAssertions(JSON.stringify({ data: [{}] }))).toBe(false);
    expect(parseAssertions(JSON.stringify({ data: [] }))).toBe(false);
    expect(parseAssertions(JSON.stringify({}))).toBe(false);
  });

  it('finds an engaged assertion in any data entry', () => {
    const raw = JSON.stringify({ data: [{}, { storeAssertionRecords: [{}] }] });
    expect(parseAssertions(raw)).toBe(true);
  });

  it('throws on non-JSON input (the caller maps that to false)', () => {
    expect(() => parseAssertions('not json')).toThrow();
  });
});

describe('getDndState on macOS', () => {
  it('is true while the assertions file records an engaged Focus mode', async () => {
    const readTextFile = vi.fn(async () => JSON.stringify({ data: [{ storeAssertionRecords: [{}] }] }));
    await expect(getDndState('darwin', { readTextFile })).resolves.toBe(true);
    expect(readTextFile).toHaveBeenCalledWith(assertionsPath());
  });

  it('is false with no engaged assertions', async () => {
    const readTextFile = vi.fn(async () => JSON.stringify({ data: [] }));
    await expect(getDndState('darwin', { readTextFile })).resolves.toBe(false);
  });

  it('is false when the file is missing (Focus never engaged)', async () => {
    const readTextFile = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(getDndState('darwin', { readTextFile })).resolves.toBe(false);
  });

  it('is false on unparseable content', async () => {
    const readTextFile = vi.fn(async () => 'corrupt');
    await expect(getDndState('darwin', { readTextFile })).resolves.toBe(false);
  });

  it('resolves a boolean against the real filesystem (default reader)', async () => {
    // Exercises the default readTextFile arm; the machine's actual Focus
    // state is unknown, so only the type is asserted.
    await expect(getDndState('darwin')).resolves.toBeTypeOf('boolean');
  });
});

describe('getDndState on Windows', () => {
  const focusAssistModule = (value: number) => ({ getFocusAssist: () => ({ value }) });

  it('is true for PRIORITY_ONLY and ALARMS_ONLY', async () => {
    await expect(getDndState('win32', { loadFocusAssist: async () => focusAssistModule(1) })).resolves.toBe(true);
    await expect(getDndState('win32', { loadFocusAssist: async () => focusAssistModule(2) })).resolves.toBe(true);
  });

  it('is false when Focus Assist is off, unsupported, or failed', async () => {
    await expect(getDndState('win32', { loadFocusAssist: async () => focusAssistModule(0) })).resolves.toBe(false);
    await expect(getDndState('win32', { loadFocusAssist: async () => focusAssistModule(-1) })).resolves.toBe(false);
    await expect(getDndState('win32', { loadFocusAssist: async () => focusAssistModule(-2) })).resolves.toBe(false);
  });

  it('unwraps a default-interop module shape', async () => {
    await expect(
      getDndState('win32', { loadFocusAssist: async () => ({ default: focusAssistModule(1) }) }),
    ).resolves.toBe(true);
  });

  it('is false when the addon cannot be loaded', async () => {
    await expect(
      getDndState('win32', {
        loadFocusAssist: async () => {
          throw new Error('no prebuilt binary');
        },
      }),
    ).resolves.toBe(false);
  });

  it('is false when the addon throws at query time', async () => {
    await expect(
      getDndState('win32', {
        loadFocusAssist: async () => ({
          getFocusAssist: () => {
            throw new Error('works only on Windows');
          },
        }),
      }),
    ).resolves.toBe(false);
  });

  it('is false with the default loader outside Windows (addon absent here)', async () => {
    // Exercises the default loadFocusAssist arm: on this (non-Windows) dev
    // machine the optionalDependency has no built binary, so the import or
    // the query throws and the catch maps it to false.
    await expect(getDndState('win32')).resolves.toBe(false);
  });
});

describe('getDndState elsewhere', () => {
  it('is false on Linux without touching any probe', async () => {
    const readTextFile = vi.fn();
    const loadFocusAssist = vi.fn();
    await expect(getDndState('linux', { readTextFile, loadFocusAssist })).resolves.toBe(false);
    expect(readTextFile).not.toHaveBeenCalled();
    expect(loadFocusAssist).not.toHaveBeenCalled();
  });

  it('defaults to the current process platform', async () => {
    // On any platform the default path must resolve a boolean, never reject.
    await expect(getDndState()).resolves.toBeTypeOf('boolean');
  });
});

import { describe, expect, it } from 'vitest';
import {
  AT_LOGIN_ARG,
  registerLoginItem,
  setStartAtLogin,
  startsAtLogin,
  type LoginItemApi,
} from '../src/lib/login-item';

const NAME = 'com.digitaltolk.ex.electron';

// Models the Windows Run + StartupApproved keys the way Electron reports them:
// one launch item per Run value pointing at this executable.
function fakeApi(items: { name: string; enabled: boolean }[] = []) {
  const writes: Parameters<LoginItemApi['setLoginItemSettings']>[0][] = [];
  const api: LoginItemApi = {
    getLoginItemSettings: () => ({ launchItems: items.map((item) => ({ ...item })) }),
    setLoginItemSettings: (settings) => {
      writes.push(settings);
      const existing = items.find((item) => item.name === settings.name);
      if (existing) existing.enabled = settings.enabled;
      else items.push({ name: settings.name, enabled: settings.enabled });
    },
  };
  return { api, items, writes };
}

describe('registerLoginItem', () => {
  it('adds a switched-off Run value when none exists', () => {
    const { api, writes } = fakeApi();
    registerLoginItem(api, NAME);
    expect(writes).toEqual([{ openAtLogin: true, args: [AT_LOGIN_ARG], enabled: false, name: NAME }]);
    expect(startsAtLogin(api, NAME)).toBe(false);
  });

  it('leaves an entry the person switched on alone', () => {
    const { api, writes } = fakeApi([{ name: NAME, enabled: true }]);
    registerLoginItem(api, NAME);
    expect(writes).toEqual([]);
    expect(startsAtLogin(api, NAME)).toBe(true);
  });

  it('leaves an entry the person switched off alone', () => {
    const { api, writes } = fakeApi([{ name: NAME, enabled: false }]);
    registerLoginItem(api, NAME);
    expect(writes).toEqual([]);
  });

  it('ignores other Run values for the same executable', () => {
    const { api, writes } = fakeApi([{ name: 'something-else', enabled: true }]);
    registerLoginItem(api, NAME);
    expect(writes).toHaveLength(1);
    expect(startsAtLogin(api, NAME)).toBe(false);
  });
});

describe('setStartAtLogin', () => {
  it('switches the entry on and off without removing it', () => {
    const { api, items } = fakeApi();
    registerLoginItem(api, NAME);
    setStartAtLogin(api, NAME, true);
    expect(startsAtLogin(api, NAME)).toBe(true);
    setStartAtLogin(api, NAME, false);
    expect(startsAtLogin(api, NAME)).toBe(false);
    expect(items).toEqual([{ name: NAME, enabled: false }]);
  });

  it('always writes the at-login argument', () => {
    const { api, writes } = fakeApi();
    setStartAtLogin(api, NAME, true);
    expect(writes[0]).toMatchObject({ openAtLogin: true, args: [AT_LOGIN_ARG] });
  });
});

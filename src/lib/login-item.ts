// Windows has no way to add a program to startup by hand: Settings > Apps >
// Startup and Task Manager's Startup apps only list programs that wrote their
// own Run registry value. So the app registers itself on launch, switched off,
// and the person turns it on there or from the tray. Electron's
// setLoginItemSettings writes the Run value; `enabled` is the StartupApproved
// flag those two screens toggle, so all three stay in agreement.
//
// prebuilt/installer.nsh deletes the value again on uninstall, by the same name.

// Passed by the Run value, so a launch at sign-in can open without taking focus.
export const AT_LOGIN_ARG = '--at-login';

// The slice of Electron's `app` this module drives, so tests can fake it.
export interface LoginItemApi {
  getLoginItemSettings(): { launchItems: { name: string; enabled: boolean }[] };
  setLoginItemSettings(settings: { openAtLogin: boolean; args: string[]; enabled: boolean; name: string }): void;
}

export function registerLoginItem(api: LoginItemApi, name: string): void {
  // An existing value is left alone: its on/off state is the person's choice.
  if (api.getLoginItemSettings().launchItems.some((item) => item.name === name)) return;
  setStartAtLogin(api, name, false);
}

export function startsAtLogin(api: LoginItemApi, name: string): boolean {
  return api.getLoginItemSettings().launchItems.some((item) => item.name === name && item.enabled);
}

// Off keeps the Run value and only flips StartupApproved, so the app stays
// listed under Startup apps for the person to switch back on there.
export function setStartAtLogin(api: LoginItemApi, name: string, on: boolean): void {
  api.setLoginItemSettings({ openAtLogin: true, args: [AT_LOGIN_ARG], enabled: on, name });
}

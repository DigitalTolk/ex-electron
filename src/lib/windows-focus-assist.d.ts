// Minimal typing for the untyped windows-focus-assist native addon
// (optionalDependency; only built and loaded on Windows).
declare module 'windows-focus-assist' {
  export function getFocusAssist(): { value: number; name: string };
  export function isPriority(appUserModelId: string): { value: number; name: string };
}

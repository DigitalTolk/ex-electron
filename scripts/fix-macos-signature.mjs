// Re-sign the local dev Electron.app so macOS will deliver notifications.
//
// The Electron build npm downloads is only "linker-signed": its Info.plist is
// not bound and its resources are not sealed, so `codesign --verify` fails.
// macOS refuses to register a bundle with an invalid signature for user
// notifications, and the failure is SILENT in the worst possible way — the
// renderer reports Notification.permission "granted" (so app code happily
// constructs notifications, marks them delivered and records dedup entries)
// while the OS discards every one. Nothing appears, and the app never shows up
// under System Settings → Notifications, so there is nothing to switch on.
//
// An ad-hoc re-sign seals the bundle and binds the plist, which is enough for
// macOS to accept it. Verified 2026-08-21: before, a main-process notification
// failed with `UNErrorDomain error 1`; after, the OS reported it shown.
//
// Runs on `postinstall` because npm install replaces the bundle and silently
// undoes this. No-op off macOS and idempotent, so re-running is harmless.
//
// SIDE EFFECT — keychain prompt. Re-signing changes the bundle's code identity,
// and macOS keychain ACLs are bound to the identity that created an item. The
// first launch after a re-sign therefore prompts for the login keychain
// ("Electron wants to use your confidential information stored in
// '<profile> Safe Storage'"). Click "Always Allow" once. Ad-hoc signing is
// deterministic for byte-identical input, so reinstalling the SAME Electron
// version reproduces the same hash and does not re-prompt; upgrading Electron
// prompts once more. The item holds only the agent-runner token, which
// runner-host.ts already re-mints when it can't be decrypted, so deleting it
// (`security delete-generic-password -s "<profile> Safe Storage"`) is a safe
// way to clear the prompt for good.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(here, '..', 'node_modules', 'electron', 'dist', 'Electron.app');

if (process.platform !== 'darwin') process.exit(0);
if (!existsSync(appPath)) {
  // Electron not installed yet (or a pruned production install) — nothing to do.
  process.exit(0);
}

const valid = () => {
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

if (valid()) {
  console.log('[fix-macos-signature] Electron.app signature already valid — skipping.');
  process.exit(0);
}

try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
} catch (err) {
  // Never fail the install over this: the app still runs, it just can't show
  // desktop notifications. Say so loudly enough to be actionable.
  console.warn(
    `[fix-macos-signature] Could not re-sign Electron.app — desktop notifications will not appear in dev.\n` +
      `  ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(0);
}

console.log(
  valid()
    ? '[fix-macos-signature] Re-signed Electron.app — macOS will now deliver dev notifications (restart the app).'
    : '[fix-macos-signature] Re-signed Electron.app but verification still fails — notifications may not appear.',
);

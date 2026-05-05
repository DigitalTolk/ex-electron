// Wraps electron-builder so the binary's version always reflects git state.
// Pass-through any extra args, e.g. `tsx scripts/build-app.ts --mac --arm64`.
import { spawnSync } from 'node:child_process';
import { deriveVersion } from './derive-version';

const root = process.cwd();
const version = deriveVersion(root);

console.log(`building electron app: version=${version}`);

const args = [
  '--config.extraMetadata.version=' + version,
  ...process.argv.slice(2),
];

const result = spawnSync('electron-builder', args, {
  stdio: 'inherit',
  cwd: root,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);

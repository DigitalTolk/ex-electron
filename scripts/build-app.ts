// Wraps electron-builder so the binary's version always reflects git state.
// Pass-through any extra args, e.g. `tsx scripts/build-app.ts --mac --arm64`.
import { spawnSync } from 'node:child_process';
import { deriveVersion } from './derive-version';

const root = process.cwd();
const version = deriveVersion(root);

console.log(`building electron app: version=${version}`);

// On tag pushes electron-builder otherwise auto-publishes to GitHub Releases
// when GH_TOKEN is set, which collides with the dedicated release workflow
// step (softprops/action-gh-release). Default to --publish never so this
// wrapper only ever produces local artifacts; callers that explicitly pass
// --publish keep their override.
const userArgs = process.argv.slice(2);
const hasPublish = userArgs.some((a) => a === '--publish' || a.startsWith('--publish='));
const args = [
  '--config.extraMetadata.version=' + version,
  ...(hasPublish ? [] : ['--publish', 'never']),
  ...userArgs,
];

const result = spawnSync('electron-builder', args, {
  stdio: 'inherit',
  cwd: root,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);

// Mac App Store build. Materialises the per-team signing inputs the store
// target needs (the sandbox entitlements carry the team id, the provisioning
// profile comes from a secret), then runs the normal packager wrapper with
// the `mas` target. Required environment:
//   APPLE_TEAM_ID                     ten-character team id
//   MAS_PROVISIONING_PROFILE_BASE64   Mac App Store provisioning profile
//   CSC_LINK / CSC_KEY_PASSWORD       Mac App Distribution certificate (.p12)
//   CSC_INSTALLER_LINK / CSC_INSTALLER_KEY_PASSWORD   Mac Installer Distribution
// Optional: MAS_BUILD_NUMBER for CFBundleVersion (defaults to a timestamp).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'prebuilt', 'mas');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`build-mas: ${name} is not set`);
    process.exit(1);
  }
  return value;
}

const teamId = required('APPLE_TEAM_ID');
const profile = required('MAS_PROVISIONING_PROFILE_BASE64');
const buildNumber = process.env.MAS_BUILD_NUMBER ?? new Date().toISOString().replace(/\D/g, '').slice(0, 14);

fs.mkdirSync(outDir, { recursive: true });
const template = fs.readFileSync(path.join(root, 'prebuilt', 'entitlements.mas.plist'), 'utf8');
fs.writeFileSync(path.join(outDir, 'entitlements.mas.plist'), template.replaceAll('TEAMID', teamId));
fs.writeFileSync(path.join(outDir, 'embedded.provisionprofile'), Buffer.from(profile, 'base64'));

const result = spawnSync(
  'tsx',
  [
    path.join('scripts', 'build-app.ts'),
    '--mac',
    'mas',
    '--arm64',
    `--config.buildVersion=${buildNumber}`,
    `--config.mas.extendInfo.ElectronTeamID=${teamId}`,
  ],
  { stdio: 'inherit', cwd: root },
);
process.exit(result.status ?? 1);

// Resolves the version that electron-builder should stamp on a build, based
// on git state. Tag pushes (vN.N.N) produce a clean N.N.N. Other commits
// produce N.N.N-dev.<count>.<sha> so artifacts never collide.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function tryGit(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function deriveVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

  const exact = tryGit(['describe', '--exact-match', '--tags', '--match', 'v*', 'HEAD']);
  if (exact) return exact.replace(/^v/, '');

  const desc = tryGit(['describe', '--tags', '--match', 'v*', '--always', '--dirty']);
  if (desc) {
    const tagged = /^v?(\d+\.\d+\.\d+)(?:-(\d+)-g([0-9a-f]+))?(-dirty)?$/.exec(desc);
    if (tagged) {
      const [, base, ahead, sha, dirty] = tagged;
      if (!ahead && !dirty) return base;
      const parts: string[] = [];
      if (ahead) parts.push(`dev.${ahead}`);
      if (sha) parts.push(sha);
      if (dirty) parts.push('dirty');
      return `${base}-${parts.join('.')}`;
    }
    // No matching tag yet — describe falls back to <sha>[-dirty]. Hang the dev
    // suffix off package.json so semver stays valid.
    const fallback = /^([0-9a-f]+)(-dirty)?$/.exec(desc);
    if (fallback) {
      const [, sha, dirty] = fallback;
      const parts = ['dev', sha];
      if (dirty) parts.push('dirty');
      return `${pkg.version}-${parts.join('.')}`;
    }
  }

  return pkg.version;
}

if (process.argv[1]?.endsWith('derive-version.ts')) {
  process.stdout.write(deriveVersion(process.cwd()));
}

// Bundles each entrypoint with esbuild. Renderer code (setup.ts) needs to be
// bundled because the chat partition has sandbox=true and `require` is not
// available; preload + main are bundled too for consistency. Type-checking
// happens separately via `tsc --noEmit`.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'dist');

async function run(): Promise<void> {
  // Main + preloads run in Electron's Node-side processes; Electron 42 ships
  // Node 22, so target that for accurate language-feature emit.
  await build({
    entryPoints: {
      main: path.join(root, 'src/main.ts'),
      preload: path.join(root, 'src/preload.ts'),
      'chat-preload': path.join(root, 'src/chat-preload.ts'),
    },
    outdir: out,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    external: ['electron'],
    logLevel: 'info',
  });

  // The setup screen is a sandboxed renderer with no Node globals available;
  // build it as a browser bundle so any accidental Node-only import is a
  // build-time error instead of a runtime ReferenceError. Electron 42 ships
  // Chromium 136 — chrome130 leaves us conservative headroom.
  await build({
    entryPoints: {
      'setup/setup': path.join(root, 'src/setup/setup.ts'),
    },
    outdir: out,
    bundle: true,
    platform: 'browser',
    target: 'chrome130',
    format: 'iife',
    sourcemap: false,
    logLevel: 'info',
  });

  await mkdir(path.join(out, 'setup'), { recursive: true });
  await copyFile(
    path.join(root, 'src/setup/setup.html'),
    path.join(out, 'setup/setup.html'),
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

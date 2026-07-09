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
  // Main + preloads run in Electron's Node-side processes; Electron 41/42
  // both ship Node 24, so target that for accurate language-feature emit.
  await build({
    entryPoints: {
      main: path.join(root, 'src/main.ts'),
      preload: path.join(root, 'src/preload.ts'),
      'chat-preload': path.join(root, 'src/chat-preload.ts'),
    },
    outdir: out,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: false,
    // windows-focus-assist is a native addon (optionalDependency, built only
    // on Windows) — it must stay a runtime require, resolved from the
    // packaged node_modules, not be inlined into the bundle.
    external: ['electron', 'windows-focus-assist'],
    logLevel: 'info',
  });

  // The setup screen is a sandboxed renderer with no Node globals available;
  // build it as a browser bundle so any accidental Node-only import is a
  // build-time error instead of a runtime ReferenceError. Electron 41 ships
  // Chromium 146; target that as the floor so esbuild emits native syntax
  // for everything that release supports.
  await build({
    entryPoints: {
      'setup/setup': path.join(root, 'src/setup/setup.ts'),
    },
    outdir: out,
    bundle: true,
    platform: 'browser',
    target: 'chrome146',
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

// Generates icon assets from the canonical sources in assets/.
//
// macOS: compiles assets/ex.icon (Icon Composer document) into Assets.car
//   via actool. Apple's runtime reads CFBundleIconName from Info.plist and
//   pulls the correctly-themed icon (Aqua / DarkAqua / Tinted / Clear /
//   liquid-glass) out of Assets.car at the bundle level — so Finder, Dock,
//   Launchpad all switch with system appearance and material. Also renders
//   a static icon.icns (via ictool → iconutil) as a fallback for older
//   tooling, plus icon-mac-light/dark.png for the running app's dock-icon
//   swap. The .icon directory is bundled too. When Xcode tools are missing
//   (Linux/Windows CI) the script gracefully skips the Mac-only outputs.
// Linux: chat-icon.svg → icon.png (1024).
// Windows: chat-icon.svg → icon.ico (multi-res).
// Tray: assets/tray-template.svg → tray.png (color, used on Linux/Windows)
//   and trayTemplate.png (template image, used on macOS).
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const ROOT = process.cwd();
const ASSETS = path.join(ROOT, 'assets');
// Output directory for committed pre-built artifacts (icons, Assets.car).
// Tracked in git — `build/` is reserved for transient compiled output.
const BUILD = path.join(ROOT, 'prebuilt');

// Resolve Icon Composer's CLI (`ictool`) via the active Xcode. Hardcoding
// /Applications/Xcode.app fails on GitHub Actions macos runners where the
// active Xcode lives at /Applications/Xcode_26.x.app and the unversioned
// symlink may not exist. Using `xcode-select -p` follows whatever the runner
// has selected.
let ictoolPathCache: string | null | undefined;
function findIctool(): string | null {
  if (ictoolPathCache !== undefined) return ictoolPathCache;
  try {
    const developer = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
    // Xcode.app/Contents/Developer → Xcode.app/Contents/Applications/Icon Composer.app
    const xcodeAppContents = path.dirname(developer);
    const candidate = path.join(
      xcodeAppContents,
      'Applications/Icon Composer.app/Contents/Executables/ictool',
    );
    execFileSync('test', ['-x', candidate], { stdio: 'ignore' });
    ictoolPathCache = candidate;
    return candidate;
  } catch {
    ictoolPathCache = null;
    return null;
  }
}

interface IconJson {
  fill: { 'automatic-gradient'?: string };
  groups: Array<{ shadow?: { kind?: string; opacity?: number } }>;
}

function parseExtendedSrgb(value: string): { r: number; g: number; b: number } {
  const m = /^extended-srgb:([\d.]+),([\d.]+),([\d.]+)/.exec(value);
  if (!m) return { r: 0, g: 0x88, b: 0xff };
  return {
    r: Math.round(parseFloat(m[1]) * 255),
    g: Math.round(parseFloat(m[2]) * 255),
    b: Math.round(parseFloat(m[3]) * 255),
  };
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

// Apple's automatic-gradient renders the base color toward the top and a
// lighter shade toward the bottom. We approximate by lightening the base by
// ~35% for the bottom stop.
function lighten(c: { r: number; g: number; b: number }, amount: number): { r: number; g: number; b: number } {
  return {
    r: Math.round(c.r + (255 - c.r) * amount),
    g: Math.round(c.g + (255 - c.g) * amount),
    b: Math.round(c.b + (255 - c.b) * amount),
  };
}

async function renderSvg(svg: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil(size / 2)) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function ictoolAvailable(): Promise<boolean> {
  return findIctool() !== null;
}

async function renderWithIctool(rendition: 'Default' | 'Dark', size: number): Promise<Buffer> {
  const ictool = findIctool();
  if (!ictool) throw new Error('ictool not found — Xcode 26+ Icon Composer is required');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ex-ictool-'));
  const out = path.join(tmp, 'icon.png');
  try {
    execFileSync(
      ictool,
      [
        path.join(ASSETS, 'ex.icon'),
        '--export-image',
        '--output-file', out,
        '--platform', 'macOS',
        '--rendition', rendition,
        '--width', String(size),
        '--height', String(size),
        '--scale', '1',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    return await fs.readFile(out);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function manualMacIconPng(): Promise<Buffer> {
  const iconJsonPath = path.join(ASSETS, 'ex.icon/icon.json');
  const iconJson = JSON.parse(await fs.readFile(iconJsonPath, 'utf8')) as IconJson;
  const baseColor = parseExtendedSrgb(iconJson.fill['automatic-gradient'] ?? '');
  const topHex = rgbToHex(baseColor);
  const bottomHex = rgbToHex(lighten(baseColor, 0.35));

  const accent = await fs.readFile(path.join(ASSETS, 'ex.icon/Assets/04-dot-accent.svg'), 'utf8');
  const dots = await fs.readFile(path.join(ASSETS, 'ex.icon/Assets/03-dots-dark.svg'), 'utf8');
  const bubble = await fs.readFile(path.join(ASSETS, 'ex.icon/Assets/01-bubble-fill.svg'), 'utf8');

  // 22.37% of the side length is Apple's macOS squircle radius.
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${topHex}"/>
        <stop offset="1" stop-color="${bottomHex}"/>
      </linearGradient>
      <clipPath id="c"><rect width="1024" height="1024" rx="229" ry="229"/></clipPath>
    </defs>
    <g clip-path="url(#c)">
      <rect width="1024" height="1024" fill="url(#g)"/>
    </g>
  </svg>`;

  const inset = 832;
  const offset = Math.floor((1024 - inset) / 2);

  const [bgPng, bubblePng, dotsPng, accentPng] = await Promise.all([
    renderSvg(bg, 1024),
    renderSvg(bubble, inset),
    renderSvg(dots, inset),
    renderSvg(accent, inset),
  ]);

  return sharp(bgPng)
    .composite([
      { input: bubblePng, top: offset, left: offset },
      { input: dotsPng, top: offset, left: offset },
      { input: accentPng, top: offset, left: offset },
    ])
    .png()
    .toBuffer();
}

async function makeMacIconPng(): Promise<Buffer> {
  if (await ictoolAvailable()) {
    console.log('rendered macOS icon via Xcode ictool');
    return renderWithIctool('Default', 1024);
  }
  console.log('rendering macOS icon via manual composite (ictool unavailable)');
  return manualMacIconPng();
}

// Compiles assets/ex.icon (Icon Composer document) into Assets.car via actool.
// macOS reads CFBundleIconName from Info.plist and pulls the AppIcon entry
// out of Assets.car at the bundle level; on Tahoe (macOS 26+) IconKit reads
// the layered IconGroup and renders dynamically — Aqua / DarkAqua / Tinted /
// Clear glass — based on system appearance.
//
// Note: visible dark vs light differentiation comes from the .icon source
// itself. Our icon.json has a single group with `automatic-gradient`, so
// IconKit applies appearance-aware tinting but the visual delta is subtle.
// To make dark mode obviously distinct, edit ex.icon in Icon Composer and add
// a dark-mode group; that produces NSAppearanceNameDarkAqua-tagged renditions
// which will switch hard.
async function makeAssetsCar(): Promise<void> {
  try {
    execFileSync('xcrun', ['--find', 'actool'], { stdio: 'ignore' });
  } catch {
    console.log('actool not available — skipping Assets.car (Linux/Windows CI is fine)');
    return;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ex-actool-'));
  // Asset name in the catalog comes from the .icon directory name, so stage
  // the user's ex.icon under "AppIcon.icon" to match CFBundleIconName=AppIcon.
  const stagedIcon = path.join(tmp, 'AppIcon.icon');
  const outDir = path.join(tmp, 'out');
  const partialPlist = path.join(tmp, 'partial.plist');
  await fs.cp(path.join(ASSETS, 'ex.icon'), stagedIcon, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  try {
    execFileSync(
      'xcrun',
      [
        'actool',
        stagedIcon,
        '--compile', outDir,
        '--output-format', 'human-readable-text',
        '--notices', '--warnings',
        '--output-partial-info-plist', partialPlist,
        '--enable-on-demand-resources', 'NO',
        '--target-device', 'mac',
        '--minimum-deployment-target', '26.0',
        '--platform', 'macosx',
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const car = path.join(outDir, 'Assets.car');
    await fs.access(car);
    await fs.copyFile(car, path.join(BUILD, 'Assets.car'));
    console.log('compiled ex.icon → prebuilt/Assets.car');
  } catch (err) {
    console.warn('actool failed to compile ex.icon → Assets.car:', err);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function makeIcns(masterPng: Buffer): Promise<string | null> {
  // iconutil only exists on macOS. When building installers on Linux/Windows
  // (e.g. for cross-platform CI), we fall back to icon.png and electron-builder
  // skips .icns generation.
  try {
    execFileSync('which', ['iconutil'], { stdio: 'ignore' });
  } catch {
    return null;
  }

  const iconset = await fs.mkdtemp(path.join(os.tmpdir(), 'ex-iconset-'));
  const dir = path.join(iconset, 'icon.iconset');
  await fs.mkdir(dir, { recursive: true });

  const sizes = [
    { name: 'icon_16x16.png', size: 16 },
    { name: 'icon_16x16@2x.png', size: 32 },
    { name: 'icon_32x32.png', size: 32 },
    { name: 'icon_32x32@2x.png', size: 64 },
    { name: 'icon_128x128.png', size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png', size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png', size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 },
  ];

  await Promise.all(
    sizes.map(({ name, size }) =>
      sharp(masterPng).resize(size, size).png().toFile(path.join(dir, name)),
    ),
  );

  const out = path.join(BUILD, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', dir, '-o', out], { stdio: 'inherit' });
  await fs.rm(iconset, { recursive: true, force: true });
  return out;
}

async function makeChatPng(): Promise<void> {
  const svg = await fs.readFile(path.join(ASSETS, 'chat-icon.svg'));
  const png = await sharp(svg, { density: 512 }).resize(1024, 1024).png().toBuffer();
  await fs.writeFile(path.join(BUILD, 'icon.png'), png);
}

async function makeChatIco(): Promise<void> {
  const svg = await fs.readFile(path.join(ASSETS, 'chat-icon.svg'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = await Promise.all(
    sizes.map((s) => sharp(svg, { density: 512 }).resize(s, s).png().toBuffer()),
  );
  const ico = await pngToIco(buffers);
  await fs.writeFile(path.join(BUILD, 'icon.ico'), ico);
}

// Pink unread-badge dot drawn on top of the chat-bubble glyph at bottom-right.
// Anchored on the original 64×64 viewBox so all renders end up identically
// composed regardless of output size.
const BADGE_DOT_SVG = `<circle cx="50" cy="50" r="11" fill="#DE5D83"/>`;

function trayWithBadge(glyphHex: string): string {
  // Re-emit the tray-template glyph with the requested stroke/fill colour and
  // the pink badge dot composited on top in a single SVG so sharp rasterises
  // it as one image (avoids edge artifacts at small sizes).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
    <path d="M12 12 H52 A6 6 0 0 1 58 18 V40 A6 6 0 0 1 52 46 H28 L18 56 V46 H12 A6 6 0 0 1 6 40 V18 A6 6 0 0 1 12 12 Z"
          fill="none" stroke="${glyphHex}" stroke-width="3"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="20" cy="29" r="3" fill="${glyphHex}"/>
    <circle cx="32" cy="29" r="3" fill="${glyphHex}"/>
    <circle cx="44" cy="29" r="3" fill="${glyphHex}"/>
    ${BADGE_DOT_SVG}
  </svg>`;
}

async function rasterTray(svg: string | Buffer, name: string): Promise<void> {
  const input = typeof svg === 'string' ? Buffer.from(svg) : svg;
  await sharp(input, { density: 512 }).resize(22, 22).png().toFile(path.join(BUILD, `${name}.png`));
  await sharp(input, { density: 512 }).resize(44, 44).png().toFile(path.join(BUILD, `${name}@2x.png`));
}

async function makeTray(): Promise<void> {
  const tpl = await fs.readFile(path.join(ASSETS, 'tray-template.svg'));

  // No-badge variants. macOS uses trayTemplate.png with isTemplate=true so the
  // menu bar re-tints it for light/dark; Linux/Windows use the same black
  // glyph rendered as a regular image (those tray backgrounds are typically
  // the same regardless of system appearance).
  await rasterTray(tpl, 'tray');
  await rasterTray(tpl, 'trayTemplate');

  // Badged variants. Once the badge dot is in the image we can't keep using
  // a template (template images get re-tinted entirely, which would erase
  // the pink), so we ship one variant per appearance and main.ts swaps them
  // on nativeTheme changes.
  await rasterTray(trayWithBadge('#000000'), 'trayBadgedLight');
  await rasterTray(trayWithBadge('#FFFFFF'), 'trayBadgedDark');
  // Linux/Windows: black glyph + pink dot — paints fine over either tray bg.
  await rasterTray(trayWithBadge('#000000'), 'trayBadged');
}

function probeXcodeToolchain(): { ictool: string | null; actool: boolean; iconutil: boolean } {
  const ictool = findIctool();
  let actool = false;
  let iconutil = false;
  try {
    execFileSync('xcrun', ['--find', 'actool'], { stdio: 'ignore' });
    actool = true;
  } catch { /* missing */ }
  try {
    execFileSync('which', ['iconutil'], { stdio: 'ignore' });
    iconutil = true;
  } catch { /* missing */ }
  return { ictool, actool, iconutil };
}

async function main(): Promise<void> {
  await fs.mkdir(BUILD, { recursive: true });

  // On macOS, the Mac icon pipeline absolutely requires Xcode's Icon Composer
  // and actool. If they're missing, fall through to the manual sharp fallback
  // would silently ship a wrong-looking app icon — exactly the local-vs-CI
  // drift this is meant to prevent. Fail loudly instead so the runner config
  // gets fixed.
  if (process.platform === 'darwin') {
    const tools = probeXcodeToolchain();
    let xcodePath: string | null = null;
    try {
      xcodePath = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
    } catch { /* missing */ }
    console.log('[icons] xcode-select:', xcodePath ?? '(none)');
    console.log('[icons] ictool:      ', tools.ictool ?? '(missing)');
    console.log('[icons] actool:      ', tools.actool ? 'available' : '(missing)');
    console.log('[icons] iconutil:    ', tools.iconutil ? 'available' : '(missing)');
    if (!tools.ictool || !tools.actool || !tools.iconutil) {
      throw new Error(
        'Xcode toolchain incomplete on this macOS host. Need ictool (Icon ' +
        'Composer), actool, and iconutil. Run `sudo xcode-select -s ' +
        '/Applications/Xcode_<26+>.app/Contents/Developer` and re-run.',
      );
    }
  }

  const macPng = await makeMacIconPng();
  const icns = await makeIcns(macPng);
  if (!icns && process.platform !== 'darwin') {
    console.warn('iconutil not available — .icns will be skipped (Linux/Windows CI is fine).');
  }

  await makeAssetsCar();
  await makeChatPng();
  await makeChatIco();
  await makeTray();

  console.log('Icons written to', BUILD);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

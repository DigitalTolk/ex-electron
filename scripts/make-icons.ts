// Generates icon assets from the canonical sources in assets/.
//
// macOS: composes the layered ex.icon (gradient background + bubble + dots +
//   accent) into a 1024×1024 PNG, then runs iconutil to produce icon.icns.
//   The .icon directory itself is also copied verbatim into the app bundle so
//   tooling that understands macOS 26's IconKit format can pick it up.
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
const BUILD = path.join(ROOT, 'build');

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

async function makeMacIconPng(): Promise<Buffer> {
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

  // Layers were authored on a 64×64 viewBox. Inset to 81% so the bubble sits
  // comfortably inside the squircle, matching what Icon Composer produces.
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

async function makeTray(): Promise<void> {
  const tpl = await fs.readFile(path.join(ASSETS, 'tray-template.svg'));

  // Color tray (Linux + Windows). The template SVG uses pure black; on those
  // OSes the menu bar / system tray paints arbitrary backgrounds so a black
  // glyph reads fine without recoloring.
  await sharp(tpl, { density: 512 }).resize(22, 22).png().toFile(path.join(BUILD, 'tray.png'));
  await sharp(tpl, { density: 512 }).resize(44, 44).png().toFile(path.join(BUILD, 'tray@2x.png'));

  // Template tray (macOS): same glyph, same black fill — Tray.setTemplateImage
  // re-tints it for light/dark menu bars at runtime.
  await sharp(tpl, { density: 512 }).resize(22, 22).png().toFile(path.join(BUILD, 'trayTemplate.png'));
  await sharp(tpl, { density: 512 }).resize(44, 44).png().toFile(path.join(BUILD, 'trayTemplate@2x.png'));
}

async function main(): Promise<void> {
  await fs.mkdir(BUILD, { recursive: true });

  const macPng = await makeMacIconPng();
  await fs.writeFile(path.join(BUILD, 'icon-mac-1024.png'), macPng);
  const icns = await makeIcns(macPng);
  if (!icns) {
    console.warn('iconutil not available — wrote icon-mac-1024.png; .icns will be skipped.');
  }

  await makeChatPng();
  await makeChatIco();
  await makeTray();

  console.log('Icons written to', BUILD);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

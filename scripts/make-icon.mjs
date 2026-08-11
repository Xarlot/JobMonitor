/**
 * Rasterizes the SVG sources into the PNGs Electron and electron-builder need.
 *
 * There are **two** sources, and that is the point rather than duplication:
 *
 *   build/icon.svg  the app icon — a dark rounded tile with the mark inside it. Correct anywhere the
 *                   icon appears in a frame of its own: an installer, a taskbar, a notification, the
 *                   About dialog.
 *   build/tray.svg  the mark alone, on transparency. Correct in the system tray, which draws it *on*
 *                   the panel — where the tile reads as a sticker on a light panel, nearly vanishes
 *                   on a dark one, and at 16px leaves the mark about ten pixels to be legible in.
 *
 * Outputs:
 *   build/icon.png        512×512  → electron-builder derives .ico / .icns from it
 *   electron/appicon.png  256×256  → window, notifications, About; packed with the app
 *   electron/tray.png      32×32   → the tray
 *   electron/tray@2x.png   64×64   → the tray on a HiDPI panel. `nativeImage.createFromPath` picks
 *                                    this up by name; without it the icon is resampled and soft.
 *
 * Run via `npm run icons` (invoked by the electron:* scripts and CI).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

function render(svg, size, outRel) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  const out = resolve(root, outRel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`wrote ${outRel} (${size}px)`);
}

const appIcon = read('build/icon.svg');
const trayIcon = read('build/tray.svg');

render(appIcon, 512, 'build/icon.png');
render(appIcon, 256, 'electron/appicon.png');
render(trayIcon, 32, 'electron/tray.png');
render(trayIcon, 64, 'electron/tray@2x.png');

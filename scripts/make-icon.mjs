/**
 * Rasterizes build/icon.svg into the PNGs electron-builder needs:
 *  - build/icon.png   (512×512) → electron-builder derives .ico / .icns from it
 *  - electron/tray.png (32×32)  → tray + window icon, packed with the app
 *
 * Run via `npm run icons` (invoked by the electron:* scripts and CI).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(root, 'build/icon.svg'), 'utf8');

function render(size, outRel) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  const out = resolve(root, outRel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`wrote ${outRel} (${size}px)`);
}

render(512, 'build/icon.png');
render(32, 'electron/tray.png');

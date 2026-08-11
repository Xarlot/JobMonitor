/**
 * The tray icon and the app icon are different images, used in different places.
 *
 * They were one file, and the tray is where that showed: an app icon is a tile — a dark rounded
 * square with the mark inside — and a tray icon is drawn *on* the panel, so the tile read as a
 * sticker on a light panel, all but vanished on a dark one, and at 16px left the mark about ten
 * pixels to be legible in.
 *
 * Nothing catches that class of fault. It typechecks, it builds, the file exists and loads, and the
 * only symptom is what a panel looks like — which no test in this suite can see. So this asserts the
 * two properties that actually went wrong, both of which are readable as text:
 *
 *   1. the tray source carries no background shape, and
 *   2. each icon is wired to the role it belongs to in `main.cjs`.
 *
 * Pixels are deliberately not asserted. There is no PNG decoder in this environment, and a previous
 * attempt to read one by hand got the answer wrong by not reversing the row filters — concluding an
 * icon was broken when it was fine. Reading the IHDR header for dimensions is safe, since that is
 * fixed-offset and uncompressed; anything past it is not worth guessing at.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** Width and height out of the IHDR chunk, which is always the first and at a fixed offset. */
function pngSize(rel: string): { width: number; height: number } {
  const buf = readFileSync(join(root, rel));
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('the tray icon', () => {
  it('has no background shape, unlike the app icon', () => {
    const tray = read('build/tray.svg');
    const app = read('build/icon.svg');

    // The tile in the app icon is a `<rect>` with a fill. Its absence from the tray source is the
    // whole fix: whatever is behind the icon has to be the panel.
    expect(app).toMatch(/<rect[^>]*fill=/);
    expect(tray).not.toMatch(/<rect/);
    expect(tray).not.toMatch(/<circle/);

    // And nothing else may paint a ground either — every shape in it is stroked, not filled.
    for (const [, path] of tray.matchAll(/<path\b([^>]*)>/g)) {
      expect(path).toMatch(/fill="none"/);
    }
  });

  it('is rendered at both scales, from the tray source', () => {
    const script = read('scripts/make-icon.mjs');
    expect(script).toMatch(/render\(trayIcon, 32, 'electron\/tray\.png'\)/);
    // Without the @2x representation the panel resamples a 32px image and the mark goes soft.
    expect(script).toMatch(/render\(trayIcon, 64, 'electron\/tray@2x\.png'\)/);
    expect(script).toMatch(/render\(appIcon, 256, 'electron\/appicon\.png'\)/);
  });

  it('is used for the tray, and the app icon everywhere with a frame of its own', () => {
    const main = read('electron/main.cjs');

    // One use of the tray icon, and it is the Tray. A bare mark in a notification or a taskbar reads
    // as a missing icon rather than as a minimal one, which is the mistake in the other direction.
    const trayUses = [...main.matchAll(/^(?!\s*(?:\*|\/\/)).*\bTRAY_ICON\b.*$/gm)].map((m) =>
      m[0].trim(),
    );
    expect(trayUses).toEqual([
      "const TRAY_ICON = path.join(__dirname, 'tray.png');",
      'const image = nativeImage.createFromPath(TRAY_ICON);',
    ]);

    // The window, the About dialog and notifications all take the tile.
    expect(main).toMatch(/icon: fs\.existsSync\(APP_ICON\) \? APP_ICON : undefined/);
    expect(main).toMatch(/icon: nativeImage\.createFromPath\(APP_ICON\)/);
    expect(main).toMatch(/new Notification\(\{ title, body, icon: APP_ICON \}\)/);
  });

  /*
   * Generated files, so absent on a fresh clone until `npm run icons` — which the electron:* scripts
   * and CI both run. Skipped rather than failed in that case: this file's job is the wiring above,
   * and a red test on a clean checkout would train people to ignore it.
   */
  const generated = ['electron/tray.png', 'electron/tray@2x.png', 'electron/appicon.png'];
  it.skipIf(generated.some((f) => !existsSync(join(root, f))))(
    'produces the sizes it claims to',
    () => {
      expect(pngSize('electron/tray.png')).toEqual({ width: 32, height: 32 });
      expect(pngSize('electron/tray@2x.png')).toEqual({ width: 64, height: 64 });
      expect(pngSize('electron/appicon.png')).toEqual({ width: 256, height: 256 });
    },
  );
});

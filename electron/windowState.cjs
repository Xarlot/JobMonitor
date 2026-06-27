'use strict';

/**
 * Window position/size persistence with off-screen protection.
 *
 * The geometry helpers are pure (display list in, bounds out) so the "is the
 * restored window actually visible?" logic can be unit-tested without a GUI.
 * Only `load`/`save` touch the filesystem.
 */

const fs = require('node:fs');

const DEFAULTS = { width: 1200, height: 820 };
const MIN_W = 720;
const MIN_H = 480;
// A restored window must expose at least this much of itself on some display,
// otherwise it would be unreachable (e.g. a monitor was unplugged).
const MIN_VISIBLE_W = 200;
const MIN_VISIBLE_H = 100;

function load(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

function save(file, state) {
  try {
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    /* non-fatal */
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** True if `bounds` overlaps some display's work area by a grabbable margin. */
function isVisibleOn(bounds, displays) {
  return displays.some((d) => {
    const wa = d.workArea;
    const visW = Math.min(bounds.x + bounds.width, wa.x + wa.width) - Math.max(bounds.x, wa.x);
    const visH = Math.min(bounds.y + bounds.height, wa.y + wa.height) - Math.max(bounds.y, wa.y);
    return visW >= MIN_VISIBLE_W && visH >= MIN_VISIBLE_H;
  });
}

/**
 * Resolve the BrowserWindow bounds to open with, validated against the *current*
 * displays. Size is clamped to the largest available work area; position is kept
 * only if the resulting rectangle is visible — otherwise x/y are omitted so the
 * caller (Electron) centers the window on the primary display.
 */
function computeBounds(saved, displays) {
  const maxW = Math.max(...displays.map((d) => d.workArea.width));
  const maxH = Math.max(...displays.map((d) => d.workArea.height));
  const width = clamp(Number(saved?.width) || DEFAULTS.width, MIN_W, maxW);
  const height = clamp(Number(saved?.height) || DEFAULTS.height, MIN_H, maxH);

  const out = { width, height, isMaximized: Boolean(saved?.isMaximized) };
  if (
    saved &&
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    isVisibleOn({ x: saved.x, y: saved.y, width, height }, displays)
  ) {
    out.x = saved.x;
    out.y = saved.y;
  }
  return out;
}

module.exports = { load, save, computeBounds, isVisibleOn, DEFAULTS, MIN_W, MIN_H };

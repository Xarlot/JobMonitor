import { describe, expect, it } from 'vitest';
import ws from '../../electron/windowState.cjs';

// Simulated displays (work areas).
const primary = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const dual = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
];

describe('windowState.computeBounds', () => {
  it('restores a saved position that is visible', () => {
    const r = ws.computeBounds({ x: 200, y: 150, width: 1000, height: 700 }, primary);
    expect([r.x, r.y, r.width, r.height]).toEqual([200, 150, 1000, 700]);
  });

  it('keeps a position on a still-connected second monitor', () => {
    const r = ws.computeBounds({ x: 2200, y: 100, width: 1000, height: 700 }, dual);
    expect(r.x).toBe(2200);
  });

  // The point of the feature: a window saved on a now-unplugged monitor must NOT
  // reopen off-screen — x/y are dropped so Electron centers it.
  it('drops an off-screen position (monitor unplugged) → centers', () => {
    const r = ws.computeBounds({ x: 2200, y: 100, width: 1000, height: 700 }, primary);
    expect(r.x).toBeUndefined();
    expect(r.y).toBeUndefined();
    expect(r.width).toBe(1000); // size still honored
  });

  it('drops negative / off-top-left positions', () => {
    const r = ws.computeBounds({ x: -1500, y: -1200, width: 1000, height: 700 }, primary);
    expect(r.x).toBeUndefined();
  });

  it('drops a position only a sliver visible at the bottom-right', () => {
    const r = ws.computeBounds({ x: 1890, y: 1010, width: 1000, height: 700 }, primary);
    expect(r.x).toBeUndefined();
  });

  it('clamps a size larger than the available work area', () => {
    const r = ws.computeBounds({ x: 0, y: 0, width: 5000, height: 4000 }, primary);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1040);
  });

  it('restores the maximized flag', () => {
    const r = ws.computeBounds({ x: 50, y: 50, width: 1200, height: 820, isMaximized: true }, primary);
    expect(r.isMaximized).toBe(true);
  });

  it('falls back to centered defaults on first run', () => {
    const r = ws.computeBounds(null, primary);
    expect(r.width).toBe(ws.DEFAULTS.width);
    expect(r.height).toBe(ws.DEFAULTS.height);
    expect(r.x).toBeUndefined();
    expect(r.isMaximized).toBe(false);
  });
});

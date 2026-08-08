/**
 * The desktop app's static file server.
 *
 * Worth its own tests because its failure mode is a blank window and one console line: the
 * `app://` handler falls back to `index.html` for anything it cannot find, and a browser
 * will not execute HTML as a module. Every JS chunk the build emits is fetched through
 * here, so a change to how the bundle is split reaches the desktop app along this path and
 * nowhere else — the browser build would keep working perfectly while the desktop one
 * showed nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveAppAsset } from '../../electron/appAssets.cjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

let dist;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'job-monitor-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'export {}');
  writeFileSync(join(dist, 'assets', 'primer-def456.js'), 'export {}');
  writeFileSync(join(dist, 'assets', 'style-ghi789.css'), 'body{}');
  writeFileSync(join(dist, 'icon.png'), '');
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

describe('resolveAppAsset', () => {
  it('serves the entry document at the root', () => {
    const resolved = resolveAppAsset('/', dist);
    expect(resolved.status).toBe(200);
    expect(resolved.contentType).toBe('text/html');
    expect(resolved.filePath).toBe(join(dist, 'index.html'));
  });

  /**
   * The case the split bundle depends on: a chunk must come back as JavaScript, not as the
   * fallback document. Several chunks rather than one, since the point of the test is that
   * it keeps holding when the build emits more of them.
   */
  it('serves each chunk as JavaScript', () => {
    for (const name of ['index-abc123.js', 'primer-def456.js']) {
      const resolved = resolveAppAsset(`/assets/${name}`, dist);
      expect(resolved.status).toBe(200);
      expect(resolved.contentType).toBe('text/javascript');
      expect(resolved.fallback).toBe(false);
    }
  });

  it('serves stylesheets and images with their own types', () => {
    expect(resolveAppAsset('/assets/style-ghi789.css', dist).contentType).toBe('text/css');
    expect(resolveAppAsset('/icon.png', dist).contentType).toBe('image/png');
  });

  /**
   * The fallback is flagged, not hidden. A navigation legitimately lands here; a `.js`
   * request landing here is a renamed-or-missing chunk, and the caller logs it rather than
   * quietly serving HTML to a module loader.
   */
  it('flags the fallback so a missing chunk is distinguishable from a navigation', () => {
    const chunk = resolveAppAsset('/assets/renamed-000.js', dist);
    expect(chunk.fallback).toBe(true);
    expect(chunk.filePath).toBe(join(dist, 'index.html'));
    // And the content type follows the file actually served, so nothing claims to be JS.
    expect(chunk.contentType).toBe('text/html');

    const route = resolveAppAsset('/some/spa/route', dist);
    expect(route.fallback).toBe(true);
    expect(route.contentType).toBe('text/html');
  });

  it('refuses to escape the bundle', () => {
    for (const attempt of ['/../../../etc/passwd', '/assets/../../secret', `/..${sep}..${sep}x`]) {
      expect(resolveAppAsset(attempt, dist).status).toBe(403);
    }
  });

  it('gives an unknown extension a type that will not be executed', () => {
    writeFileSync(join(dist, 'data.bin'), '');
    expect(resolveAppAsset('/data.bin', dist).contentType).toBe('application/octet-stream');
  });
});

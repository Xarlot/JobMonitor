/**
 * The document itself, which is not the app.
 *
 * Two defects lived here and both were invisible to every other test: they typecheck, they build, and
 * they render — the only symptom is a strip of the wrong colour at the edge of a window.
 *
 * 1. **`html` had no background.** The app paints its background on a div (`min-height: 100vh`), which
 *    does not extend into the gutter `scrollbar-gutter: stable` reserves, nor into the overscroll area.
 *    Primer 36's styled-components BaseStyles painted the document; 38 does not. In a browser the bare
 *    canvas is white and nobody notices. In the desktop app it is the window's own `backgroundColor`
 *    (#0d1117), so a light UI grew a black band down its side. Measured before the fix: the computed
 *    background of `html` was `rgba(0, 0, 0, 0)` in both schemes.
 *
 * 2. **`data-dark-theme` named a theme with no CSS.** `index.html` said `dark`, while the app imports
 *    `dark-dimmed.css`, which is scoped to `[data-dark-theme="dark_dimmed"]`. `ThemeContext` rewrites
 *    the attribute after mount, so this only governed the instant before — but that instant is a real
 *    one, and this is the trap `main.tsx` warns about in its own header comment.
 *
 * The expected theme name is derived from the import rather than written down twice, so the two cannot
 * drift apart: that drift *is* the bug.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const mainTsx = readFileSync(join(root, 'src', 'main.tsx'), 'utf8');

/** `…/themes/dark-dimmed.css` → `dark_dimmed`, the value Primer scopes that file to. */
function importedDarkTheme(): string {
  const found = [...mainTsx.matchAll(/themes\/([a-z-]+)\.css/g)].map((m) => m[1]);
  const dark = found.filter((name) => name.startsWith('dark'));
  expect(dark).toHaveLength(1);
  return dark[0].replace(/-/g, '_');
}

describe('index.html', () => {
  it('names the dark theme whose CSS is actually imported', () => {
    const attr = /data-dark-theme="([^"]+)"/.exec(html);
    expect(attr?.[1]).toBe(importedDarkTheme());
  });

  it('paints the document, not only the app', () => {
    // The gutter is reserved unconditionally, so something has to fill it.
    expect(html).toMatch(/scrollbar-gutter:\s*stable/);

    const rule = /html\s*\{([^}]*)\}/.exec(html);
    expect(rule, 'no `html { … }` rule in index.html').not.toBeNull();
    expect(rule?.[1]).toMatch(/background-color:\s*var\(--bgColor-default/);

    // And in the dark scheme too, since the fallback in the rule above is the light value and applies
    // for the instant before the theme CSS is parsed.
    const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*html\s*\{([^}]*)\}/.exec(html);
    expect(dark, 'no dark-scheme background for the document').not.toBeNull();
    expect(dark?.[1]).toMatch(/background-color:\s*var\(--bgColor-default/);
  });

  /**
   * Primer's theme CSS declares `color-scheme` itself, scoped to the same attributes. A copy here
   * would be a second opinion able to drift from the first, and the measurement said it was never
   * wrong: the computed value was already correct in both schemes before any of this changed.
   */
  it('leaves color-scheme to Primer', () => {
    // The lookbehind is load-bearing: `prefers-color-scheme: dark` contains this as a substring, so
    // without it the media query the fix depends on trips the assertion against it.
    expect(html).not.toMatch(/(?<!prefers-)color-scheme:\s*(light|dark)\b/);
  });
});

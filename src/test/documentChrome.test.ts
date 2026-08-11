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
   * `color-scheme` on the **root**, which is where the browser reads it from to paint the viewport
   * scrollbar. Primer looks like it covers this and does not: `BaseStyles` declares it on
   * `[data-color-mode=light] input` and `[data-color-mode=dark] input` — text fields only — and on
   * `html` just for `auto` mode, inside a media query. Pick a theme explicitly and the root has no
   * scheme, which is a light scrollbar down the side of a dark app.
   *
   * These rules were once removed on the grounds that Primer already had them. Two things made that
   * look true: a grep that matched `prefers-color-scheme` as if it were a declaration, and
   * `getComputedStyle`, which reports the *used* value and so answers `dark` whether or not anything
   * declared it. Hence asserting the text of the rules, which is the only thing that distinguishes
   * declared from inferred.
   */
  it('declares color-scheme on the root, for all three theme modes', () => {
    // The lookbehind is load-bearing throughout: `prefers-color-scheme: dark` contains
    // `color-scheme: dark` as a substring, so without it the media query matches as a declaration —
    // which is exactly the mistake being guarded against.
    const declarations = [...html.matchAll(/(?<!prefers-)color-scheme:\s*(light|dark)/g)];
    expect(declarations.length).toBeGreaterThanOrEqual(4);

    const rule = /html\s*\{([^}]*)\}/.exec(html);
    expect(rule?.[1]).toMatch(/(?<!prefers-)color-scheme:\s*light/);

    const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*html\s*\{([^}]*)\}/.exec(html);
    expect(dark?.[1]).toMatch(/(?<!prefers-)color-scheme:\s*dark/);

    // And the explicit modes, which are the ones Primer leaves to the inputs.
    expect(html).toMatch(/html\[data-color-mode='light'\]\s*\{[^}]*color-scheme:\s*light/);
    expect(html).toMatch(/html\[data-color-mode='dark'\]\s*\{[^}]*color-scheme:\s*dark/);
  });
});

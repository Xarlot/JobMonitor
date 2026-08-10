/**
 * Every telemetry method the main process calls actually exists.
 *
 * Written after `main.cjs` called `telemetry?.operationCompleted(...)`, which the facade did not
 * have. Optional chaining reads as a guard and is not one here: `?.` protects against `telemetry`
 * being null, not against the method being absent, so the call threw — inside `app.whenReady()`,
 * before the window was created. The app built, started, printed its log path and then showed
 * nothing, which is about the worst shape a failure can take.
 *
 * Nothing else catches it. The facade is JavaScript with no types across that boundary; the unit
 * tests exercise the telemetry module directly and never through `main.cjs`; and `main.cjs` cannot
 * be imported outside Electron, so no test loads it. What is checkable without Electron is the two
 * halves agreeing, which is what this does: read the call sites out of the source, read the facade
 * shape out of a real instance, and compare.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);
const MAIN = readFileSync(join(__dirname, '../../electron/main.cjs'), 'utf8');

const dir = mkdtempSync(join(tmpdir(), 'jm-telemetry-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The bundle is what ships; the sources under `electron/telemetry/` are only its input. */
function loadFacade(): Record<string, unknown> {
  const mod = require_('../../electron/telemetry.bundle.cjs') as {
    initTelemetry: (o: unknown) => Record<string, unknown> | null;
  };
  const instance = mod.initTelemetry({
    dir: join(dir, 'telemetry'),
    appVersion: '2.2.0',
    platform: process.platform,
    arch: process.arch,
    electronVersion: '43.0.0',
    send: false,
    onLog: () => {},
    sanitizeContext: { home: dir, userData: dir, username: 'test' },
  });
  if (!instance) throw new Error('initTelemetry returned null');
  return instance;
}

/**
 * Every `telemetry.x` / `telemetry?.x` in main.cjs, split into calls and plain reads.
 *
 * One scan rather than two regexes: a negative lookahead after `[\w$]*` lets the engine backtrack
 * the name to satisfy it, so `sendNow(` matches as the property `sendNo`. Deciding from the text
 * that follows the whole match cannot do that.
 *
 * The lookbehind keeps file names out. `docs/telemetry.md` and `vite.telemetry.config.ts` appear in
 * comments and read as property accesses to a regex — `\b` is happy with a preceding slash.
 */
function accesses(): { calls: Set<string>; reads: Set<string> } {
  const calls = new Set<string>();
  const reads = new Set<string>();
  for (const m of MAIN.matchAll(/(?<![\w/.$-])telemetry\??\.([a-zA-Z_$][\w$]*)/g)) {
    const after = MAIN.slice(m.index + m[0].length);
    (/^\s*\(/.test(after) ? calls : reads).add(m[1]);
  }
  return { calls, reads };
}

describe('main-process telemetry surface', () => {
  it('exposes every method main.cjs calls on it', () => {
    const facade = loadFacade();
    const { calls } = accesses();
    expect(calls.size).toBeGreaterThan(5);
    expect([...calls].filter((name) => typeof facade[name] !== 'function')).toEqual([]);
  });

  it('exposes every property main.cjs reads from it', () => {
    const facade = loadFacade();
    const { reads } = accesses();
    expect([...reads].filter((name) => !(name in facade))).toEqual([]);
  });

  /**
   * The id tables in main.cjs are plain numbers with no import from the registry — deliberately,
   * since that file is CommonJS and the registry is not. The cost is that a typo there is invisible
   * until a dashboard is missing a line, so each mirrored id is checked against the real registry.
   */
  it('mirrors ids the registry actually knows', async () => {
    const { Features, Operations } = await import('@jobmonitor/telemetry-schema/registry');

    const table = (name: string) => {
      const block = new RegExp(`const ${name} = \\{([^}]*)\\}`, 's').exec(MAIN);
      if (!block) throw new Error(`no ${name} table in main.cjs`);
      return [...block[1].matchAll(/([A-Z_0-9]+):\s*(\d+)/g)].map(
        (m) => [m[1], Number(m[2])] as const,
      );
    };

    const features = table('FEATURE');
    const operations = table('OPERATION');
    expect(features.length).toBeGreaterThan(0);
    expect(operations.length).toBeGreaterThan(0);

    expect(features.filter(([, id]) => !Features.has(id))).toEqual([]);
    expect(operations.filter(([, id]) => !Operations.has(id))).toEqual([]);

    // And that the names agree, not just the numbers: an id that exists but means something else
    // is the failure this table is most likely to have.
    for (const [name, id] of features) expect(Features.keyOf(id)).toBe(name.toLowerCase().replace('_', '.'));
  });
});

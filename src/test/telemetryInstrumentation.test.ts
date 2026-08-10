/**
 * Instrumentation hygiene.
 *
 * Not a test of behaviour — a test of the *wiring*, checked by reading the source. Two mistakes are
 * possible here and neither shows up at runtime:
 *
 *   **Double counting.** An operation timed both by `usePolling` and again inside the API function
 *   it calls reports twice the traffic, and the chart looks entirely reasonable. This nearly
 *   happened with `GH_JOBS_FETCH`, which `useFlows` already times through the poller.
 *
 *   **Recording from render.** `main.tsx` wraps the tree in `React.StrictMode`, which double-invokes
 *   effects in development. A `featureUsed` call in a component body or a bare effect makes dev
 *   counts twice production's — worse than not measuring, because it looks like data.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file rather than from cwd: vitest runs with the repo root as cwd, and a
// relative path would quietly scan the wrong tree and pass by finding nothing.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'test' || entry === 'mocks' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** Operations already timed by `usePolling`; timing them again inside the API would double them. */
const TIMED_BY_POLLER = files
  .flatMap(({ text }) => [...text.matchAll(/op:\s*Operation\.([A-Z_]+)/g)])
  .map((m) => m[1]);

describe('no operation is timed twice', () => {
  it('finds the pollers', () => {
    // Guards the guard: if the `op:` convention ever changes, the check below would silently pass
    // by comparing against an empty list.
    expect(TIMED_BY_POLLER.length).toBeGreaterThan(0);
  });

  it.each(TIMED_BY_POLLER)('%s is not also measured inside src/api', (op) => {
    const inApi = files.filter(
      ({ path, text }) =>
        path.includes(`${'/'}api${'/'}`) && text.includes(`Operation.${op}`),
    );
    expect(
      inApi.map((f) => f.path),
      `${op} is timed by usePolling; measuring it again in the API layer would double every count`,
    ).toEqual([]);
  });

  it('never measures the same operation in two files', () => {
    const seen = new Map<string, string[]>();
    for (const { path, text } of files) {
      for (const m of text.matchAll(/Telemetry\.measure\(Operation\.([A-Z_]+)/g)) {
        seen.set(m[1], [...(seen.get(m[1]) ?? []), path]);
      }
    }
    const duplicated = [...seen.entries()].filter(([, paths]) => new Set(paths).size > 1);
    expect(duplicated).toEqual([]);
  });
});

describe('features are recorded from event handlers', () => {
  it('never calls featureUsed at the top level of a module', () => {
    // A module-level call fires on import — once per process in production, and repeatedly in
    // development as modules reload.
    for (const { path, text } of files) {
      for (const line of text.split('\n')) {
        if (/^\s{0,2}Telemetry\.featureUsed\(/.test(line)) {
          expect.fail(`${path}: featureUsed at module top level — "${line.trim()}"`);
        }
      }
    }
  });

  it('never calls featureUsed directly inside a useEffect body', () => {
    // StrictMode double-invokes effects in development. A ref-guarded call is fine; a bare one is
    // not, and the difference is invisible in production.
    for (const { path, text } of files) {
      const effects = text.matchAll(/useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}/g);
      for (const effect of effects) {
        if (/Telemetry\.featureUsed\(/.test(effect[1])) {
          expect.fail(`${path}: featureUsed inside a useEffect body — StrictMode would double it`);
        }
      }
    }
  });
});

describe('the API surface stays numeric', () => {
  it('no call site passes a string to the telemetry facade', () => {
    // The structural guarantee restated as a lint: every dimension is an id from the registry, so
    // nothing about a repository can travel even by accident.
    for (const { path, text } of files) {
      for (const m of text.matchAll(/Telemetry\.(featureUsed|operationCompleted|operationFailed)\(([^)]*)\)/g)) {
        expect(m[2], `${path}: ${m[0]}`).not.toMatch(/['"`]/);
      }
    }
  });
});

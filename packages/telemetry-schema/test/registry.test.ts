/**
 * Registry invariants.
 *
 * These ids are permanent in the strongest sense: they key a year of dashboard history. A renumber
 * silently merges two unrelated features; a reused id silently attributes one feature's usage to
 * another. Neither produces an error anywhere — just a chart that is wrong in a way nobody can
 * detect after the fact. Hence the paranoia.
 */

import { describe, expect, it } from 'vitest';

import { ERROR_CATEGORY_DEFS, ErrorCategories } from '../src/registry/errorCategories';
import { FEATURE_DEFS, Features } from '../src/registry/features';
import { OPERATION_DEFS, Operations } from '../src/registry/operations';
import { buildRegistry } from '../src/registry/registry';
import { DURATION_BUCKET_BOUNDS_MS, DURATION_BUCKET_COUNT, durationBucket } from '../src/limits';

const registries = [
  ['Feature', FEATURE_DEFS, Features],
  ['Operation', OPERATION_DEFS, Operations],
  ['ErrorCategory', ERROR_CATEGORY_DEFS, ErrorCategories],
] as const;

describe.each(registries)('%s registry', (name, defs, registry) => {
  const entries = Object.entries(defs);

  it('has unique ids', () => {
    const ids = entries.map(([, d]) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique dashboard keys', () => {
    const keys = entries.map(([, d]) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses lower_snake keys', () => {
    // The receiver denormalizes these into OpenObserve, where they become column values people
    // read and type into queries. Inconsistent shapes there are a permanent papercut.
    //
    // Features and operations are dotted `area.thing`; error categories are a deliberately flat
    // vocabulary (`network`, `timeout`) because they are not scoped to an area and prefixing them
    // with a fake one would read worse in every query that uses them.
    const shape =
      name === 'ErrorCategory'
        ? /^[a-z][a-z0-9_]*$/
        : /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    for (const [symbol, def] of entries) {
      expect(def.key, `${name}.${symbol}`).toMatch(shape);
    }
  });

  it('resolves known ids and degrades on unknown ones', () => {
    for (const [, def] of entries) expect(registry.keyOf(def.id)).toBe(def.key);
    // Never throws. An id from a newer client must cost that one record, not the whole batch.
    expect(registry.keyOf(999_999)).toBe('unknown(999999)');
    expect(registry.has(999_999)).toBe(false);
  });
});

describe('registry construction', () => {
  it('refuses duplicate ids at build time', () => {
    expect(() =>
      buildRegistry('T', { A: { id: 1, key: 'a.a' }, B: { id: 1, key: 'b.b' } }),
    ).toThrow(/id 1 used by both/);
  });

  it('refuses a retired id', () => {
    expect(() => buildRegistry('T', { A: { id: 7, key: 'a.a' } }, [7])).toThrow(/retired id 7/);
  });

  it('refuses duplicate keys', () => {
    expect(() =>
      buildRegistry('T', { A: { id: 1, key: 'same.key' }, B: { id: 2, key: 'same.key' } }),
    ).toThrow(/duplicate key/);
  });
});

describe('feature id blocks', () => {
  // Blocks of 100 by area. Enforced so a new value is appended to its own block rather than to the
  // end of the file — which is what keeps a mistyped id landing somewhere obviously wrong.
  it('keeps every feature inside a hundred-block', () => {
    for (const [symbol, def] of Object.entries(FEATURE_DEFS)) {
      expect(def.id, symbol).toBeGreaterThanOrEqual(100);
      expect(def.id, symbol).toBeLessThan(1000);
    }
  });

  it('keeps every operation at or above 1000', () => {
    for (const [symbol, def] of Object.entries(OPERATION_DEFS)) {
      expect(def.id, symbol).toBeGreaterThanOrEqual(1000);
    }
  });

  it('never lets a feature and an operation share an id', () => {
    for (const id of Features.ids) expect(Operations.has(id)).toBe(false);
  });
});

describe('duration buckets', () => {
  it('has one more bucket than it has bounds', () => {
    expect(DURATION_BUCKET_COUNT).toBe(DURATION_BUCKET_BOUNDS_MS.length + 1);
  });

  it('is strictly ascending', () => {
    for (let i = 1; i < DURATION_BUCKET_BOUNDS_MS.length; i++) {
      expect(DURATION_BUCKET_BOUNDS_MS[i]).toBeGreaterThan(DURATION_BUCKET_BOUNDS_MS[i - 1]);
    }
  });

  it('assigns every duration to exactly one bucket', () => {
    expect(durationBucket(0)).toBe(0);
    expect(durationBucket(49)).toBe(0);
    expect(durationBucket(50)).toBe(1);
    expect(durationBucket(4999)).toBe(6);
    expect(durationBucket(5000)).toBe(7);
    expect(durationBucket(Number.MAX_SAFE_INTEGER)).toBe(7);
  });

  it('never returns an out-of-range index for a malformed duration', () => {
    // A NaN or negative duration should cost one slightly wrong data point, never an exception on
    // a path the app is explicitly not allowed to notice.
    for (const bad of [NaN, -1, -Infinity, Infinity]) {
      const b = durationBucket(bad);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(DURATION_BUCKET_COUNT);
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTtlCache } from '../storage/localTtlCache';

const KEY = 'test.ttlcache';
const HOUR = 3600_000;

function cache(over: Partial<Parameters<typeof createTtlCache>[0]> = {}) {
  return createTtlCache<{ v: string }>({
    storageKey: KEY,
    ttlMs: 24 * HOUR,
    maxEntries: 5,
    maxBytes: 100_000,
    ...over,
  });
}

describe('createTtlCache', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('round-trips a value', () => {
    const c = cache();
    c.set('a', { v: 'one' });
    expect(c.get('a')).toEqual({ v: 'one' });
  });

  it('misses on an unknown id', () => {
    expect(cache().get('nope')).toBeUndefined();
  });

  /** The point of persisting: a fresh instance (a remount) still knows. */
  it('survives a new instance reading the same storage key', () => {
    cache().set('a', { v: 'one' });
    expect(cache().get('a')).toEqual({ v: 'one' });
  });

  it('lists live entries for bulk hydration', () => {
    const c = cache();
    c.setMany([
      ['a', { v: 'one' }],
      ['b', { v: 'two' }],
    ]);
    expect(new Map(cache().entries())).toEqual(
      new Map([
        ['a', { v: 'one' }],
        ['b', { v: 'two' }],
      ]),
    );
  });

  it('ignores an empty setMany', () => {
    const c = cache();
    c.setMany([]);
    expect(c.entries()).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('forgets an entry once its TTL has passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    cache({ ttlMs: HOUR }).set('a', { v: 'one' });

    vi.setSystemTime(new Date('2026-07-01T00:30:00Z'));
    expect(cache({ ttlMs: HOUR }).get('a')).toEqual({ v: 'one' });

    vi.setSystemTime(new Date('2026-07-01T02:00:00Z'));
    expect(cache({ ttlMs: HOUR }).get('a')).toBeUndefined();
    expect(cache({ ttlMs: HOUR }).entries()).toEqual([]);
  });

  /** localStorage is a shared budget, so the cap has to actually hold. */
  it('keeps only the most recent entries past maxEntries', () => {
    const c = cache({ maxEntries: 3 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) c.set(id, { v: id });
    const ids = c.entries().map(([id]) => id).sort();
    expect(ids).toEqual(['c', 'd', 'e']);
  });

  it('drops entries to stay under maxBytes', () => {
    const big = 'x'.repeat(2000);
    const c = cache({ maxEntries: 50, maxBytes: 5000 });
    for (let i = 0; i < 10; i++) c.set(`k${i}`, { v: big });
    const serialized = localStorage.getItem(KEY) ?? '';
    expect(serialized.length).toBeLessThanOrEqual(5000);
    // …and it kept something rather than giving up entirely.
    expect(c.entries().length).toBeGreaterThan(0);
  });

  it('clears the storage key when nothing is left', () => {
    const c = cache();
    c.set('a', { v: 'one' });
    expect(localStorage.getItem(KEY)).not.toBeNull();
    c.clear();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(c.get('a')).toBeUndefined();
  });

  it('starts empty on corrupt stored JSON', () => {
    localStorage.setItem(KEY, '{not json');
    const c = cache();
    expect(c.entries()).toEqual([]);
    // …and can still store afterwards.
    c.set('a', { v: 'one' });
    expect(c.get('a')).toEqual({ v: 'one' });
  });

  it('ignores stored entries that are not shaped like entries', () => {
    localStorage.setItem(KEY, JSON.stringify({ a: null, b: 'nope', c: { value: {} } }));
    expect(cache().entries()).toEqual([]);
  });

  it('overwrites an existing id rather than duplicating it', () => {
    const c = cache();
    c.set('a', { v: 'one' });
    c.set('a', { v: 'two' });
    expect(c.entries()).toEqual([['a', { v: 'two' }]]);
  });
});

/**
 * The range filter, and the bucketing it drives.
 *
 * Two very different kinds of test live here. The `resolveRange` cases are ordinary input handling
 * — the values come out of a URL anyone can type, so every malformed shape must land on the default
 * rather than reach SQL. The bucketing case is a regression test for a bug that produced no error,
 * no warning and a chart that looked completely reasonable; see the last test in the file.
 */

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PRESET, bucketMs, resolveRange, toDayString } from '../src/lib/range';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 9, 15, 3, 0);

describe('resolveRange', () => {
  it('defaults when nothing is asked for', () => {
    const r = resolveRange({}, NOW);
    expect(r.preset).toBe(DEFAULT_PRESET);
    expect(r.to).toBe(NOW);
    expect(r.from).toBe(NOW - 30 * DAY);
  });

  it('honours each preset', () => {
    expect(resolveRange({ range: '24h' }, NOW).from).toBe(NOW - DAY);
    expect(resolveRange({ range: '7d' }, NOW).from).toBe(NOW - 7 * DAY);
    expect(resolveRange({ range: '90d' }, NOW).from).toBe(NOW - 90 * DAY);
  });

  it('takes an explicit window, ending at the close of the last day', () => {
    const r = resolveRange({ from: '2026-07-20', to: '2026-07-25' }, NOW);
    expect(r.preset).toBe('custom');
    expect(r.from).toBe(Date.UTC(2026, 6, 20));
    // Inclusive of the whole final day — a window ending at midnight would silently omit it.
    expect(r.to).toBe(Date.UTC(2026, 6, 25, 23, 59, 59, 999));
  });

  it('swaps a reversed window instead of shifting it', () => {
    const forwards = resolveRange({ from: '2026-07-20', to: '2026-07-25' }, NOW);
    const backwards = resolveRange({ from: '2026-07-25', to: '2026-07-20' }, NOW);
    // Identical, not merely ordered. Extending the day before ordering used to move both edges by
    // almost a day, so a reversed window covered a different period than the same two dates typed
    // the right way round.
    expect(backwards).toEqual(forwards);
    expect(backwards.from).toBe(Date.UTC(2026, 6, 20));
    expect(backwards.to).toBe(Date.UTC(2026, 6, 25, 23, 59, 59, 999));
  });

  it('labels the days that were asked for, in UTC', () => {
    // Formatted in local time, the end-of-day instant rolls into the next date east of Greenwich
    // and the label contradicts the date the user picked.
    expect(resolveRange({ from: '2026-08-01', to: '2026-08-09' }, NOW).label).toBe(
      '01 Aug 2026 — 09 Aug 2026',
    );
  });

  it('covers the whole of a single-day window', () => {
    const r = resolveRange({ from: '2026-07-20', to: '2026-07-20' }, NOW);
    expect(r.to - r.from).toBe(DAY - 1);
  });

  it('clamps an absurd span to a year', () => {
    const r = resolveRange({ from: '1990-01-01', to: '2026-01-01' }, NOW);
    expect(r.to - r.from).toBeLessThanOrEqual(366 * DAY);
  });

  /**
   * The whole point of parsing rather than trusting. Each of these reaches SQL as a bound
   * parameter, so "falls back to the default" is a security property, not a nicety.
   */
  it.each([
    ["' OR 1=1--", undefined],
    ['not-a-date', undefined],
    ['2026-13-45', undefined],
    ['', ''],
    ['9999999999999999', '0'],
  ])('falls back to the default on hostile input (%s)', (range, from) => {
    const r = resolveRange({ range, from } as Record<string, string | undefined>, NOW);
    expect(r.preset).toBe(DEFAULT_PRESET);
    expect(Number.isFinite(r.from)).toBe(true);
    expect(r.from).toBeLessThan(r.to);
  });

  it('takes the first value when a param is repeated', () => {
    expect(resolveRange({ range: ['7d', '90d'] }, NOW).preset).toBe('7d');
  });

  it('round-trips through the date-input format', () => {
    const r = resolveRange({ range: '7d' }, NOW);
    const back = resolveRange({ from: toDayString(r.from), to: toDayString(r.to) }, NOW);
    expect(toDayString(back.from)).toBe(toDayString(r.from));
  });
});

describe('bucketMs', () => {
  it('buckets a short range by the hour and a long one by the day', () => {
    expect(bucketMs({ from: NOW - DAY, to: NOW })).toBe(3_600_000);
    expect(bucketMs({ from: NOW - 7 * DAY, to: NOW })).toBe(DAY);
  });

  /**
   * **Regression test for a silent bug.**
   *
   * `node:sqlite` binds a JS number as REAL — every JS number is a double — so `ts / ?` is
   * floating-point division and `(ts / ?) * ?` hands `ts` straight back. Nothing throws. The query
   * returns the right number of rows in the right order, grouped by nothing at all, and the chart
   * drawn from it looks entirely plausible. The literal form escapes this only because SQLite's
   * parser reads `86400000` as an INTEGER.
   *
   * Asserting the grouped values are day-aligned is what catches it: under the bug they come back
   * as raw timestamps, some with a fractional tail from the double arithmetic.
   */
  it('buckets by integer division when the width is bound as a parameter', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (ts INTEGER)');
    const rows = [
      Date.UTC(2026, 7, 8, 20, 31, 2, 268),
      Date.UTC(2026, 7, 8, 22, 14, 51),
      Date.UTC(2026, 7, 9, 11, 3, 32, 30),
    ];
    for (const ts of rows) db.prepare('INSERT INTO t VALUES (?)').run(ts);

    const grouped = (width: number | bigint) =>
      (
        db
          .prepare('SELECT DISTINCT (ts / ?) * ? AS day FROM t ORDER BY day')
          .all(width, width) as { day: number }[]
      ).map((r) => r.day);

    // A plain number does nothing at all — three rows in, three distinct "buckets" out.
    expect(grouped(DAY)).toHaveLength(3);

    const days = grouped(BigInt(DAY));
    expect(days).toEqual([Date.UTC(2026, 7, 8), Date.UTC(2026, 7, 9)]);
    expect(days.every((d) => d % DAY === 0)).toBe(true);
  });
});

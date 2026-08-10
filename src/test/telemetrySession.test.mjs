/**
 * Session accounting, aggregation, and installation identity.
 *
 * The interesting cases here are all about time behaving badly: a laptop sleeping, an NTP
 * correction moving the clock backwards, a DST transition, a bucket boundary crossed mid-session.
 * Every one of them produces a plausible-looking number if handled wrong, which is why they are
 * tested against an injected clock rather than left to be discovered from a chart.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAggregate } from '../../electron/telemetry/aggregate.mjs';
import { createSession } from '../../electron/telemetry/session.mjs';
import { hourBucket, resetNow, setNow } from '../../electron/telemetry/clock.mjs';
import {
  loadInstallationId,
  markSessionEnd,
  markSessionStart,
  takeUncleanExit,
} from '../../electron/telemetry/install.mjs';
import { DURATION_BUCKET_COUNT } from '../../electron/telemetry/constants.mjs';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

let clock;
let dir;

beforeEach(() => {
  clock = Date.UTC(2026, 7, 8, 18, 0, 0);
  setNow(() => clock);
  dir = mkdtempSync(join(tmpdir(), 'telemetry-install-'));
});

afterEach(() => {
  resetNow();
  rmSync(dir, { recursive: true, force: true });
});

describe('aggregate', () => {
  it('counts features additively', () => {
    const a = createAggregate();
    a.featureUsed(300);
    a.featureUsed(300);
    a.featureUsed(301);

    const snap = a.snapshotAndReset();
    expect(snap.features).toEqual([
      { featureId: 300, count: 2 },
      { featureId: 301, count: 1 },
    ]);
  });

  it('resets on snapshot so nothing is counted twice', () => {
    const a = createAggregate();
    a.featureUsed(300);
    a.snapshotAndReset();
    expect(a.snapshotAndReset().features).toEqual([]);
    expect(a.isEmpty()).toBe(true);
  });

  it('builds a duration histogram with one entry per completion', () => {
    // Bounds are [50, 100, 250, 500, 1000, 2000, 5000], so the eight buckets are
    //   <50 | 50–99 | 100–249 | 250–499 | 500–999 | 1000–1999 | 2000–4999 | >=5000
    // and one sample is placed in each, in order.
    const a = createAggregate();
    for (const ms of [10, 75, 200, 300, 700, 1500, 3000, 9000]) a.operationCompleted(1000, ms);

    const [op] = a.snapshotAndReset().operations;
    expect(op.buckets).toHaveLength(DURATION_BUCKET_COUNT);
    expect(op.buckets).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // The invariant the receiver validates: the histogram must account for every completion.
    expect(op.buckets.reduce((x, y) => x + y, 0)).toBe(op.count);
    expect(op.count).toBe(8);
    expect(op.durationMaxMs).toBe(9000);
    expect(op.durationSumMs).toBe(14785);
  });

  it('places boundary durations in the lower bucket', () => {
    const a = createAggregate();
    a.operationCompleted(1000, 49);
    a.operationCompleted(1000, 50);
    const [op] = a.snapshotAndReset().operations;
    expect(op.buckets[0]).toBe(1);
    expect(op.buckets[1]).toBe(1);
  });

  it('clamps a negative duration rather than corrupting the sum', () => {
    // The clock can move during an operation. That should cost one wrong data point, never an
    // exception on a path the app is not allowed to notice.
    const a = createAggregate();
    a.operationCompleted(1000, -500);
    a.operationCompleted(1000, NaN);

    const [op] = a.snapshotAndReset().operations;
    expect(op.count).toBe(2);
    expect(op.durationSumMs).toBe(0);
    expect(op.buckets.reduce((x, y) => x + y, 0)).toBe(2);
  });

  it('counts failures separately from completions', () => {
    const a = createAggregate();
    a.operationCompleted(1000, 10);
    a.operationFailed(1000, 5);
    a.operationFailed(1000, 5);
    a.operationFailed(1000, 1);

    const [op] = a.snapshotAndReset().operations;
    expect(op.count).toBe(1);
    expect(op.failures).toEqual([
      { errorCategory: 5, count: 2 },
      { errorCategory: 1, count: 1 },
    ]);
  });

  it('merges a renderer delta in the wire shape', () => {
    const a = createAggregate();
    a.merge({ features: [[300, 3]], operations: [[1000, [10, 20]]], failures: [[1000, 2]] });

    const snap = a.snapshotAndReset();
    expect(snap.features).toEqual([{ featureId: 300, count: 3 }]);
    expect(snap.operations[0].count).toBe(2);
    expect(snap.operations[0].failures).toEqual([{ errorCategory: 2, count: 1 }]);
  });
});

describe('session time', () => {
  it('credits running time by the heartbeat', () => {
    const s = createSession();
    s.started();
    clock += 60 * SECOND;
    s.tick();

    const [b] = s.snapshotAndReset();
    expect(b.runningSeconds).toBe(60);
    expect(b.appStarts).toBe(1);
    expect(b.sessionCount).toBe(1);
  });

  it('clamps a sleeping laptop to one interval rather than crediting the whole nap', () => {
    // The single most important clamp in the module. Without it, an overnight sleep reports eight
    // hours of use and every "active time" chart becomes meaningless.
    const s = createSession();
    s.started();
    clock += 8 * HOUR;
    const credited = s.tick();

    expect(credited).toBe(60 * SECOND);
    const total = s.snapshotAndReset().reduce((n, b) => n + b.runningSeconds, 0);
    expect(total).toBe(60);
  });

  it('credits nothing when the clock moves backwards', () => {
    const s = createSession();
    s.started();
    clock -= 5 * MINUTE; // NTP correction, or the user changed the clock
    expect(s.tick()).toBe(0);

    const total = s.snapshotAndReset().reduce((n, b) => n + b.runningSeconds, 0);
    expect(total).toBe(0);
  });

  it('tracks foreground time only while focused', () => {
    const s = createSession();
    s.started();

    s.foregroundStarted();
    clock += 30 * SECOND;
    s.foregroundEnded();

    clock += 30 * SECOND; // hidden in the tray, still polling
    s.tick();

    const [b] = s.snapshotAndReset();
    expect(b.foregroundSeconds).toBe(30);
    expect(b.runningSeconds).toBe(60);
  });

  it('does not double-credit a repeated foreground start', () => {
    const s = createSession();
    s.started();
    s.foregroundStarted();
    clock += 10 * SECOND;
    s.foregroundStarted(); // e.g. 'show' and 'focus' both firing
    clock += 10 * SECOND;
    s.foregroundEnded();

    expect(s.snapshotAndReset()[0].foregroundSeconds).toBe(20);
  });

  it('splits across an hour boundary into two UTC buckets', () => {
    const s = createSession();
    s.started(); // 18:00
    clock += 30 * MINUTE;
    s.tick();
    clock += 45 * MINUTE; // now 19:15, crossed into the next bucket
    s.tick();

    const buckets = s.snapshotAndReset();
    expect(buckets).toHaveLength(2);
    expect(buckets[0].bucketStartMs).toBe(hourBucket(Date.UTC(2026, 7, 8, 18, 0, 0)));
    expect(buckets[1].bucketStartMs).toBe(hourBucket(Date.UTC(2026, 7, 8, 19, 0, 0)));
    // The start belongs to the bucket it happened in.
    expect(buckets[0].appStarts).toBe(1);
    expect(buckets[1].appStarts).toBe(0);
  });

  it('uses UTC buckets, so a DST transition cannot produce a 25-hour hour', () => {
    // 2026-10-25 is the European DST fallback. In local time 02:00 happens twice; in UTC it does
    // not exist as an ambiguity at all, which is the entire reason for the choice.
    const s = createSession();
    clock = Date.UTC(2026, 9, 25, 0, 30, 0);
    s.started();
    clock = Date.UTC(2026, 9, 25, 1, 30, 0);
    s.tick();

    const buckets = s.snapshotAndReset();
    const widths = buckets.map((b) => b.bucketStartMs);
    expect(new Set(widths).size).toBe(widths.length); // no duplicated bucket
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i] - widths[i - 1]).toBe(HOUR);
    }
  });

  it('records a clean shutdown and closes any open foreground span', () => {
    const s = createSession();
    s.started();
    s.foregroundStarted();
    clock += 20 * SECOND;
    s.cleanShutdown();

    const [b] = s.snapshotAndReset();
    expect(b.cleanShutdowns).toBe(1);
    expect(b.foregroundSeconds).toBe(20);
  });

  it('omits buckets in which nothing happened', () => {
    const s = createSession();
    expect(s.snapshotAndReset()).toEqual([]);
  });

  it('keeps a partial hour accumulating after a snapshot', () => {
    // The receiver sums records sharing a bucketStartMs, so a split hour must arrive as two
    // partial records that add up — not as one that replaces the other.
    const s = createSession();
    s.started();
    clock += 20 * SECOND;
    const first = s.snapshotAndReset();
    clock += 20 * SECOND;
    s.tick();
    const second = s.snapshotAndReset();

    expect(first[0].bucketStartMs).toBe(second[0].bucketStartMs);
    expect(first[0].runningSeconds + second[0].runningSeconds).toBe(40);
  });
});

describe('installation identity', () => {
  it('generates a 128-bit hex id and reuses it', () => {
    const first = loadInstallationId(dir);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(loadInstallationId(dir)).toBe(first);
  });

  it('writes the id file readable only by its owner', () => {
    loadInstallationId(dir);
    const mode = statSync(join(dir, 'install.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('is not derived from anything about the machine', () => {
    // Two installations in different directories must not collide. A derived id would.
    const other = mkdtempSync(join(tmpdir(), 'telemetry-install-b-'));
    try {
      expect(loadInstallationId(dir)).not.toBe(loadInstallationId(other));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('regenerates rather than throwing when the id file is corrupt', () => {
    writeFileSync(join(dir, 'install.json'), 'not json at all');
    const warnings = [];
    expect(loadInstallationId(dir, (m) => warnings.push(m))).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects an id that is not the right shape', () => {
    writeFileSync(join(dir, 'install.json'), JSON.stringify({ v: 1, id: 'nope' }));
    expect(loadInstallationId(dir)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('unclean exit detection', () => {
  it('reports nothing after a clean shutdown', () => {
    markSessionStart(dir);
    markSessionEnd(dir);
    expect(takeUncleanExit(dir)).toBeNull();
  });

  it('reports the previous start time when the sentinel survived', () => {
    markSessionStart(dir);
    const startedAt = clock;
    clock += HOUR; // process was killed somewhere in here

    expect(takeUncleanExit(dir)).toBe(startedAt);
  });

  it('consumes the sentinel, so one crash is not reported forever', () => {
    markSessionStart(dir);
    expect(takeUncleanExit(dir)).not.toBeNull();
    expect(takeUncleanExit(dir)).toBeNull();
    expect(existsSync(join(dir, 'session.json'))).toBe(false);
  });

  it('reports nothing on a first run', () => {
    expect(takeUncleanExit(dir)).toBeNull();
  });
});

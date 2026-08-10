/**
 * The local telemetry queue.
 *
 * Worth testing hard because every one of its failure modes is silent. A queue that evicts the
 * wrong thing still works; it just means the crash report you needed was deleted to make room for
 * a counter. A queue that loses records on compaction still works; it just means the numbers read
 * low forever. Nothing here throws in production — the whole module is wrapped in a latch that
 * disables it rather than letting it break the app — so the tests are the only place these
 * invariants are ever checked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSpool, PRIORITIES } from '../../electron/telemetry/spool.mjs';
import { resetNow, setNow } from '../../electron/telemetry/clock.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let dir;
let clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telemetry-spool-'));
  clock = 1_754_650_000_000;
  setNow(() => clock);
});

afterEach(() => {
  resetNow();
  rmSync(dir, { recursive: true, force: true });
});

const spool = (overrides = {}) => createSpool({ dir, ...overrides });

describe('append and read', () => {
  it('returns records in priority order, oldest first', () => {
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    clock += 1000;
    s.append('crash', 'crash', { type: 'TypeError' });
    clock += 1000;
    s.append('failure', 'op', { op: 1 });
    clock += 1000;
    s.append('usage', 'counters', { a: 2 });

    // Crashes first — they are what a send cycle should get out of the door before anything else.
    expect(s.readAll().map((r) => r.priority)).toEqual(['crash', 'failure', 'usage', 'usage']);
    expect(s.readAll().filter((r) => r.priority === 'usage').map((r) => r.body.a)).toEqual([1, 2]);
  });

  it('rejects an unknown priority loudly', () => {
    // A typo here would silently write a file nobody ever reads.
    expect(() => spool().append('important', 'k', {})).toThrow(/unknown priority/);
  });

  it('survives a torn final line from a crash mid-append', () => {
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    // Simulate the process dying halfway through writing the next record.
    appendFileSync(join(dir, 'usage.ndjson'), '{"v":1,"p":2,"at":175465000');

    const all = s.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].body.a).toBe(1);
  });

  it('skips records written by a future version rather than rejecting the file', () => {
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    appendFileSync(join(dir, 'usage.ndjson'), `${JSON.stringify({ v: 99, at: clock, body: {} })}\n`);
    s.append('usage', 'counters', { a: 2 });

    expect(s.readAll().map((r) => r.body.a)).toEqual([1, 2]);
  });
});

describe('age retention', () => {
  it('drops records past the retention window and counts them', () => {
    const s = spool();
    s.append('usage', 'counters', { old: true });
    clock += 8 * DAY;
    s.append('usage', 'counters', { fresh: true });

    expect(s.evict()).toBe(1);
    expect(s.readAll().map((r) => r.body)).toEqual([{ fresh: true }]);
    expect(s.droppedCount()).toBe(1);
  });

  it('applies the age cut to crashes too', () => {
    // Crashes are protected from *size* eviction, not from expiry. A three-week-old crash from a
    // version nobody runs is not worth the bytes.
    const s = spool();
    s.append('crash', 'crash', { type: 'Old' });
    clock += 8 * DAY;
    expect(s.evict()).toBe(1);
    expect(s.readAll()).toHaveLength(0);
  });
});

describe('size eviction', () => {
  it('evicts the oldest usage records when the cap is exceeded', () => {
    const s = spool({ caps: { crash: 1024, failure: 1024, usage: 512 } });
    for (let i = 0; i < 40; i++) {
      s.append('usage', 'counters', { i, pad: 'x'.repeat(40) });
      clock += 1000;
    }

    const remaining = s.readAll();
    expect(remaining.length).toBeLessThan(40);
    // The oldest went, the newest stayed.
    expect(remaining.at(-1).body.i).toBe(39);
    expect(remaining[0].body.i).toBeGreaterThan(0);
    expect(s.droppedCount()).toBeGreaterThan(0);
  });

  it('never evicts a crash to make room for usage', () => {
    // The invariant the whole three-file split exists for.
    const s = spool({ caps: { crash: 4096, failure: 4096, usage: 256 } });
    s.append('crash', 'crash', { type: 'TypeError', fp: 'abc' });

    for (let i = 0; i < 200; i++) {
      s.append('usage', 'counters', { i, pad: 'y'.repeat(60) });
      clock += 1000;
    }

    const crashes = s.readAll().filter((r) => r.priority === 'crash');
    expect(crashes).toHaveLength(1);
    expect(crashes[0].body.type).toBe('TypeError');
  });

  it('keeps a floor of crashes even when the crash file is over its cap', () => {
    // A crash loop must not delete the evidence of the crashes that preceded it.
    const s = spool({ caps: { crash: 256, failure: 4096, usage: 4096 }, crashFloor: 5 });
    for (let i = 0; i < 30; i++) {
      s.append('crash', 'crash', { i, pad: 'z'.repeat(50) });
      clock += 1000;
    }

    const crashes = s.readAll().filter((r) => r.priority === 'crash');
    expect(crashes).toHaveLength(5);
    // The floor keeps the *newest*, which is what a fingerprint drill-down wants.
    expect(crashes.at(-1).body.i).toBe(29);
  });
});

describe('acknowledgement and compaction', () => {
  it('removes exactly the acknowledged records', () => {
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    clock += 1000;
    s.append('usage', 'counters', { a: 2 });
    clock += 1000;
    s.append('crash', 'crash', { a: 3 });

    const all = s.readAll();
    s.ack(all.filter((r) => r.priority === 'usage'));

    expect(s.readAll().map((r) => r.body.a)).toEqual([3]);
  });

  it('does not delete a record appended after the read', () => {
    // The race that a count-based ack ("drop the first N") would lose silently.
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    const inFlight = s.readAll();

    clock += 1000;
    s.append('usage', 'counters', { a: 2 }); // arrives while the send is in progress

    s.ack(inFlight);

    expect(s.readAll().map((r) => r.body.a)).toEqual([2]);
  });

  it('leaves the queue byte-identical when a send fails', () => {
    // At-least-once depends on this: a failed publish must change nothing.
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    s.append('crash', 'crash', { a: 2 });

    const before = PRIORITIES.map((p) => readFileOrEmpty(join(dir, `${p}.ndjson`)));
    s.readAll(); // read, then "fail" — no ack
    const after = PRIORITIES.map((p) => readFileOrEmpty(join(dir, `${p}.ndjson`)));

    expect(after).toEqual(before);
  });

  it('leaves no temporary file behind after compaction', () => {
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    s.ack(s.readAll());
    expect(readFileOrEmpty(join(dir, 'usage.ndjson.tmp'))).toBe('');
  });
});

describe('failure containment', () => {
  it('disables itself rather than throwing when the directory is unusable', () => {
    // Nothing in the app awaits a telemetry call, so the only acceptable behaviour on a broken
    // disk is to go quiet. A throw here would surface inside whatever feature was being recorded.
    const warnings = [];
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'x');

    const s = createSpool({ dir: join(file, 'nested'), onWarn: (m) => warnings.push(m) });

    expect(s.isDisabled()).toBe(true);
    expect(() => s.append('usage', 'counters', { a: 1 })).not.toThrow();
    expect(s.append('usage', 'counters', { a: 1 })).toBe(false);
    expect(s.readAll()).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('reports stats without reading the whole queue into the caller', () => {
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    s.append('crash', 'crash', { a: 2 });

    const stats = s.stats();
    expect(stats.files.usage.records).toBe(1);
    expect(stats.files.crash.records).toBe(1);
    expect(stats.files.usage.bytes).toBeGreaterThan(0);
    expect(stats.files.failure.bytes).toBe(0);
    expect(stats.disabled).toBe(false);
  });
});

describe('dropped accounting', () => {
  it('carries a count forward until cleared', () => {
    // Gaps in the server-side data must arrive as a number, not as silence.
    const s = spool();
    s.append('usage', 'counters', { a: 1 });
    clock += 8 * DAY;
    s.evict();

    expect(s.droppedCount()).toBe(1);
    s.clearDropped();
    expect(s.droppedCount()).toBe(0);
  });
});

function readFileOrEmpty(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

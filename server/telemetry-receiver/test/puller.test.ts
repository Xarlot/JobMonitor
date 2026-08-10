/**
 * The scheduled ingest.
 *
 * The failure this design can have is different from the one the persistent subscriber had, and
 * worse: a subscriber that fell over produced a visible gap and could be restarted. Here, if the
 * interval ever exceeds Ably's retention, the messages published in between **expire unread**. They
 * are not delayed, not duplicated, not recoverable — and nothing reports it, because the charts can
 * only ever show what arrived.
 *
 * So the tests that matter most are about the schedule fitting inside the retention window, and
 * about the cursor never advancing past work that was not done.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { database, resetDatabase } from '../src/lib/db';
import { assertScheduleFitsRetention, lastRun } from '../src/receiver/puller';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'puller-'));
  process.env.TELEMETRY_DB = join(dir, 'telemetry.db');
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
  delete process.env.TELEMETRY_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe('the schedule must fit inside Ably retention', () => {
  it('accepts three runs a day against the free tier', () => {
    // 8h x 3 = 24h exactly. This is the configuration we ship: two consecutive failures survive,
    // the third does not. Accepted deliberately, and the reason /health shows the live margin.
    expect(() => assertScheduleFitsRetention(8, 24)).not.toThrow();
  });

  it('rejects a schedule that could not survive two failures', () => {
    // 12h x 3 = 36h > 24h. One missed run and the next window is already past expiry.
    expect(() => assertScheduleFitsRetention(12, 24)).toThrow(/lose data permanently/);
  });

  it('rejects daily runs outright', () => {
    expect(() => assertScheduleFitsRetention(24, 24)).toThrow(/lose data permanently/);
  });

  it('allows a longer interval when retention is longer', () => {
    // Standard tier. The same 8h schedule then tolerates eight consecutive failures.
    expect(() => assertScheduleFitsRetention(8, 72)).not.toThrow();
    expect(() => assertScheduleFitsRetention(24, 72)).not.toThrow();
  });

  it('names the interval that would be safe', () => {
    // An error that says only "wrong" makes the reader do arithmetic during an incident.
    expect(() => assertScheduleFitsRetention(12, 24)).toThrow(/interval <= 8\.0h/);
  });
});

describe('run history', () => {
  it('records nothing before the first run', () => {
    expect(lastRun(database())).toBeUndefined();
  });

  it('reports the most recent run', () => {
    const db = database();
    db.prepare(
      `INSERT INTO ingest_runs (ts, ok, messages, accepted, duplicates, rejected, duration_ms, error)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(1000, 1, 5, 4, 1, 0, 120, null);
    db.prepare(
      `INSERT INTO ingest_runs (ts, ok, messages, accepted, duplicates, rejected, duration_ms, error)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(2000, 0, 0, 0, 0, 0, 50, 'ably unreachable');

    const last = lastRun(db);
    expect(last?.ts).toBe(2000);
    expect(last?.ok).toBe(0);
    // The reason is kept: "the last run failed" without saying why is an alert nobody can act on.
    expect(last?.error).toBe('ably unreachable');
  });
});

describe('the cursor', () => {
  it('starts empty, so the first run reads the whole retention window', () => {
    const row = database().prepare('SELECT * FROM ingest_cursor WHERE id = 1').get();
    expect(row).toBeUndefined();
  });

  it('holds exactly one row', () => {
    // A second cursor would mean two readers disagreeing about what has been processed.
    const db = database();
    db.prepare('INSERT INTO ingest_cursor (id, last_ts, last_id) VALUES (1, 100, NULL)').run();
    expect(() =>
      db.prepare('INSERT INTO ingest_cursor (id, last_ts, last_id) VALUES (2, 200, NULL)').run(),
    ).toThrow();
  });
});

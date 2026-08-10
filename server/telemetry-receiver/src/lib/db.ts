/**
 * SQLite storage.
 *
 * **Why SQLite is defensible here, having argued against it on the client.** The reasoning is not
 * symmetrical. On the client the queue was write-only, single-reader, under a megabyte, and read
 * in exactly one order — a database bought nothing. Here the whole point is *querying*: distinct
 * counts over ranges, group-by, joins between crashes and usage. That is what SQL is for, and the
 * yearly volume (well under a gigabyte) sits comfortably inside what one file handles.
 *
 * **The Azure Files constraint.** App Service persists `/home` on SMB, and SQLite over SMB is
 * genuinely fragile — but the fragility is about *concurrency*, and ours is close to zero: roughly
 * 1,200 writes a day from a single process. Two settings make it safe, and both are load-bearing:
 *
 *   - `journal_mode = DELETE`, never WAL. WAL needs shared-memory coordination that SMB does not
 *     provide, and the failure is corruption rather than an error.
 *   - **Exactly one instance.** Scale-out must be disabled on the App Service plan, not merely
 *     left unconfigured — two writers over SMB is the case that breaks.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db: DatabaseSync | null = null;

export function database(): DatabaseSync {
  if (db) return db;

  // The default depends on where this is running, and that is deliberate rather than convenient.
  // `/home` is App Service's persistent mount and does not exist anywhere else, so a development
  // machine without TELEMETRY_DB used to fail with `EACCES: mkdir '/home/data'` — an error that
  // says nothing about the actual problem. `npm run dev` should work in a fresh checkout with no
  // configuration at all, and the production path should never be a silent fallback in dev.
  const file =
    process.env.TELEMETRY_DB ??
    (process.env.NODE_ENV === 'production' ? '/home/data/telemetry.db' : './.data/telemetry.db');
  mkdirSync(dirname(file), { recursive: true });

  db = new DatabaseSync(file);

  // DELETE rather than WAL — see the module header. This is not a performance choice.
  db.exec('PRAGMA journal_mode = DELETE');
  // Durability over speed. At ~1,200 writes a day the cost is invisible, and the alternative is
  // losing the last batches to a container restart.
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  // A write is never contended by design, but a stray reader mid-query should wait rather than
  // fail — a dashboard request must not be able to make an ingest fail.
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  return db;
}

function migrate(d: DatabaseSync) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  `);
  const row = d.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;

  if (row === undefined) {
    d.exec(`
      -- Batches already processed. The reason a resend can never double-count, and the reason
      -- BACKFILL_SECONDS must never exceed this table's retention.
      CREATE TABLE processed_batches (
        batch_id     TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );
      CREATE INDEX idx_processed_at ON processed_batches(processed_at);

      -- One row per feature / operation / usage record. Flat on purpose: every dashboard query is
      -- an aggregate over a time range, and a flat table with the right indexes answers all of
      -- them without a join.
      CREATE TABLE usage (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,          -- ms, period_end or the usage bucket
        installation  TEXT    NOT NULL,
        app_version   TEXT    NOT NULL,
        platform      INTEGER NOT NULL,
        arch          INTEGER NOT NULL,
        record_type   TEXT    NOT NULL,          -- feature | operation | usage
        feature_id    INTEGER,
        feature_key   TEXT,                      -- denormalised at ingest: numeric ids alone make
        operation_id  INTEGER,                   -- a dashboard unreadable
        operation_key TEXT,
        count         INTEGER NOT NULL DEFAULT 0,
        app_starts    INTEGER NOT NULL DEFAULT 0,
        session_count INTEGER NOT NULL DEFAULT 0,
        foreground_s  INTEGER NOT NULL DEFAULT 0,
        running_s     INTEGER NOT NULL DEFAULT 0,
        clean_exits   INTEGER NOT NULL DEFAULT 0,
        unclean_exits INTEGER NOT NULL DEFAULT 0,
        dur_count     INTEGER NOT NULL DEFAULT 0,
        dur_sum_ms    INTEGER NOT NULL DEFAULT 0,
        dur_max_ms    INTEGER NOT NULL DEFAULT 0,
        b0 INTEGER NOT NULL DEFAULT 0, b1 INTEGER NOT NULL DEFAULT 0,
        b2 INTEGER NOT NULL DEFAULT 0, b3 INTEGER NOT NULL DEFAULT 0,
        b4 INTEGER NOT NULL DEFAULT 0, b5 INTEGER NOT NULL DEFAULT 0,
        b6 INTEGER NOT NULL DEFAULT 0, b7 INTEGER NOT NULL DEFAULT 0,
        batch_id      TEXT    NOT NULL,
        received_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_usage_ts ON usage(ts);
      CREATE INDEX idx_usage_type_ts ON usage(record_type, ts);
      CREATE INDEX idx_usage_install ON usage(installation, ts);
      CREATE INDEX idx_usage_feature ON usage(feature_key, ts);

      -- Failures are counted per operation per error category.
      CREATE TABLE failures (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        ts             INTEGER NOT NULL,
        installation   TEXT    NOT NULL,
        app_version    TEXT    NOT NULL,
        operation_id   INTEGER NOT NULL,
        operation_key  TEXT    NOT NULL,
        error_category INTEGER NOT NULL,
        error_key      TEXT    NOT NULL,
        count          INTEGER NOT NULL,
        batch_id       TEXT    NOT NULL
      );
      CREATE INDEX idx_failures_ts ON failures(ts);

      -- Separate from usage: stack traces are large and no ordinary product query should scan
      -- them. This is the same reason the original design used two streams.
      CREATE TABLE crashes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        ts             INTEGER NOT NULL,
        installation   TEXT    NOT NULL,
        app_version    TEXT    NOT NULL,
        source         INTEGER NOT NULL,
        exception_type TEXT    NOT NULL,
        fingerprint    TEXT    NOT NULL,
        stack          TEXT    NOT NULL,
        stack_redacted INTEGER NOT NULL DEFAULT 0,
        count          INTEGER NOT NULL,
        batch_id       TEXT    NOT NULL,
        received_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_crashes_ts ON crashes(ts);
      CREATE INDEX idx_crashes_fp ON crashes(fingerprint, ts);

      -- How far through Ably's history we have read.
      --
      -- A single row. This is the whole state that makes on-demand ingest work: each run reads from
      -- here forwards, so a run that never happened costs nothing beyond delay, and a run that
      -- crashed midway simply re-reads the same slice next time.
      CREATE TABLE ingest_cursor (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        last_ts INTEGER NOT NULL,
        last_id TEXT
      );

      -- Every ingest run, successful or not.
      --
      -- Replaces the per-minute heartbeat the persistent subscriber used to write. With no
      -- long-lived process there is nothing to have a pulse, and "when did a run last succeed" is
      -- the better question regardless: it survives restarts, and it cannot be answered wrongly by
      -- a process that is running but wedged.
      CREATE TABLE ingest_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        ok          INTEGER NOT NULL,
        messages    INTEGER NOT NULL,
        accepted    INTEGER NOT NULL,
        duplicates  INTEGER NOT NULL,
        rejected    INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        error       TEXT
      );
      CREATE INDEX idx_ingest_runs_ts ON ingest_runs(ts);

      -- Which feature followed which, aggregated at ingest.
      --
      -- The client sends an ordered trail per bucket; this stores the consecutive pairs from it
      -- rather than the raw events. Two reasons. The map only ever asks "what follows what", so the
      -- pairs are the answer and the events are working material; and a trail of 256 events becomes
      -- at most a couple of dozen distinct pairs, which is the difference between a table that
      -- grows with how hard people use the app and one that grows with how many things they do.
      CREATE TABLE feature_transitions (
        day          INTEGER NOT NULL,          -- UTC midnight of the bucket the pair happened in
        installation TEXT    NOT NULL,
        from_id      INTEGER NOT NULL,
        to_id        INTEGER NOT NULL,
        n            INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, installation, from_id, to_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_transitions_day ON feature_transitions(day);

      -- Why a batch was rejected, by rule. How a client bug is discovered.
      CREATE TABLE rejections (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        rule      TEXT    NOT NULL,
        field     TEXT,
        batch_id  TEXT
      );
      CREATE INDEX idx_rejections_ts ON rejections(ts);

      -- Per-installation rate limiting, persisted so a restart does not reset the window.
      CREATE TABLE rate_buckets (
        installation TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count        INTEGER NOT NULL
      );

      INSERT INTO schema_version (version) VALUES (2);
    `);
    return;
  }

  /*
   * Upgrades, smallest thing that works.
   *
   * There is one database, one writer and one operator, so this is a version number and a switch
   * rather than a migration framework. What it must not be is absent: the create block above only
   * runs on an empty file, so a table added there and nowhere else exists on a developer's fresh
   * database and is missing on the deployed one — which fails at the first query, in production,
   * with the schema looking correct in the source.
   */
  if (row.version < 2) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS feature_transitions (
        day          INTEGER NOT NULL,
        installation TEXT    NOT NULL,
        from_id      INTEGER NOT NULL,
        to_id        INTEGER NOT NULL,
        n            INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, installation, from_id, to_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_transitions_day ON feature_transitions(day);
      UPDATE schema_version SET version = 2;
    `);
  }
}

/** Tests: point at a fresh file and drop the cached handle. */
export function resetDatabase(): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
}

/**
 * The dashboard queries.
 *
 * This is where the real work of the dashboard lives — rendering a chart is the easy half. Three
 * of these answer questions that could *not* be expressed as a single-stream query in the original
 * design and needed a nightly rollup job to precompute; with SQL over one database they are
 * ordinary queries, which is the main thing the change of storage bought us.
 *
 * Everything is aggregate. No query returns a row per installation, and nothing joins telemetry to
 * anything that could identify a person, because there is nothing to join it to.
 */

import { database } from './db';
import { bucketMs } from './range';
import { FEATURE_DEFS } from '@jobmonitor/telemetry-schema/registry';

const DAY = 86_400_000;

export interface Range {
  from: number;
  to: number;
}

/**
 * Time-series queries bucket by whatever `bucketMs` says rather than always by day.
 *
 * A day-bucketed 24-hour range is two points, which is not a chart — it is a line segment between
 * yesterday and today that hides the whole shape of the incident someone opened the page to look
 * at. The width is derived from the range rather than passed in so a caller cannot select a range
 * and a contradicting bucket.
 */

/**
 * The bucket width, bound as a **BigInt** so SQLite does integer division.
 *
 * `node:sqlite` binds a JS number as REAL — every JS number is a double — so `ts / ?` is
 * floating-point division and `(ts / ?) * ?` returns `ts` back unchanged. The bucketing silently
 * does nothing and the chart plots raw timestamps, which looks entirely plausible: the right number
 * of points, in the right order, grouped by nothing. The literal `86400000` avoids this only
 * because SQLite's parser reads it as an INTEGER; a bound parameter gets no such treatment.
 *
 * Binding a BigInt makes the parameter an INTEGER and restores the integer division.
 */
const bucket = (range: Range) => BigInt(bucketMs(range));

export function lastDays(days: number, now = Date.now()): Range {
  return { from: now - days * DAY, to: now };
}

/** DAU / WAU / MAU. An "active installation" is a distinct installation id, never a person. */
export function activeInstallations(now = Date.now()) {
  const db = database();
  const count = (days: number) =>
    (
      db
        .prepare('SELECT COUNT(DISTINCT installation) AS n FROM usage WHERE ts >= ?')
        .get(now - days * DAY) as { n: number }
    ).n;
  return { dau: count(1), wau: count(7), mau: count(30) };
}

/** Distinct installations per day. */
export function activeByDay(range: Range) {
  return database()
    .prepare(
      `SELECT (ts / ?) * ? AS day, COUNT(DISTINCT installation) AS installs
       FROM usage WHERE ts BETWEEN ? AND ?
       GROUP BY day ORDER BY day`,
    )
    .all(bucket(range), bucket(range), range.from, range.to) as { day: number; installs: number }[];
}

export function versionSpread(range: Range) {
  return database()
    .prepare(
      `SELECT app_version, COUNT(DISTINCT installation) AS installs
       FROM usage WHERE ts BETWEEN ? AND ?
       GROUP BY app_version ORDER BY installs DESC`,
    )
    .all(range.from, range.to) as { app_version: string; installs: number }[];
}

export function sessionTotals(range: Range) {
  return database()
    .prepare(
      `SELECT (ts / ?) * ? AS day,
              SUM(app_starts)   AS starts,
              SUM(session_count) AS sessions,
              SUM(foreground_s) AS foreground,
              SUM(running_s)    AS running
       FROM usage WHERE record_type = 'usage' AND ts BETWEEN ? AND ?
       GROUP BY day ORDER BY day`,
    )
    .all(bucket(range), bucket(range), range.from, range.to) as {
    day: number;
    starts: number;
    sessions: number;
    foreground: number;
    running: number;
  }[];
}

/**
 * Feature adoption, including **features nobody used**.
 *
 * The zero rows are the point. A feature with no usage produces no rows at all, so a query over
 * the data alone can only ever show what *was* used — and "which features is nobody touching" is
 * the question that actually informs what to remove. The registry supplies the full list; the
 * database supplies the counts; the left join is what makes the absent ones visible.
 */
export function featureAdoption(range: Range) {
  const db = database();
  const activeInstalls = (
    db
      .prepare('SELECT COUNT(DISTINCT installation) AS n FROM usage WHERE ts BETWEEN ? AND ?')
      .get(range.from, range.to) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT feature_key, SUM(count) AS uses, COUNT(DISTINCT installation) AS installs
       FROM usage WHERE record_type = 'feature' AND ts BETWEEN ? AND ?
       GROUP BY feature_key`,
    )
    .all(range.from, range.to) as { feature_key: string; uses: number; installs: number }[];

  const byKey = new Map(rows.map((r) => [r.feature_key, r]));

  return Object.values(FEATURE_DEFS)
    .map((def) => {
      const row = byKey.get(def.key);
      return {
        key: def.key,
        uses: row?.uses ?? 0,
        installs: row?.installs ?? 0,
        pctOfActive: activeInstalls > 0 ? ((row?.installs ?? 0) / activeInstalls) * 100 : 0,
      };
    })
    .sort((a, b) => b.uses - a.uses);
}

/**
 * Operation timings.
 *
 * Reported as "share under a threshold", never as a percentile. Eight buckets cannot produce a
 * true p95 and claiming one would be a fabricated number on a page people make decisions from.
 */
export function operationTimings(range: Range) {
  return database()
    .prepare(
      `SELECT operation_key,
              SUM(dur_count)  AS n,
              SUM(dur_sum_ms) AS total_ms,
              MAX(dur_max_ms) AS max_ms,
              SUM(b0+b1)      AS under_100,
              SUM(b0+b1+b2+b3) AS under_500,
              SUM(b0+b1+b2+b3+b4+b5) AS under_2s,
              SUM(b7)         AS over_5s
       FROM usage WHERE record_type = 'operation' AND ts BETWEEN ? AND ?
       GROUP BY operation_key HAVING n > 0 ORDER BY n DESC`,
    )
    .all(range.from, range.to) as {
    operation_key: string;
    n: number;
    total_ms: number;
    max_ms: number;
    under_100: number;
    under_500: number;
    under_2s: number;
    over_5s: number;
  }[];
}

export function failureBreakdown(range: Range) {
  return database()
    .prepare(
      `SELECT operation_key, error_key, SUM(count) AS n
       FROM failures WHERE ts BETWEEN ? AND ?
       GROUP BY operation_key, error_key ORDER BY n DESC LIMIT 50`,
    )
    .all(range.from, range.to) as { operation_key: string; error_key: string; n: number }[];
}

/**
 * Crash-free installations, per day.
 *
 * The headline reliability metric, and the one that needed a precomputed rollup before: it is a
 * ratio between two different populations — installations that reported anything, and those that
 * reported a crash. One SQL statement with two subqueries now.
 */
export function crashFreeByDay(range: Range) {
  return database()
    .prepare(
      `WITH days AS (
         SELECT DISTINCT (ts / :bucket) * :bucket AS day FROM usage WHERE ts BETWEEN :from AND :to
       )
       SELECT d.day,
              (SELECT COUNT(DISTINCT installation) FROM usage
                WHERE ts >= d.day AND ts < d.day + :bucket) AS active,
              (SELECT COUNT(DISTINCT installation) FROM crashes
                WHERE ts >= d.day AND ts < d.day + :bucket) AS crashed
       FROM days d ORDER BY d.day`,
    )
    .all({ bucket: bucket(range), from: range.from, to: range.to }) as { day: number; active: number; crashed: number }[];
}

export function crashesByDay(range: Range) {
  const rows = database()
    .prepare(
      `SELECT (ts / ?) * ? AS day, SUM(count) AS crashes,
              COUNT(DISTINCT installation) AS installs
       FROM crashes WHERE ts BETWEEN ? AND ?
       GROUP BY day ORDER BY day`,
    )
    .all(bucket(range), bucket(range), range.from, range.to) as { day: number; crashes: number; installs: number }[];

  // Zero-filled, and that is a correctness matter rather than a cosmetic one. A day with no
  // crashes produces no row, so plotting the rows alone draws a line through only the days
  // something broke — five scattered crashes become a flat line implying one every day. A day
  // without crashes genuinely had zero of them, and the chart should say so.
  return fillDays(rows, range, (day) => ({ day, crashes: 0, installs: 0 }));
}

/** Insert an explicit zero for every day in the range that produced no row. */
function fillDays<T extends { day: number }>(rows: T[], range: Range, zero: (day: number) => T): T[] {
  const bucket = bucketMs(range);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const first = Math.floor(range.from / bucket) * bucket;
  const last = Math.floor(range.to / bucket) * bucket;
  const out: T[] = [];
  for (let day = first; day <= last; day += bucket) out.push(byDay.get(day) ?? zero(day));
  return out;
}

/**
 * Top crash fingerprints.
 *
 * `first_seen` is computed over **all time**, deliberately not over the selected range. Scoping it
 * to the range is the obvious way to write this and it produces a wrong answer that looks right:
 * every old fingerprint appears "new" the moment you narrow the window, which makes the
 * "regressions since the release" view pure noise.
 */
export function topFingerprints(range: Range, limit = 25) {
  return database()
    .prepare(
      `SELECT c.fingerprint, c.exception_type,
              SUM(c.count) AS occurrences,
              COUNT(DISTINCT c.installation) AS installs,
              MAX(c.ts) AS last_seen,
              (SELECT MIN(ts) FROM crashes WHERE fingerprint = c.fingerprint) AS first_seen
       FROM crashes c WHERE c.ts BETWEEN ? AND ?
       GROUP BY c.fingerprint, c.exception_type
       ORDER BY occurrences DESC LIMIT ?`,
    )
    .all(range.from, range.to, limit) as {
    fingerprint: string;
    exception_type: string;
    occurrences: number;
    installs: number;
    first_seen: number;
    last_seen: number;
  }[];
}

/** One fingerprint in detail, for the drill-down. */
export function fingerprintDetail(fingerprint: string) {
  const db = database();
  const summary = db
    .prepare(
      `SELECT exception_type, SUM(count) AS occurrences, COUNT(DISTINCT installation) AS installs,
              MIN(ts) AS first_seen, MAX(ts) AS last_seen
       FROM crashes WHERE fingerprint = ? GROUP BY exception_type`,
    )
    .get(fingerprint) as
    | { exception_type: string; occurrences: number; installs: number; first_seen: number; last_seen: number }
    | undefined;

  const versions = db
    .prepare(
      `SELECT app_version, SUM(count) AS occurrences FROM crashes
       WHERE fingerprint = ? GROUP BY app_version ORDER BY app_version`,
    )
    .all(fingerprint) as { app_version: string; occurrences: number }[];

  /**
   * Distinct traces, not the most recent ones.
   *
   * A fingerprint is `sha256(type + top 5 normalized frames)`, so every record under it agrees on
   * those five frames by construction and can only differ below them. Listing the last five rows
   * therefore prints the same text five times in the common case — wasted space, and worse, it
   * implies a variety worth reading through that is not there.
   *
   * Grouping by the trace inverts that: five blocks now mean five genuinely different tails, and a
   * single block marked ×12 says plainly that there is one variant. The differing tail is the only
   * part of a trace worth looking at once the fingerprint is known.
   *
   * This is the only query in the application that reads a stack column, which is why crashes live
   * in their own table — no ordinary product query ever scans it.
   */
  const variants = db
    .prepare(
      `SELECT stack, stack_redacted,
              COUNT(*) AS occurrences,
              MIN(ts) AS first_seen,
              MAX(ts) AS last_seen,
              GROUP_CONCAT(DISTINCT app_version) AS versions
       FROM crashes WHERE fingerprint = ?
       GROUP BY stack, stack_redacted
       ORDER BY occurrences DESC LIMIT 5`,
    )
    .all(fingerprint) as {
    stack: string;
    stack_redacted: number;
    occurrences: number;
    first_seen: number;
    last_seen: number;
    versions: string;
  }[];

  // How many distinct traces exist in total, so a truncated list says so rather than implying it
  // showed everything.
  const { total } = db
    .prepare(
      'SELECT COUNT(*) AS total FROM (SELECT 1 FROM crashes WHERE fingerprint = ? GROUP BY stack)',
    )
    .get(fingerprint) as { total: number };

  return { summary, versions, variants, variantCount: total };
}

/** New fingerprints since a moment — the regression view after a release. */
export function newFingerprintsSince(since: number) {
  return database()
    .prepare(
      `SELECT fingerprint, exception_type, MIN(ts) AS first_seen, SUM(count) AS occurrences,
              COUNT(DISTINCT installation) AS installs
       FROM crashes GROUP BY fingerprint, exception_type
       HAVING first_seen >= ? ORDER BY first_seen DESC`,
    )
    .all(since) as {
    fingerprint: string;
    exception_type: string;
    first_seen: number;
    occurrences: number;
    installs: number;
  }[];
}

/**
 * Ingest health, and whether the data can be trusted to be complete.
 *
 * With no long-lived process there is no heartbeat to check, so the question becomes "when did a
 * run last succeed" — a better one anyway, since it survives restarts and cannot be answered
 * wrongly by a process that is running but wedged.
 *
 * The staleness threshold is deliberately *retention*, not the schedule interval: a late run is
 * merely late, but a gap wider than Ably's retention has destroyed data, and those two deserve very
 * different words on the page.
 */
export function ingestHealth() {
  const db = database();
  const retentionHours = Number(process.env.ABLY_RETENTION_HOURS ?? 24);
  const intervalHours = Number(process.env.INGEST_INTERVAL_HOURS ?? 8);

  const last = db.prepare('SELECT * FROM ingest_runs ORDER BY ts DESC LIMIT 1').get() as
    | { ts: number; ok: number; accepted: number; rejected: number; error: string | null }
    | undefined;

  const ageHours = last ? (Date.now() - last.ts) / 3_600_000 : Infinity;

  let stale = false;
  let reason = '';
  if (!last) {
    stale = true;
    reason = 'Ingest has never run.';
  } else if (ageHours > retentionHours) {
    stale = true;
    reason = `The last ingest was ${ageHours.toFixed(0)}h ago — beyond the retention window, so some telemetry has expired unread.`;
  } else if (ageHours > intervalHours * 2) {
    stale = true;
    reason = `The last ingest was ${ageHours.toFixed(0)}h ago; it should run every ${intervalHours}h.`;
  } else if (last.ok === 0) {
    stale = true;
    reason = `The last ingest failed: ${last.error ?? 'unknown error'}.`;
  }

  return { last, ageHours, stale, reason, retentionHours, intervalHours };
}

/** The last several runs, for the health page. */
export function recentRuns(limit = 20) {
  return database()
    .prepare('SELECT * FROM ingest_runs ORDER BY ts DESC LIMIT ?')
    .all(limit) as {
    ts: number;
    ok: number;
    messages: number;
    accepted: number;
    duplicates: number;
    rejected: number;
    duration_ms: number;
    error: string | null;
  }[];
}

/** Why batches were rejected, by rule. How a client bug is discovered. */
export function rejectionsByRule() {
  return database()
    .prepare(
      `SELECT rule, COUNT(*) AS n FROM rejections WHERE ts >= ?
       GROUP BY rule ORDER BY n DESC LIMIT 20`,
    )
    .all(Date.now() - 7 * DAY) as { rule: string; n: number }[];
}

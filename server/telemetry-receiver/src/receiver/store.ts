/**
 * Writing an accepted batch to storage, and the deduplication that makes retries safe.
 *
 * **The ordering trap.** The dedup row is inserted *after* the data is durably written, never
 * before. Inserting first is the natural way to write this and it is wrong: a crash in the window
 * between the two loses that batch permanently and silently, because it will be seen again on the
 * next backfill and immediately discarded as a duplicate. Writing first can at worst duplicate a
 * batch — and it cannot even do that, because the insert and the writes share one transaction.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TelemetryBatch } from '@jobmonitor/telemetry-schema';
import { Features, Operations, ErrorCategories } from '@jobmonitor/telemetry-schema/registry';

import {
  checkCrash,
  checkFeature,
  checkOperation,
  checkTrail,
  checkUsage,
  normaliseStack,
  type Rejection,
} from './privacy';

export interface WriteResult {
  accepted: boolean;
  duplicate?: boolean;
  records: number;
  dropped: Rejection[];
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function alreadyProcessed(db: DatabaseSync, batchId: string): boolean {
  return db.prepare('SELECT 1 FROM processed_batches WHERE batch_id = ?').get(batchId) !== undefined;
}

/**
 * Write one validated batch.
 *
 * Record-level validation happens here rather than earlier so that a dropped record is counted
 * against the batch that carried it — which is what makes the rejection dashboard able to point at
 * a specific client version.
 */
/**
 * How far apart two events may be and still count as one following the other.
 *
 * Five minutes: longer than any sequence of deliberate clicks, shorter than a break.
 */
const TRAIL_LINK_GAP_S = 300;

export function writeBatch(db: DatabaseSync, batch: TelemetryBatch, now: number): WriteResult {
  const batchId = hex(batch.batchId);
  if (alreadyProcessed(db, batchId)) {
    return { accepted: false, duplicate: true, records: 0, dropped: [] };
  }

  const installation = hex(batch.installationId);
  const dropped: Rejection[] = [];
  let records = 0;

  const periodEnd = Number(batch.periodEndMs);
  const common = {
    installation,
    appVersion: batch.appVersion,
    platform: batch.platform,
    arch: batch.arch,
    batchId,
  };

  // One transaction. Either the whole batch lands with its dedup row, or none of it does — which
  // is what makes "written then deduped" safe rather than merely likely.
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertUsage = db.prepare(`
      INSERT INTO usage (
        ts, installation, app_version, platform, arch, record_type,
        feature_id, feature_key, operation_id, operation_key, count,
        app_starts, session_count, foreground_s, running_s, clean_exits, unclean_exits,
        dur_count, dur_sum_ms, dur_max_ms, b0, b1, b2, b3, b4, b5, b6, b7,
        batch_id, received_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    /*
     * Trails become transitions here rather than on the dashboard.
     *
     * Doing it at ingest costs one pass over data already in memory and turns the map's query into
     * a plain grouped read. Doing it at query time would mean keeping every event and re-deriving
     * the pairs on every page load, over the one table that grows with how much people click.
     *
     * The gap rule: two events more than TRAIL_LINK_GAP_S apart are not a transition. Someone who
     * opens a failure, walks away, and comes back to the log an hour later did not go from one to
     * the other — and a bucket is an hour, so without this the quiet buckets would manufacture
     * long-range edges between whatever happened to bracket a break.
     */
    const insertTransition = db.prepare(`
      INSERT INTO feature_transitions (day, installation, from_id, to_id, n)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day, installation, from_id, to_id) DO UPDATE SET n = n + excluded.n
    `);
    for (const trail of batch.trails) {
      const check = checkTrail(trail);
      if (!check.ok) {
        dropped.push({ rule: check.rule, field: check.field });
        continue;
      }
      const day = (Number(trail.bucketStartMs) / 86_400_000) | 0;
      const dayMs = day * 86_400_000;
      for (let i = 1; i < trail.featureIds.length; i++) {
        if (trail.offsetDeltasS[i] > TRAIL_LINK_GAP_S) continue;
        const from = trail.featureIds[i - 1];
        const to = trail.featureIds[i];
        // A feature following itself is a repeat, not a move. Recording it would put a heavy loop
        // on every node of the map and say nothing.
        if (from === to) continue;
        insertTransition.run(dayMs, common.installation, from, to, 1);
      }
    }

    for (const f of batch.features) {
      const check = checkFeature(f);
      if (!check.ok) {
        dropped.push({ rule: check.rule, field: check.field });
        continue;
      }
      insertUsage.run(
        periodEnd, common.installation, common.appVersion, common.platform, common.arch,
        'feature', f.featureId, Features.keyOf(f.featureId), null, null, f.count,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        common.batchId, now,
      );
      records++;
    }

    const insertFailure = db.prepare(`
      INSERT INTO failures (ts, installation, app_version, operation_id, operation_key,
                            error_category, error_key, count, batch_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);

    for (const o of batch.operations) {
      const check = checkOperation(o);
      if (!check.ok) {
        dropped.push({ rule: check.rule, field: check.field });
        continue;
      }
      const key = Operations.keyOf(o.operationId);
      insertUsage.run(
        periodEnd, common.installation, common.appVersion, common.platform, common.arch,
        'operation', null, null, o.operationId, key, o.count,
        0, 0, 0, 0, 0, 0,
        o.count, Number(o.durationSumMs), o.durationMaxMs,
        o.buckets[0], o.buckets[1], o.buckets[2], o.buckets[3],
        o.buckets[4], o.buckets[5], o.buckets[6], o.buckets[7],
        common.batchId, now,
      );
      records++;

      for (const f of o.failures) {
        insertFailure.run(
          periodEnd, common.installation, common.appVersion, o.operationId, key,
          f.errorCategory, ErrorCategories.keyOf(f.errorCategory), f.count, common.batchId,
        );
      }
    }

    for (const u of batch.usage) {
      const check = checkUsage(u, now);
      if (!check.ok) {
        dropped.push({ rule: check.rule, field: check.field });
        continue;
      }
      // Timestamped at the bucket, not at period_end: a usage record describes a specific hour,
      // and filing it under the batch's end time would smear a night's activity onto one point.
      insertUsage.run(
        Number(u.bucketStartMs), common.installation, common.appVersion, common.platform,
        common.arch, 'usage', null, null, null, null, 0,
        u.appStarts, u.sessionCount, u.foregroundSeconds, u.runningSeconds,
        u.cleanShutdowns, u.uncleanExits,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        common.batchId, now,
      );
      records++;
    }

    const insertCrash = db.prepare(`
      INSERT INTO crashes (ts, installation, app_version, source, exception_type,
                           fingerprint, stack, stack_redacted, count, batch_id, received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const c of batch.crashes) {
      const stack = normaliseStack(c.stack);
      const check = checkCrash({ ...c, stack }, now);
      if (!check.ok) {
        dropped.push({ rule: check.rule ?? 'crash-invalid', field: check.field });
        continue;
      }
      // A trace that trips the deny scan costs the trace, not the record: the fingerprint, version
      // and count are what the reliability dashboards run on, and all of them are safe.
      const redacted = check.redactStack === true;
      if (redacted) dropped.push({ rule: check.rule ?? 'stack-redacted', field: 'stack' });

      insertCrash.run(
        Number(c.occurredAtMs), common.installation, c.appVersion, c.source, c.exceptionType,
        hex(c.fingerprint), redacted ? '' : stack, redacted ? 1 : 0, c.count, common.batchId, now,
      );
      records++;
    }

    // Last, inside the same transaction. See the module header.
    db.prepare('INSERT INTO processed_batches (batch_id, processed_at) VALUES (?, ?)').run(
      batchId,
      now,
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { accepted: true, records, dropped };
}

export function recordRejections(
  db: DatabaseSync,
  now: number,
  batchId: string | null,
  rejections: Rejection[],
): void {
  if (rejections.length === 0) return;
  const stmt = db.prepare('INSERT INTO rejections (ts, rule, field, batch_id) VALUES (?,?,?,?)');
  for (const r of rejections) stmt.run(now, r.rule, r.field ?? null, batchId);
}

/**
 * Rate limiting per installation, persisted so a restart does not reset the window.
 *
 * The real control on an accept-any sender model: without it, one holder of the extracted publish
 * key can flood the dashboards. Over-budget batches are counted and dropped, never processed.
 */
export function withinRateLimit(
  db: DatabaseSync,
  installation: string,
  now: number,
  perHour: number,
): boolean {
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  const row = db
    .prepare('SELECT window_start, count FROM rate_buckets WHERE installation = ?')
    .get(installation) as { window_start: number; count: number } | undefined;

  if (!row || row.window_start !== hourStart) {
    db.prepare(
      `INSERT INTO rate_buckets (installation, window_start, count) VALUES (?,?,1)
       ON CONFLICT(installation) DO UPDATE SET window_start = excluded.window_start, count = 1`,
    ).run(installation, hourStart);
    return true;
  }
  if (row.count >= perHour) return false;

  db.prepare('UPDATE rate_buckets SET count = count + 1 WHERE installation = ?').run(installation);
  return true;
}

/** Retention. Dedup rows expire; telemetry is kept for a year. */
export function pruneRetention(db: DatabaseSync, now: number, dedupDays: number): void {
  db.prepare('DELETE FROM processed_batches WHERE processed_at < ?').run(
    now - dedupDays * 86_400_000,
  );
  const yearAgo = now - 365 * 86_400_000;
  db.prepare('DELETE FROM usage WHERE ts < ?').run(yearAgo);
  db.prepare('DELETE FROM failures WHERE ts < ?').run(yearAgo);
  db.prepare('DELETE FROM crashes WHERE ts < ?').run(yearAgo);
  db.prepare('DELETE FROM rejections WHERE ts < ?').run(now - 30 * 86_400_000);
  db.prepare('DELETE FROM ingest_runs WHERE ts < ?').run(now - 90 * 86_400_000);
}

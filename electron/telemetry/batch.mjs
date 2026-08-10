/**
 * Spool records → one `TelemetryBatch`.
 *
 * The join between the durable queue and the wire format, and the place where the two different
 * shapes of aggregation meet:
 *
 *   - **Feature and operation counters are summed** across every spooled record. They are additive
 *     and nothing downstream asks which 15-minute window a count came from, so a batch covering
 *     four hours carries one entry per feature rather than sixteen.
 *   - **Usage summaries are merged by UTC hour bucket**, not summed into one. The hour is the unit
 *     the dashboards group by, so collapsing them would destroy the only time resolution the
 *     format has.
 *   - **Crashes are never merged.** Each is its own record with its own timestamp and version.
 */

import { create } from '@bufbuild/protobuf';
import {
  Arch,
  CrashSource,
  Platform,
  SCHEMA_VERSION,
  TelemetryBatchSchema,
} from '@jobmonitor/telemetry-schema';

import { DURATION_BUCKET_COUNT, ID_BYTES, MAX_TRAIL_EVENTS } from './constants.mjs';
import { randomBytes } from './random.mjs';

const PLATFORMS = { win32: Platform.WIN32, darwin: Platform.DARWIN, linux: Platform.LINUX };
const ARCHES = { x64: Arch.X64, arm64: Arch.ARM64 };

function hexToBytes(hex) {
  const clean = typeof hex === 'string' ? hex : '';
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Build a batch from spooled records.
 *
 * @param {object[]} records Spool records, as returned by `spool.readAll()`.
 * @param {object} context installationId, deploymentId, appVersion, platform, arch,
 *   electronVersion, droppedRecords.
 * @returns {{batch: object, batchIdHex: string}}
 */
export function buildBatch(records, context) {
  /** @type {Map<number, number>} */
  const features = new Map();
  /** @type {Map<number, object>} */
  const operations = new Map();
  /** @type {Map<number, object>} */
  const usage = new Map();
  const crashes = [];

  let periodStart = Number.POSITIVE_INFINITY;
  let periodEnd = 0;
  /** Bucket start → the merged trail for it. @type {Map<number, {featureIds:number[], offsetDeltasS:number[], truncated:boolean}>} */
  const trails = new Map();

  for (const record of records) {
    periodStart = Math.min(periodStart, record.at);
    periodEnd = Math.max(periodEnd, record.at);

    if (record.kind === 'counters') {
      mergeCounters(record.body, features, operations, usage, trails);
    } else if (record.kind === 'crash') {
      crashes.push(toCrashRecord(record.body));
    } else if (record.kind === 'unclean-exit') {
      // Synthesised rather than captured: by definition the process died before it could write
      // anything, so there is no stack and no type — only the fact and when it happened.
      crashes.push(
        toCrashRecord({
          occurredAtMs: record.body.occurredAtMs,
          appVersion: record.body.appVersion,
          source: CrashSource.UNCLEAN_EXIT,
          exceptionType: 'UncleanExit',
          fingerprint: '',
          stack: '',
          count: 1,
        }),
      );
    }
  }

  if (!Number.isFinite(periodStart)) periodStart = periodEnd;

  const batchId = randomBytes(ID_BYTES);
  const batch = create(TelemetryBatchSchema, {
    batchId,
    schemaVersion: SCHEMA_VERSION,
    installationId: hexToBytes(context.installationId),
    deploymentId: hexToBytes(context.deploymentId),
    appVersion: String(context.appVersion ?? ''),
    platform: PLATFORMS[context.platform] ?? Platform.UNSPECIFIED,
    arch: ARCHES[context.arch] ?? Arch.UNSPECIFIED,
    electronVersion: String(context.electronVersion ?? ''),
    periodStartMs: BigInt(Math.trunc(periodStart)),
    periodEndMs: BigInt(Math.trunc(periodEnd)),
    features: [...features.entries()].map(([featureId, count]) => ({ featureId, count })),
    operations: [...operations.values()],
    usage: [...usage.values()].sort((a, b) => Number(a.bucketStartMs - b.bucketStartMs)),
    trails: [...trails.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucketStartMs, trail]) => ({ bucketStartMs: BigInt(bucketStartMs), ...trail })),
    crashes,
    droppedRecords: context.droppedRecords ?? 0,
  });

  return { batch, batchIdHex: Buffer.from(batchId).toString('hex') };
}

function mergeCounters(body, features, operations, usage, trails) {
  for (const f of body?.features ?? []) {
    features.set(f.featureId, (features.get(f.featureId) ?? 0) + f.count);
  }

  /*
   * Trails for the same bucket are concatenated in the order the spool records were written, which
   * is the order they happened: a bucket is an hour and the spool flushes every fifteen minutes, so
   * one bucket routinely spans several records.
   *
   * The joining delta is deliberately left as recorded. Each record's first delta was measured from
   * the bucket start rather than from the previous record's last event, so a naive concatenation
   * would place the second record's first event too late. Recomputing it is not possible from here
   * — the absolute times are gone by design — so the seam is left alone and the receiver treats
   * offsets as monotonic-ish rather than exact. Ordering, which is what the map needs, survives
   * either way.
   */
  for (const tr of body?.trails ?? []) {
    const key = Number(tr.bucketStartMs);
    const existing = trails.get(key);
    if (!existing) {
      trails.set(key, {
        featureIds: [...(tr.featureIds ?? [])],
        offsetDeltasS: [...(tr.offsetDeltasS ?? [])],
        truncated: Boolean(tr.truncated),
      });
      continue;
    }
    /*
     * The cap has to be applied again here, not just per record.
     *
     * Each spool record capped itself at MAX_TRAIL_EVENTS, but a bucket is an hour and the spool
     * flushes four times an hour, so four capped fragments merge into four times the cap. Without
     * this the bound the wire format is sized against — and the bound on how much of a session one
     * batch can describe — is silently four times looser than it reads.
     */
    const room = MAX_TRAIL_EVENTS - existing.featureIds.length;
    const ids = tr.featureIds ?? [];
    if (room <= 0 || ids.length > room) existing.truncated = true;
    if (room > 0) {
      existing.featureIds.push(...ids.slice(0, room));
      existing.offsetDeltasS.push(...(tr.offsetDeltasS ?? []).slice(0, room));
    }
    existing.truncated = existing.truncated || Boolean(tr.truncated);
  }

  for (const o of body?.operations ?? []) {
    let entry = operations.get(o.operationId);
    if (!entry) {
      entry = {
        operationId: o.operationId,
        count: 0,
        durationSumMs: 0n,
        durationMaxMs: 0,
        buckets: new Array(DURATION_BUCKET_COUNT).fill(0),
        failures: [],
      };
      operations.set(o.operationId, entry);
    }
    entry.count += o.count ?? 0;
    entry.durationSumMs += BigInt(Math.trunc(o.durationSumMs ?? 0));
    entry.durationMaxMs = Math.max(entry.durationMaxMs, o.durationMaxMs ?? 0);
    for (let i = 0; i < DURATION_BUCKET_COUNT; i++) entry.buckets[i] += o.buckets?.[i] ?? 0;

    for (const f of o.failures ?? []) {
      const existing = entry.failures.find((x) => x.errorCategory === f.errorCategory);
      if (existing) existing.count += f.count;
      else entry.failures.push({ errorCategory: f.errorCategory, count: f.count });
    }
  }

  for (const u of body?.usage ?? []) {
    // Keyed by hour. Two records for the same hour — which happens whenever a flush lands
    // mid-hour — must add up rather than replace one another, because the receiver treats each as
    // a partial contribution to that bucket.
    const key = u.bucketStartMs;
    let entry = usage.get(key);
    if (!entry) {
      entry = {
        bucketStartMs: BigInt(Math.trunc(key)),
        appStarts: 0,
        sessionCount: 0,
        foregroundSeconds: 0,
        runningSeconds: 0,
        cleanShutdowns: 0,
        uncleanExits: 0,
      };
      usage.set(key, entry);
    }
    entry.appStarts += u.appStarts ?? 0;
    entry.sessionCount += u.sessionCount ?? 0;
    entry.foregroundSeconds += u.foregroundSeconds ?? 0;
    entry.runningSeconds += u.runningSeconds ?? 0;
    entry.cleanShutdowns += u.cleanShutdowns ?? 0;
    entry.uncleanExits += u.uncleanExits ?? 0;
  }
}

function toCrashRecord(body) {
  return {
    occurredAtMs: BigInt(Math.trunc(body.occurredAtMs ?? 0)),
    appVersion: String(body.appVersion ?? ''),
    source: Number.isInteger(body.source) ? body.source : CrashSource.UNSPECIFIED,
    exceptionType: String(body.exceptionType ?? 'UnknownError'),
    fingerprint: hexToBytes(body.fingerprint ?? ''),
    stack: String(body.stack ?? ''),
    count: body.count ?? 1,
  };
}

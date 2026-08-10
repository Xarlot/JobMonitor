/**
 * In-memory aggregation — the hot path, and the reason the hot path is cheap.
 *
 * `featureUsed()` has to be free enough that nobody ever hesitates to call it. Anything else and
 * instrumentation stops happening in the places that matter, which is a subtler failure than a slow
 * app: you end up with telemetry only from the paths somebody remembered to be careful about.
 *
 * So the record path is one Map operation with no allocation in the steady state, and everything
 * expensive — serializing, compressing, encrypting, writing — happens on a timer against a snapshot
 * taken here.
 *
 * Feature counts are summed across the whole reporting period rather than kept per hour. They are
 * additive, nothing downstream asks "which hour was this feature used in", and per-hour buckets
 * would multiply the record count by 24 for no answerable question.
 */

import {
  DURATION_BUCKET_BOUNDS_MS,
  DURATION_BUCKET_COUNT,
  MAX_TRAIL_EVENTS,
  TRAIL_OFFSET_UNIT_MS,
  USAGE_BUCKET_MS,
} from './constants.mjs';

export function createAggregate(now = Date.now) {
  /** @type {Map<number, number>} */
  let features = new Map();
  /**
   * The order features were used in, per bucket.
   *
   * Kept as two parallel plain arrays rather than an array of objects: this sits on the same hot
   * path as the counter above, and one push into each of two number arrays allocates nothing,
   * where a `{id, at}` object per event allocates on every click.
   *
   * `lastAtMs` is what makes the wire format cheap — deltas are computed here, at record time, so
   * the flush never has to walk the array to encode them.
   *
   * @type {Map<number, {ids:number[], deltas:number[], lastAtMs:number, dropped:boolean}>}
   */
  let trails = new Map();
  /** @type {Map<number, {count:number,sumMs:number,maxMs:number,buckets:number[],failures:Map<number,number>}>} */
  let operations = new Map();

  function operation(id) {
    let entry = operations.get(id);
    if (!entry) {
      entry = {
        count: 0,
        sumMs: 0,
        maxMs: 0,
        buckets: new Array(DURATION_BUCKET_COUNT).fill(0),
        failures: new Map(),
      };
      operations.set(id, entry);
    }
    return entry;
  }

  return {
    /** The hot path. One Map read, one Map write, and an append to the bucket's trail. */
    featureUsed(id, count = 1) {
      features.set(id, (features.get(id) ?? 0) + count);
      this.trailAppend(id);
    },

    /**
     * Append to the ordering trail.
     *
     * Split out from `featureUsed` so a merged renderer delta — which carries a count and no
     * timing — can decide for itself what it means. It records one event, not `count` of them:
     * the delta batches up to 15 seconds of clicks and the trail would otherwise claim several
     * events at the same instant, which is worse than claiming one.
     */
    trailAppend(id) {
      const at = now();
      const bucketStart = Math.floor(at / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;
      let trail = trails.get(bucketStart);
      if (!trail) {
        trail = { ids: [], deltas: [], lastAtMs: bucketStart, dropped: false };
        trails.set(bucketStart, trail);
      }
      // Past the cap the bucket keeps counting and stops ordering. `dropped` is carried so the
      // receiver can tell a short session from a truncated one rather than guessing.
      if (trail.ids.length >= MAX_TRAIL_EVENTS) {
        trail.dropped = true;
        return;
      }
      // Clamped at zero: a clock that moved backwards must not produce a negative delta, which
      // would be a wire-format error rather than a slightly wrong data point.
      const delta = Math.max(0, Math.round((at - trail.lastAtMs) / TRAIL_OFFSET_UNIT_MS));
      trail.ids.push(id);
      trail.deltas.push(delta);
      trail.lastAtMs = at;
    },

    operationCompleted(id, elapsedMs) {
      const entry = operation(id);
      // Clamp rather than reject. A negative elapsed time means the clock moved during the
      // operation, which is a real thing on laptops; it should cost one slightly wrong data point,
      // not an exception on a path the app is not allowed to notice.
      const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.round(elapsedMs) : 0;
      entry.count++;
      entry.sumMs += ms;
      if (ms > entry.maxMs) entry.maxMs = ms;
      entry.buckets[bucketOf(ms)]++;
    },

    operationFailed(id, errorCategory) {
      const entry = operation(id);
      entry.failures.set(errorCategory, (entry.failures.get(errorCategory) ?? 0) + 1);
    },

    /** Merge a batch of renderer deltas. Same shape the IPC channel carries. */
    merge(delta) {
      for (const [id, count] of delta.features ?? []) this.featureUsed(id, count);
      for (const [id, samples] of delta.operations ?? []) {
        for (const ms of samples) this.operationCompleted(id, ms);
      }
      for (const [id, category] of delta.failures ?? []) this.operationFailed(id, category);
    },

    isEmpty() {
      return features.size === 0 && operations.size === 0 && trails.size === 0;
    },

    /**
     * Take everything accumulated and start fresh.
     *
     * Reset is part of the same operation deliberately. Snapshot-then-clear as two steps loses
     * whatever was recorded between them, and the window is exactly when the app is busy — which
     * is when the interesting counts happen.
     */
    snapshotAndReset() {
      const snapshot = {
        features: [...features.entries()].map(([featureId, count]) => ({ featureId, count })),
        trails: [...trails.entries()]
          .sort(([a], [b]) => a - b)
          .map(([bucketStartMs, trail]) => ({
            bucketStartMs,
            featureIds: trail.ids,
            offsetDeltasS: trail.deltas,
            truncated: trail.dropped,
          })),
        operations: [...operations.entries()].map(([operationId, e]) => ({
          operationId,
          count: e.count,
          durationSumMs: e.sumMs,
          durationMaxMs: e.maxMs,
          buckets: [...e.buckets],
          failures: [...e.failures.entries()].map(([errorCategory, count]) => ({
            errorCategory,
            count,
          })),
        })),
      };
      features = new Map();
      operations = new Map();
      trails = new Map();
      return snapshot;
    },
  };
}

/**
 * Bucket index for a duration.
 *
 * Duplicated from the shared schema's `durationBucket` rather than imported, because this module is
 * on the hot path and must not pull the protobuf runtime into the record path. The bounds
 * themselves come from `constants.mjs`, which a test asserts is identical to the schema package —
 * so the numbers cannot drift even though the function is written twice.
 */
function bucketOf(ms) {
  for (let i = 0; i < DURATION_BUCKET_BOUNDS_MS.length; i++) {
    if (ms < DURATION_BUCKET_BOUNDS_MS[i]) return i;
  }
  return DURATION_BUCKET_BOUNDS_MS.length;
}

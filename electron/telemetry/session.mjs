/**
 * Session and activity accounting for an app that lives in the tray.
 *
 * **Why `active_seconds` became two fields.** Job Monitor keeps polling with its window hidden —
 * that is the entire point of the tray, and `main.cjs` sets `backgroundThrottling: false` to make
 * sure of it. So a single "active seconds" number would conflate "somebody was working in it" with
 * "it was running in the background", and those answer completely different questions. Splitting
 * them costs one varint:
 *
 *   - `foregroundSeconds` — window visible *and* focused. What the architecture meant by active.
 *   - `runningSeconds` — wall time the process was alive.
 *
 * **Why the heartbeat clamps.** `runningSeconds` is credited by a timer, and the credit is
 * `min(HEARTBEAT_MS, now - lastTick)`. A laptop that sleeps for eight hours simply does not fire
 * the timer, and on wake the delta would otherwise credit the whole nap as usage. The clamp is not
 * defensive rounding; it is the difference between measuring use and measuring elapsed calendar
 * time.
 *
 * **Why UTC buckets.** A local-time hour bucket is 25 hours long at a DST transition and can go
 * backwards across a timezone change. Both produce records the receiver rejects as implausible,
 * which would silently drop telemetry from precisely the people who travel.
 */

import { hourBucket, now } from './clock.mjs';
import { HEARTBEAT_MS } from './constants.mjs';

const EMPTY = () => ({
  appStarts: 0,
  sessionCount: 0,
  foregroundSeconds: 0,
  runningSeconds: 0,
  cleanShutdowns: 0,
  uncleanExits: 0,
});

export function createSession() {
  /** @type {Map<number, ReturnType<typeof EMPTY>>} bucketStartMs → totals */
  let buckets = new Map();

  let lastTick = now();
  let foregroundSince = null;
  /** Fractional seconds carried between ticks, so a run of sub-second focus changes still counts. */
  let foregroundCarryMs = 0;
  let runningCarryMs = 0;

  function bucket(at = now()) {
    const key = hourBucket(at);
    let b = buckets.get(key);
    if (!b) {
      b = EMPTY();
      buckets.set(key, b);
    }
    return b;
  }

  return {
    /** One process launch. A second-instance activation is explicitly not one. */
    started() {
      const b = bucket();
      b.appStarts++;
      b.sessionCount++;
      lastTick = now();
    },

    /** Recorded at the *next* launch, from a session sentinel that outlived its process. */
    uncleanExitDetected(at) {
      bucket(at).uncleanExits++;
    },

    cleanShutdown() {
      this.tick();
      if (foregroundSince !== null) this.foregroundEnded();
      bucket().cleanShutdowns++;
    },

    foregroundStarted() {
      if (foregroundSince === null) foregroundSince = now();
    },

    foregroundEnded() {
      if (foregroundSince === null) return;
      creditForeground(now());
      foregroundSince = null;
    },

    /**
     * Credit elapsed time. Called on a timer, and again whenever a bucket boundary matters.
     *
     * Returns the milliseconds credited, which is what the tests assert against — a clamp that
     * silently does nothing looks identical to a clamp that works.
     */
    tick() {
      const at = now();
      let delta = at - lastTick;

      // Clock moved backwards (NTP correction, user change, VM restore). Credit nothing and
      // re-base: a negative delta must never reach a counter, and guessing how much time "really"
      // passed would be inventing data.
      if (delta < 0) {
        lastTick = at;
        if (foregroundSince !== null) foregroundSince = at;
        return 0;
      }

      const credited = Math.min(delta, HEARTBEAT_MS);
      runningCarryMs += credited;
      const wholeSeconds = Math.floor(runningCarryMs / 1000);
      if (wholeSeconds > 0) {
        bucket(at).runningSeconds += wholeSeconds;
        runningCarryMs -= wholeSeconds * 1000;
      }

      if (foregroundSince !== null) creditForeground(at);

      lastTick = at;
      return credited;
    },

    /**
     * Take the accumulated buckets and start fresh.
     *
     * Any bucket still open keeps accumulating from zero, which is correct: the receiver sums
     * records that share a `bucketStartMs`, so a split hour arrives as two partial records that add
     * up rather than as one that overwrites the other.
     */
    snapshotAndReset() {
      this.tick();
      const out = [...buckets.entries()]
        .map(([bucketStartMs, totals]) => ({ bucketStartMs, ...totals }))
        .filter((b) => !isEmptyBucket(b))
        .sort((a, b) => a.bucketStartMs - b.bucketStartMs);
      buckets = new Map();
      return out;
    },

    isEmpty() {
      return buckets.size === 0;
    },
  };

  function creditForeground(at) {
    const delta = at - foregroundSince;
    if (delta <= 0) {
      foregroundSince = at;
      return;
    }
    // Same clamp as running time, for the same reason: the window can be "focused" across a sleep.
    foregroundCarryMs += Math.min(delta, HEARTBEAT_MS);
    const wholeSeconds = Math.floor(foregroundCarryMs / 1000);
    if (wholeSeconds > 0) {
      bucket(at).foregroundSeconds += wholeSeconds;
      foregroundCarryMs -= wholeSeconds * 1000;
    }
    foregroundSince = at;
  }
}

function isEmptyBucket(b) {
  return (
    b.appStarts === 0 &&
    b.sessionCount === 0 &&
    b.foregroundSeconds === 0 &&
    b.runningSeconds === 0 &&
    b.cleanShutdowns === 0 &&
    b.uncleanExits === 0
  );
}

/**
 * The one source of time for telemetry, and the seam that makes it testable.
 *
 * Everything downstream — hour buckets, the 15-minute spool flush, the send interval, retry
 * backoff, the 7-day retention cut — is a function of "what time is it". Threading a clock through
 * every module is what turns a suite that would need `vi.useFakeTimers()` and real waiting into one
 * that runs in microseconds and can test a DST transition, a laptop waking after eight hours, and a
 * user setting their clock backwards.
 */

let nowFn = () => Date.now();

/** Current wall-clock time in epoch milliseconds. */
export function now() {
  return nowFn();
}

/** Replace the clock. Tests only. */
export function setNow(fn) {
  nowFn = fn;
}

/** Restore the real clock. */
export function resetNow() {
  nowFn = () => Date.now();
}

/**
 * Start of the UTC hour containing `ms`.
 *
 * UTC, never local. A local-time bucket is 25 hours long at a DST transition and can be negative
 * across a timezone change, and both produce records the receiver rejects as implausible — which
 * would silently drop telemetry from exactly the users who travel.
 */
export function hourBucket(ms) {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

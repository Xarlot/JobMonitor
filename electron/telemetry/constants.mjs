/**
 * Constants the hot path needs, without the schema package attached.
 *
 * `@jobmonitor/telemetry-schema` is the single source of truth for all of these, and the send path
 * imports them from there. But the *record* path — `featureUsed`, `operationCompleted` — runs on
 * every user action, and importing the schema package would drag the protobuf runtime, the noble
 * crypto libraries and fflate into it. That is a real cost paid on every click for values that are
 * four numbers.
 *
 * So they are written twice, and `src/test/telemetryConstants.test.mjs` asserts the two copies are
 * identical. Duplication guarded by a test is a much smaller problem than a hot path that loads a
 * cryptography library.
 */

/** Upper bound of each duration histogram bucket, in ms. The last bucket is unbounded. */
export const DURATION_BUCKET_BOUNDS_MS = [50, 100, 250, 500, 1000, 2000, 5000];

/** Including the unbounded final bucket. */
export const DURATION_BUCKET_COUNT = DURATION_BUCKET_BOUNDS_MS.length + 1;

/** Renderer counters → main process. */
export const IPC_FLUSH_MS = 15_000;

/** In-memory aggregate → local spool. */
export const SPOOL_FLUSH_MS = 15 * 60 * 1000;

/** Session heartbeat, and the clamp on how much wall time one tick may credit. */
export const HEARTBEAT_MS = 60_000;

/** Usage bucket width. UTC. */
export const USAGE_BUCKET_MS = 60 * 60 * 1000;

/** Identifier width in bytes. */
export const ID_BYTES = 16;

/** Crash-storm limits. */
/** Mirrors MAX_TRAIL_EVENTS in the schema package; the same test asserts the two agree. */
export const MAX_TRAIL_EVENTS = 256;

/** Mirrors TRAIL_OFFSET_UNIT_MS. */
export const TRAIL_OFFSET_UNIT_MS = 1000;

export const MAX_CRASHES_PER_FINGERPRINT = 3;
export const MAX_CRASHES_PER_SESSION = 20;

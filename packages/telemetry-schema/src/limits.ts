/**
 * Every size and shape limit in the telemetry system, in one file.
 *
 * These are shared deliberately. The client uses them to decide when to split a batch and how much
 * to keep; the receiver uses the same constants to reject anything outside them. If the two sides
 * held their own copies they would drift, and the failure mode of that drift is silent: the client
 * emits something a little too large, the receiver rejects it, and the only symptom is a chart that
 * quietly reads low.
 */

/**
 * Upper bound of each duration histogram bucket, in milliseconds. The last bucket is unbounded.
 *
 * Eight rather than the four in the original design. Four coarse buckets cannot produce even an
 * approximate percentile — you can only ever say "share below threshold N" — and widening the wire
 * format after v1 ships would be a schema change that loses comparability with everything already
 * collected. Four extra varints per operation record is not a cost worth optimising.
 */
export const DURATION_BUCKET_BOUNDS_MS = [50, 100, 250, 500, 1000, 2000, 5000] as const;

/** Number of histogram buckets, including the unbounded final one. */
export const DURATION_BUCKET_COUNT = DURATION_BUCKET_BOUNDS_MS.length + 1;

/** Index of the bucket a duration falls into. Total ordering, no gaps, never out of range. */
export function durationBucket(ms: number): number {
  // NaN and negatives land in bucket 0 rather than throwing. A malformed duration should cost one
  // slightly wrong data point, never an exception on a path the app is not allowed to notice.
  for (let i = 0; i < DURATION_BUCKET_BOUNDS_MS.length; i++) {
    if (ms < DURATION_BUCKET_BOUNDS_MS[i]) return i;
  }
  return DURATION_BUCKET_BOUNDS_MS.length;
}

/** Structural version of the wire format. Bumped only for protobuf changes, never for new ids. */
export const SCHEMA_VERSION = 1;

/** Identifier widths, in bytes. All three are raw randomness, not derived from anything. */
export const ID_BYTES = 16;

// ── Transport budget ────────────────────────────────────────────────────────────────────────────
//
// Worked backwards from Ably's per-message ceiling. The chain from a protobuf batch to a published
// message expands it roughly 2.2×, and every step has to fit:
//
//   deflated → base64 (×1.34) → NIP-44 pad (up to ×1.25) → +65 framing → base64 (×1.34) → JSON
//
// The numbers below are not arithmetic on paper — `test/limits.test.ts` builds a worst-case payload
// at exactly MAX_DEFLATED_BYTES, runs it through the real seal path, and asserts the result fits.
// An expansion estimate that is wrong by 10% is the kind of thing that only shows up as publish
// failures from the users with the most data.

/**
 * Ably's maximum size for a single published message, on the Free and Standard tiers.
 * (Pro and Enterprise allow 256 KiB, but nothing here should depend on being on a paid plan.)
 */
export const MAX_ABLY_MESSAGE_BYTES = 64 * 1024;

/**
 * What we allow a serialized message to reach. Comfortably under Ably's ceiling: a publish that is
 * rejected for size is data lost with no retry that could ever succeed, so the margin is deliberate.
 */
export const MAX_MESSAGE_CHARS = 56_000;

/** NIP-44 v2's own plaintext ceiling. */
export const MAX_NIP44_PLAINTEXT = 65_535;

/** Deflated protobuf, before base64 and encryption. */
export const MAX_DEFLATED_BYTES = 24_000;

/**
 * What the client aims for when splitting. Well below the hard cap so a batch that compresses worse
 * than expected still fits rather than failing after it has been built.
 */
export const MAX_DEFLATED_TARGET = 16_384;

/** Inflated protobuf. Guards against a decompression bomb sized to exhaust the receiver. */
export const MAX_INFLATED_BYTES = 1024 * 1024;

/**
 * Compression ratio above which a payload is *reported* as anomalous — deliberately not enforced.
 *
 * The obvious design is to bound the inflate buffer at `compressed × ratio`, and it is wrong for
 * this payload: telemetry batches are repetitive integer counters that legitimately compress by
 * 500:1 or more, so a ratio cap rejects ordinary batches from the heaviest users while adding no
 * safety over the absolute {@link MAX_INFLATED_BYTES} bound. Measured: 60 KB of a realistic stack
 * trace deflates to 76 bytes — a ratio of ~790:1, entirely benign.
 *
 * So the absolute cap is the guard, and this is a number the receiver records to notice a shift in
 * the distribution, which would mean either a client bug or someone probing.
 */
export const ANOMALOUS_INFLATE_RATIO = 1000;

/** Records of all kinds in one batch. */
export const MAX_RECORDS_PER_BATCH = 500;

/**
 * How many ordered feature events one bucket may carry.
 *
 * A cap on two things at once. It bounds the size — a trail is the only part of a batch that grows
 * with how hard someone is using the app rather than with how many distinct things they touched —
 * and it bounds how identifying the record is: a bounded prefix of a session says what usually
 * follows what, while an unbounded one is a diary. Past the cap the bucket keeps counting and stops
 * ordering, so totals stay correct either way.
 *
 * 256 events is several hours of ordinary use at the observed rates, and about 700 bytes on the
 * wire before compression.
 */
export const MAX_TRAIL_EVENTS = 256;

/**
 * Trail offsets are whole seconds since the previous event.
 *
 * Nothing on this path measures latency — operations already carry their own histograms — so
 * millisecond resolution would buy no answer and cost both bytes and a much sharper fingerprint.
 */
export const TRAIL_OFFSET_UNIT_MS = 1000;

// ── Field limits ────────────────────────────────────────────────────────────────────────────────

/** `app_version` and `electron_version`. */
export const MAX_VERSION_CHARS = 32;

/** `exception_type` — a class name, not a sentence. */
export const MAX_EXCEPTION_TYPE_CHARS = 128;

/** Sanitized stack trace, as written by the client. */
export const MAX_STACK_BYTES = 4096;

/**
 * Sanitized stack trace, as accepted by the receiver. Deliberately looser than what the client
 * emits: a client one version ahead should not have its crashes silently dropped by a receiver one
 * version behind.
 */
export const MAX_STACK_BYTES_ACCEPTED = 8192;

/** Lines in a stack trace. */
export const MAX_STACK_LINES = 100;

/** Frames the client keeps. The fingerprint uses only the top few of these. */
export const MAX_STACK_FRAMES = 12;

/** Frames that feed the crash fingerprint. */
export const FINGERPRINT_FRAMES = 5;

/** Any single counter. Above this the record is rejected as implausible rather than clamped. */
export const MAX_COUNTER_VALUE = 1_000_000;

// ── Client queue ────────────────────────────────────────────────────────────────────────────────

/** Local spool retention. The age cap binds long before any byte cap does. */
export const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-priority byte caps for the local spool. */
export const SPOOL_CAPS_BYTES = {
  crash: 1024 * 1024,
  failure: 1024 * 1024,
  usage: 2 * 1024 * 1024,
} as const;

/** Crash records never evicted to make room for anything else. */
export const SPOOL_CRASH_FLOOR = 20;

/** Records per fingerprint per session, and crash records per session. A crash loop reports a
 *  count, not a thousand rows — otherwise it evicts everything else worth keeping. */
export const MAX_CRASHES_PER_FINGERPRINT = 3;
export const MAX_CRASHES_PER_SESSION = 20;

// ── Cadence ─────────────────────────────────────────────────────────────────────────────────────

/** Renderer counters → main process. */
export const IPC_FLUSH_MS = 15_000;

/** In-memory aggregate → local spool. */
export const SPOOL_FLUSH_MS = 15 * 60 * 1000;

/** Local spool → relay, plus the jitter applied either side of it. */
export const SEND_INTERVAL_MS = 60 * 60 * 1000;
export const SEND_JITTER_MS = 10 * 60 * 1000;

/**
 * Delay before the first send of a session. Keeps 50 installations that all updated overnight from
 * arriving at the relay together, and keeps telemetry from competing with the first GitHub polls.
 */
export const FIRST_SEND_DELAY_MS = 60_000;
export const FIRST_SEND_DELAY_JITTER_MS = 60_000;

/** Retry backoff after a failed send. Records stay queued throughout. */
export const SEND_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 14_400_000] as const;

/** How much a backoff step is jittered, as a fraction. */
export const SEND_BACKOFF_JITTER = 0.2;

/** Drain cadence while the queue still holds records after a successful send. */
export const SEND_DRAIN_MS = 60_000;

/** Session heartbeat. Also the clamp on how much wall time one tick may credit — which is what
 *  stops a sleeping laptop from reporting the whole nap as running time. */
export const HEARTBEAT_MS = 60_000;

/** Usage bucket width. UTC, always. */
export const USAGE_BUCKET_MS = 60 * 60 * 1000;

// Note: there is deliberately no sender-key rotation constant.
//
// An earlier design published to a public Nostr relay, where a persistent sender key would have
// been a world-visible correlator — anyone could count distinct publishers and derive our install
// count and the daily activity rhythm of the people using the app. Rotation every 30 days was the
// mitigation for that. On a private Ably channel there is no such observer, so the problem is gone
// rather than mitigated, and the key is simply generated fresh per batch and discarded. Nothing is
// stored, so nothing needs rotating.

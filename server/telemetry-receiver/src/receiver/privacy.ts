/**
 * Privacy and schema validation.
 *
 * This runs on input that is hostile by definition: the client's credentials ship inside a binary
 * distributed to users, so anyone who extracts them can publish whatever they like to our channel.
 * Nothing here may assume the sender is our own app.
 *
 * **Two granularities, deliberately.** An envelope problem rejects the whole batch — it says the
 * sender is not who we think. A record problem drops *that record* only, because one malformed
 * entry must not cost the sixty good ones beside it.
 *
 * **Strings are rejected, never truncated.** Truncating hides the bug that produced the oversized
 * value, and cutting a secret in half still leaks its prefix.
 *
 * **The deny-pattern scan is a backstop, not the control.** The real control is that the client
 * sanitizes and the wire format is almost entirely numeric — there are five string fields in the
 * whole schema and a build-time test keeps it that way. What this adds is a refusal to store
 * anything that does not *already* look sanitized.
 */

import type { TelemetryBatch } from '@jobmonitor/telemetry-schema';
import { Features, Operations, ErrorCategories } from '@jobmonitor/telemetry-schema/registry';
import {
  DURATION_BUCKET_COUNT,
  MAX_COUNTER_VALUE,
  MAX_EXCEPTION_TYPE_CHARS,
  MAX_RECORDS_PER_BATCH,
  MAX_TRAIL_EVENTS,
  MAX_STACK_BYTES_ACCEPTED,
  MAX_STACK_LINES,
  MAX_VERSION_CHARS,
  SCHEMA_VERSION,
} from '@jobmonitor/telemetry-schema/limits';

/** The bucket a trail is measured within — one hour, matching USAGE_BUCKET_MS on the client. */
const TRAIL_BUCKET_MS = 3_600_000;

export interface Rejection {
  rule: string;
  field?: string;
}

export type EnvelopeCheck = { ok: true } | { ok: false } & Rejection;

const HEX32 = /^[0-9a-f]{32}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$.]{0,127}$/;
/** A stack line as our sanitizer emits it — nothing else is accepted. */
const STACK_LINE = /^\s{0,8}(at |in )?\S.{0,240}$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Things that must never appear in a stack trace.
 *
 * The GitHub token pattern is not hypothetical: this app holds a classic `repo` PAT in memory, and
 * a token reaching an exception is an ordinary bug rather than an exotic one.
 */
const DENY_PATTERNS: [string, RegExp][] = [
  ['email', /[\w.+-]+@[\w-]+\.[\w.]{2,}/],
  ['url', /\bhttps?:\/\/[^\s)]+/],
  ['windows-path', /[A-Za-z]:\\[^\s"']+/],
  ['posix-home', /\/(?:home|Users)\/[^/\s"']+/],
  ['unc-path', /\\\\[^\s\\]+\\/],
  ['ipv4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}/],
  ['github-token', /\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ['base64-blob', /[A-Za-z0-9+/]{60,}={0,2}/],
  ['hex-blob', /\b[0-9a-f]{40,}\b/i],
];

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Envelope-level checks. A failure rejects the entire batch.
 */
export function checkEnvelope(
  batch: TelemetryBatch,
  expectedDeploymentId: string,
  now: number,
): EnvelopeCheck {
  if (hex(batch.deploymentId) !== expectedDeploymentId) {
    return { ok: false, rule: 'deployment-mismatch', field: 'deployment_id' };
  }
  if (batch.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, rule: 'schema-version', field: 'schema_version' };
  }
  if (!HEX32.test(hex(batch.batchId))) {
    return { ok: false, rule: 'malformed-id', field: 'batch_id' };
  }
  // A 32-hex-character regex is structurally incapable of matching a hostname, a username or an
  // email — which is a stronger statement about the field than any amount of scanning.
  if (!HEX32.test(hex(batch.installationId))) {
    return { ok: false, rule: 'malformed-id', field: 'installation_id' };
  }
  if (!SEMVER.test(batch.appVersion) || batch.appVersion.length > MAX_VERSION_CHARS) {
    return { ok: false, rule: 'bad-version', field: 'app_version' };
  }
  if (batch.electronVersion.length > MAX_VERSION_CHARS) {
    return { ok: false, rule: 'bad-version', field: 'electron_version' };
  }

  const start = Number(batch.periodStartMs);
  const end = Number(batch.periodEndMs);
  if (!(start > 0 && end > 0 && start <= end)) {
    return { ok: false, rule: 'bad-period', field: 'period' };
  }
  // 26 hours rather than 24: a batch may straddle a long offline stretch plus jitter, and the
  // client's own queue caps the rest.
  if (end - start > 26 * HOUR) return { ok: false, rule: 'bad-period', field: 'period_length' };
  if (end > now + 5 * MINUTE) return { ok: false, rule: 'future-period', field: 'period_end' };
  // Clock skew beyond a week means the record would land on the wrong day and quietly distort a
  // chart. Rejecting is better than storing something known to be misplaced.
  if (start < now - 30 * DAY) return { ok: false, rule: 'stale-period', field: 'period_start' };

  const records =
    batch.features.length + batch.operations.length + batch.usage.length + batch.crashes.length;
  if (records > MAX_RECORDS_PER_BATCH) {
    return { ok: false, rule: 'too-many-records', field: 'records' };
  }

  return { ok: true };
}

const counterOk = (n: number) => Number.isInteger(n) && n >= 0 && n <= MAX_COUNTER_VALUE;

export function checkFeature(f: { featureId: number; count: number }): EnvelopeCheck {
  // An unknown id is dropped rather than stored. There is no string path for a label, so a client
  // can never smuggle free text through a numeric field — but it can send a number we have never
  // heard of, and storing that would put `unknown(9999)` on a dashboard forever.
  if (!Features.has(f.featureId)) return { ok: false, rule: 'unknown-id', field: 'feature_id' };
  if (!counterOk(f.count)) return { ok: false, rule: 'bad-counter', field: 'count' };
  return { ok: true };
}

/**
 * A trail is checked as a shape, not as content.
 *
 * There is nothing free-form in it — two arrays of numbers — so the risk is not what it says but
 * what it costs and what it implies. The checks are therefore about size and internal consistency:
 * arrays of equal length, a bounded count, ids the registry knows, and offsets that stay inside the
 * bucket they claim. A trail whose deltas sum past its bucket is a client with a broken clock, and
 * accepting it would put events on the wrong day of the map.
 */
export function checkTrail(t: {
  bucketStartMs: bigint;
  featureIds: number[];
  offsetDeltasS: number[];
}): EnvelopeCheck {
  if (t.featureIds.length !== t.offsetDeltasS.length) {
    return { ok: false, rule: 'trail-length-mismatch', field: 'offset_deltas_s' };
  }
  if (t.featureIds.length > MAX_TRAIL_EVENTS) {
    return { ok: false, rule: 'trail-too-long', field: 'feature_ids' };
  }
  for (const id of t.featureIds) {
    if (!Features.has(id)) return { ok: false, rule: 'unknown-id', field: 'feature_ids' };
  }
  let offset = 0;
  for (const delta of t.offsetDeltasS) {
    if (!Number.isInteger(delta) || delta < 0) {
      return { ok: false, rule: 'bad-offset', field: 'offset_deltas_s' };
    }
    offset += delta;
  }
  // One bucket of slack: a trail is merged from several spool records whose first offsets were each
  // measured from the bucket start, so the concatenated sum legitimately overshoots the hour.
  if (offset * 1000 > 2 * TRAIL_BUCKET_MS) {
    return { ok: false, rule: 'trail-overruns-bucket', field: 'offset_deltas_s' };
  }
  return { ok: true };
}

export function checkOperation(o: {
  operationId: number;
  count: number;
  durationSumMs: bigint;
  durationMaxMs: number;
  buckets: number[];
  failures: { errorCategory: number; count: number }[];
}): EnvelopeCheck {
  if (!Operations.has(o.operationId)) {
    return { ok: false, rule: 'unknown-id', field: 'operation_id' };
  }
  if (!counterOk(o.count)) return { ok: false, rule: 'bad-counter', field: 'count' };
  if (o.buckets.length !== DURATION_BUCKET_COUNT) {
    return { ok: false, rule: 'bad-histogram', field: 'buckets' };
  }
  const bucketSum = o.buckets.reduce((a, b) => a + b, 0);
  // The invariant that catches a client-side aggregation bug: every completion must be in exactly
  // one bucket. A mismatch means the histogram and the count disagree, and a chart built on either
  // one alone would look perfectly reasonable.
  if (bucketSum !== o.count) return { ok: false, rule: 'histogram-mismatch', field: 'buckets' };

  const sum = Number(o.durationSumMs);
  if (!Number.isFinite(sum) || sum < 0) return { ok: false, rule: 'bad-counter', field: 'sum' };
  if (o.durationMaxMs < 0 || o.durationMaxMs > 24 * HOUR) {
    return { ok: false, rule: 'bad-duration', field: 'duration_max' };
  }
  if (sum > o.count * o.durationMaxMs && o.count > 0) {
    return { ok: false, rule: 'inconsistent-duration', field: 'duration_sum' };
  }
  for (const f of o.failures) {
    if (!ErrorCategories.has(f.errorCategory)) {
      return { ok: false, rule: 'unknown-id', field: 'error_category' };
    }
    if (!counterOk(f.count)) return { ok: false, rule: 'bad-counter', field: 'failure_count' };
  }
  return { ok: true };
}

export function checkUsage(
  u: {
    bucketStartMs: bigint;
    appStarts: number;
    sessionCount: number;
    foregroundSeconds: number;
    runningSeconds: number;
    cleanShutdowns: number;
    uncleanExits: number;
  },
  now: number,
): EnvelopeCheck {
  const bucket = Number(u.bucketStartMs);
  if (!(bucket > 0) || bucket > now + HOUR) {
    return { ok: false, rule: 'bad-bucket', field: 'bucket_start' };
  }
  if (bucket % HOUR !== 0) return { ok: false, rule: 'unaligned-bucket', field: 'bucket_start' };

  for (const [field, value] of Object.entries({
    app_starts: u.appStarts,
    session_count: u.sessionCount,
    clean_shutdowns: u.cleanShutdowns,
    unclean_exits: u.uncleanExits,
  })) {
    if (!counterOk(value)) return { ok: false, rule: 'bad-counter', field };
  }
  // An hour bucket cannot contain more than an hour of anything. This is what catches a broken
  // clamp on the client — the exact bug the sleeping-laptop clamp exists to prevent.
  if (u.runningSeconds < 0 || u.runningSeconds > 3600) {
    return { ok: false, rule: 'impossible-time', field: 'running_seconds' };
  }
  if (u.foregroundSeconds < 0 || u.foregroundSeconds > u.runningSeconds) {
    return { ok: false, rule: 'impossible-time', field: 'foreground_seconds' };
  }
  return { ok: true };
}

export interface CrashCheck {
  ok: boolean;
  rule?: string;
  field?: string;
  /** The stack failed the deny scan: keep the crash, drop the trace. */
  redactStack?: boolean;
}

/**
 * Crash records — the only place a trace reaches storage.
 *
 * A stack that trips the deny scan costs the *trace*, not the record. Losing the fact that a crash
 * happened is worse than losing its detail: the fingerprint, the version and the count are what
 * drive the reliability dashboards, and they are all safe.
 */
export function checkCrash(c: {
  occurredAtMs: bigint;
  appVersion: string;
  exceptionType: string;
  fingerprint: Uint8Array;
  stack: string;
  count: number;
}, now: number): CrashCheck {
  const at = Number(c.occurredAtMs);
  if (!(at > 0) || at > now + 5 * MINUTE) return { ok: false, rule: 'bad-time', field: 'occurred_at' };
  if (!SEMVER.test(c.appVersion)) return { ok: false, rule: 'bad-version', field: 'app_version' };
  if (!counterOk(c.count)) return { ok: false, rule: 'bad-counter', field: 'count' };

  // `error.name` is writable in JavaScript, so this field is user-controllable in exactly the way
  // one of the format's five string fields must not be. Shape check, then a secret scan — a token
  // is itself a valid identifier, so the shape check alone would pass it.
  if (
    !CLASS_NAME.test(c.exceptionType) ||
    c.exceptionType.length > MAX_EXCEPTION_TYPE_CHARS ||
    looksLikeSecret(c.exceptionType)
  ) {
    return { ok: false, rule: 'bad-exception-type', field: 'exception_type' };
  }
  if (!/^[0-9a-f]{16,64}$/.test(hex(c.fingerprint))) {
    return { ok: false, rule: 'bad-fingerprint', field: 'fingerprint' };
  }

  if (Buffer.byteLength(c.stack) > MAX_STACK_BYTES_ACCEPTED) {
    return { ok: true, redactStack: true, rule: 'stack-too-large', field: 'stack' };
  }
  const lines = c.stack.split('\n');
  if (lines.length > MAX_STACK_LINES) {
    return { ok: true, redactStack: true, rule: 'stack-too-many-lines', field: 'stack' };
  }
  for (const line of lines) {
    if (line && !STACK_LINE.test(line)) {
      return { ok: true, redactStack: true, rule: 'stack-shape', field: 'stack' };
    }
  }
  const hit = scanStack(c.stack);
  if (hit) return { ok: true, redactStack: true, rule: `stack-${hit}`, field: 'stack' };

  return { ok: true };
}

/** Which deny pattern a string trips, or null. Returns the *name*, never the match. */
export function scanStack(text: string): string | null {
  for (const [name, pattern] of DENY_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

function looksLikeSecret(text: string): boolean {
  return (
    /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/.test(text) ||
    /[0-9a-f]{24,}/i.test(text) ||
    /[A-Za-z0-9+/]{40,}={0,2}/.test(text)
  );
}

/**
 * Normalise before any pattern is applied.
 *
 * Order matters. A deny pattern is trivially defeated by splicing a control character into the
 * middle of a token, so the strip has to happen first or the scan is decorative.
 */
export function normaliseStack(stack: string): string {
  return stack
    .replace(/\r\n/g, '\n')
    // Every control character except newline and tab.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

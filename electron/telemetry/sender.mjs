/**
 * The send state machine.
 *
 * Driven by an explicit `tick(now)` rather than by its own timers, which is what makes the whole
 * thing — cadence, jitter, backoff, splitting, the first-send delay — testable synchronously with
 * an injected clock. `start()` does nothing but wire an interval to `tick`.
 *
 * Three rules hold everywhere in this file:
 *
 *   1. **A failed send changes nothing on disk.** Records are removed only after a confirmed
 *      publish. That is what makes delivery at-least-once, and why retrying is safe.
 *   2. **Nothing throws to the caller.** Every outcome is a value; the app never awaits any of it.
 *   3. **Never send on the quit path.** A network round trip in `before-quit` either blocks the
 *      quit or gets killed halfway, and neither is worth an extra batch.
 */

import {
  encodeBatch,
  sealBatch,
  assertConfigured,
  RECEIVER_PUBKEY_HEX,
  MAX_DEFLATED_TARGET,
} from '@jobmonitor/telemetry-schema';

import { buildBatch } from './batch.mjs';
import { now } from './clock.mjs';
import { jitter, randomUnit } from './random.mjs';
import { publish, PublishResult } from './publish.mjs';

const SEND_INTERVAL_MS = 60 * 60 * 1000;
const SEND_JITTER_MS = 10 * 60 * 1000;
const FIRST_SEND_DELAY_MS = 60_000;
const FIRST_SEND_JITTER_MS = 60_000;
const DRAIN_MS = 60_000;
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 14_400_000];
const BACKOFF_JITTER = 0.2;

/** Records taken per batch. Keeps one send bounded even after a week offline. */
const MAX_RECORDS_PER_SEND = 200;

export function createSender({
  spool,
  context,
  onLog = () => {},
  enabled = true,
  /**
   * Injected rather than read straight from the build-time constant, so tests can seal against a
   * real key. The placeholder that an unconfigured build carries is 32 zero bytes, which is not a
   * valid curve point — so ECDH throws rather than producing a useless-but-quiet result. That is
   * the right behaviour, and it is also why this needs a seam.
   */
  receiverPubkey = RECEIVER_PUBKEY_HEX,
}) {
  // Staggered from the start: 50 installations that all auto-updated overnight would otherwise
  // launch within seconds of each other and publish in lockstep for the rest of their lives.
  let nextSendAt = now() + FIRST_SEND_DELAY_MS + Math.round(randomUnit() * FIRST_SEND_JITTER_MS);
  let attempt = 0;
  let stopped = !enabled;
  let inFlight = false;

  /** Set when credentials are missing or rejected — a condition no retry can improve. */
  let permanentlyOff = false;

  function scheduleNext(fromNow) {
    nextSendAt = now() + fromNow;
  }

  function backoff() {
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    scheduleNext(Math.max(1000, jitter(base, base * BACKOFF_JITTER)));
  }

  async function send() {
    if (stopped || permanentlyOff || inFlight) return { sent: 0 };

    let records = spool.readAll();
    if (records.length === 0) {
      scheduleNext(jitter(SEND_INTERVAL_MS, SEND_JITTER_MS));
      return { sent: 0 };
    }

    inFlight = true;
    try {
      // Highest priority first, oldest first — the order readAll already returns.
      const slice = records.slice(0, MAX_RECORDS_PER_SEND);
      const { batch, batchIdHex } = buildBatch(slice, {
        ...context,
        droppedRecords: spool.droppedCount(),
      });

      let encoded;
      try {
        encoded = encodeBatch(batch);
      } catch (err) {
        // Over the deflate cap even after slicing. Halve and retry rather than give up: a single
        // enormous crash record could otherwise wedge the queue permanently, and the records
        // behind it would age out having never been sent.
        return await sendSmaller(slice, err);
      }

      if (encoded.length > MAX_DEFLATED_TARGET * 2) {
        return await sendSmaller(slice, new Error('over target size'));
      }

      const { result, detail } = await publish(sealBatch(encoded, receiverPubkey), batchIdHex);

      if (result === PublishResult.OK) {
        // Only now is anything removed. The window between publish and ack can duplicate a batch;
        // it can never lose one, and the receiver deduplicates on batch_id.
        spool.ack(slice);
        spool.clearDropped();
        attempt = 0;
        const remaining = spool.readAll().length;
        scheduleNext(remaining > 0 ? DRAIN_MS : jitter(SEND_INTERVAL_MS, SEND_JITTER_MS));
        onLog('telemetry', 'batch sent', {
          batch: batchIdHex.slice(0, 8),
          records: slice.length,
          bytes: encoded.length,
          remaining,
        });
        return { sent: slice.length };
      }

      if (result === PublishResult.UNAUTHORIZED) {
        permanentlyOff = true;
        onLog('telemetry', 'WARN: publishing disabled', { reason: 'unauthorized', detail });
        return { sent: 0 };
      }

      if (result === PublishResult.REJECT) {
        // Ably will never accept this payload. Halving is the only thing that can help; if it is
        // already a single record, drop it — one poisoned record must not block the queue forever.
        return await sendSmaller(slice, new Error(`rejected ${detail}`));
      }

      backoff();
      onLog('telemetry', 'send failed, backing off', { detail, attempt, records: slice.length });
      return { sent: 0 };
    } catch (err) {
      backoff();
      onLog('telemetry', 'WARN: send error', { message: String(err?.message ?? err) });
      return { sent: 0 };
    } finally {
      inFlight = false;
    }
  }

  /**
   * Retry with half the records.
   *
   * The escape from a wedged queue. Without it, one oversized record sits at the head forever and
   * everything behind it expires unsent — a failure that looks exactly like the app not being used.
   */
  async function sendSmaller(slice, reason) {
    if (slice.length <= 1) {
      onLog('telemetry', 'WARN: dropping unsendable record', {
        reason: String(reason?.message ?? reason),
      });
      spool.ack(slice);
      scheduleNext(DRAIN_MS);
      return { sent: 0, dropped: 1 };
    }

    const half = slice.slice(0, Math.floor(slice.length / 2));
    const { batch, batchIdHex } = buildBatch(half, {
      ...context,
      droppedRecords: spool.droppedCount(),
    });

    try {
      const encoded = encodeBatch(batch);
      const { result } = await publish(sealBatch(encoded, receiverPubkey), batchIdHex);
      if (result === PublishResult.OK) {
        spool.ack(half);
        spool.clearDropped();
        attempt = 0;
        scheduleNext(DRAIN_MS);
        return { sent: half.length };
      }
    } catch {
      // fall through to backoff
    }
    backoff();
    return { sent: 0 };
  }

  return {
    /** Called from the main telemetry tick. Returns a promise only so tests can await it. */
    tick() {
      if (stopped || permanentlyOff) return Promise.resolve({ sent: 0 });
      if (now() < nextSendAt) return Promise.resolve({ sent: 0 });
      return send();
    },

    /**
     * Publish right now, ignoring both the schedule and the dev-build send gate.
     *
     * The point is to make the real publish path testable from a development build. Everything
     * else about a dev build deliberately stops short of the network — `send: app.isPackaged` —
     * and that is right as a default and useless when you actually want to watch a batch travel.
     *
     * Credentials are still required: this bypasses the *policy* that says not to send, never the
     * check that says we cannot. Returns a result rather than throwing, because the caller is a
     * button and wants something to display.
     */
    async sendNow() {
      // The `disabled` latch belongs to the telemetry module, not here; its `sendNow` checks it
      // before delegating. This one only knows about the send policy.
      try {
        assertConfigured();
      } catch (err) {
        return { ok: false, reason: String(err?.message ?? err) };
      }

      const wasStopped = stopped;
      const wasOff = permanentlyOff;
      stopped = false;
      permanentlyOff = false;
      try {
        const before = spool.readAll().length;
        const result = await send();
        return {
          ok: result.sent > 0,
          sent: result.sent,
          queued: before,
          reason: result.sent === 0 ? (before === 0 ? 'nothing queued' : 'send failed') : undefined,
        };
      } finally {
        // Restore the policy. A manual send is one send, not a decision to start sending.
        stopped = wasStopped;
        permanentlyOff = wasOff;
      }
    },

    /** Verify credentials once, up front, so a misconfigured build says so instead of failing
     *  silently every hour for the life of the installation. */
    verifyConfigured() {
      try {
        assertConfigured();
        return true;
      } catch (err) {
        permanentlyOff = true;
        onLog('telemetry', 'WARN: publishing disabled', {
          reason: 'unconfigured',
          message: String(err?.message ?? err),
        });
        return false;
      }
    },

    stop() {
      stopped = true;
    },

    /** Test seams. */
    dueAt: () => nextSendAt,
    attempts: () => attempt,
    isOff: () => permanentlyOff || stopped,
    forceDue: () => {
      nextSendAt = now();
    },
  };
}

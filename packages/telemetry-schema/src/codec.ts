/**
 * The batch codec: protobuf → deflate → base64, and back.
 *
 * Both sides run this exact code. That is the point of it living in the shared package rather than
 * being written twice: a compression-level or framing mismatch between client and receiver does not
 * fail loudly, it fails as a percentage of batches that never appear on a dashboard.
 *
 * Ordering is deflate-then-encrypt, which is the ordering that actually compresses (ciphertext is
 * incompressible by construction). The usual objection to compress-then-encrypt is CRIME/BREACH,
 * and it does not apply here: those attacks need attacker-chosen plaintext mixed into the same
 * payload as a secret, and this payload is entirely our own counters with no attacker-influenced
 * component and no secret to extract.
 *
 * base64 sits between deflate and encryption because NIP-44 encrypts a *string*. The 33% it costs
 * is paid on already-compressed bytes and stays well inside the transport budget in limits.ts.
 */

import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { deflateSync, inflateSync } from 'fflate';

import { TelemetryBatchSchema, type TelemetryBatch } from './gen/jobmonitor/telemetry/v1/telemetry_pb';
import { bytesToBase64, base64ToBytes } from './nip44';
import { MAX_DEFLATED_BYTES, MAX_INFLATED_BYTES } from './limits';

/**
 * Compression ratio of a decoded payload, for the receiver to record.
 *
 * An anomaly signal, not a limit — see the comment in {@link decodeBatch}. A sudden shift in the
 * ratio distribution means either a client bug or someone probing, and both are worth a chart.
 */
export function inflateRatio(compressedBytes: number, inflatedBytes: number): number {
  return compressedBytes === 0 ? 0 : inflatedBytes / compressedBytes;
}

/**
 * Level 6 rather than maximum. These payloads are small and repetitive — mostly small integers and
 * a handful of repeated version strings — so the last few percent of ratio costs more CPU on a
 * user's machine than it saves on a link that is nowhere near saturated.
 */
const DEFLATE_LEVEL = 6;

/** Encode a batch to the string that becomes an Ably message's encrypted payload. */
export function encodeBatch(batch: TelemetryBatch): string {
  const proto = toBinary(TelemetryBatchSchema, batch);
  const deflated = deflateSync(proto, { level: DEFLATE_LEVEL });

  if (deflated.length > MAX_DEFLATED_BYTES) {
    // The caller is expected to have split before reaching this. Throwing rather than truncating,
    // because a silently truncated protobuf decodes to plausible garbage.
    throw new Error(
      `telemetry: deflated batch is ${deflated.length} bytes, over the ${MAX_DEFLATED_BYTES} cap`,
    );
  }
  return bytesToBase64(deflated);
}

/**
 * Decode a batch. Server-side, and therefore hostile input by definition — every length here is
 * attacker-controlled until proven otherwise.
 */
export function decodeBatch(encoded: string): TelemetryBatch {
  const deflated = base64ToBytes(encoded);

  if (deflated.length > MAX_DEFLATED_BYTES) {
    throw new Error(`telemetry: compressed payload over cap (${deflated.length})`);
  }

  // A decompression bomb is a few hundred bytes that inflate to gigabytes. fflate's `out` option
  // fixes the output buffer up front, so the allocation never happens rather than being measured
  // afterwards — checking the size of a buffer you already allocated is not a defence.
  //
  // The bound is the ABSOLUTE cap, deliberately not a compression-ratio multiplier. A ratio limit
  // reads like the tighter check and is in fact simply wrong here: this payload is repetitive
  // integer counters, which legitimately compress by 500:1 or more. A 100:1 ratio guard rejects
  // ordinary batches from the app's heaviest users — the ones whose data we most want — while
  // adding nothing, because 1 MiB is already a trivial allocation to cap at. Ratio is still worth
  // *reporting*: see `inflateRatio` below, which the receiver records as an anomaly signal rather
  // than enforcing as a limit.
  //
  // One byte of headroom, and then an explicit length check. fflate does not throw when output
  // exceeds a fixed `out` buffer — it silently truncates and returns the buffer full (measured).
  // Without the headroom, an over-large payload would arrive here as a *truncated but well-formed
  // looking* byte string, and a truncated protobuf can legitimately parse: proto3 messages are
  // prefix-decodable, so cutting one short usually yields a valid message with trailing fields
  // missing. That would be silent data corruption presented as real telemetry. Detecting the
  // overflow is the difference between rejecting a payload and believing a mutilated one.
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(deflated, { out: new Uint8Array(MAX_INFLATED_BYTES + 1) });
  } catch {
    throw new Error('telemetry: payload failed to inflate within limits');
  }
  if (inflated.length > MAX_INFLATED_BYTES) {
    throw new Error('telemetry: payload failed to inflate within limits');
  }

  return fromBinary(TelemetryBatchSchema, inflated);
}

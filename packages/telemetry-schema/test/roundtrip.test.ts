/**
 * The full client→receiver path, exercised end to end without a network.
 *
 * encode → deflate → base64 → NIP-44 encrypt → seal → publish → open → decrypt → inflate → decode
 *
 * This is what proves the two halves of the system agree. It runs in both the node and jsdom
 * projects because the client encrypts in Electron's main process and the receiver decrypts in
 * Node — and an environment-dependent divergence would present as a fraction of batches simply
 * never arriving, which looks identical to nobody using the app.
 */

import { describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { bytesToHex } from '@noble/ciphers/utils.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

import { decodeBatch, encodeBatch } from '../src/codec';
import { openBatch, sealBatch, TELEMETRY_CHANNEL } from '../src/channel';
import { bytesToBase64 } from '../src/nip44';
import { deflateSync } from 'fflate';
import {
  DURATION_BUCKET_COUNT,
  ID_BYTES,
  MAX_ABLY_MESSAGE_BYTES,
  MAX_DEFLATED_BYTES,
  MAX_INFLATED_BYTES,
  MAX_MESSAGE_CHARS,
  SCHEMA_VERSION,
} from '../src/limits';
import { ErrorCategory } from '../src/registry/errorCategories';
import { Feature } from '../src/registry/features';
import { Operation } from '../src/registry/operations';
import {
  Arch,
  CrashSource,
  Platform,
  TelemetryBatchSchema,
} from '../src/gen/jobmonitor/telemetry/v1/telemetry_pb';

function bytes(fill: number): Uint8Array {
  return new Uint8Array(ID_BYTES).fill(fill);
}

/** A batch with every repeated field populated, so nothing is exercised only in the empty case. */
function sampleBatch() {
  return create(TelemetryBatchSchema, {
    batchId: bytes(1),
    schemaVersion: SCHEMA_VERSION,
    installationId: bytes(2),
    deploymentId: bytes(3),
    appVersion: '2.2.0',
    platform: Platform.LINUX,
    arch: Arch.X64,
    electronVersion: '42.5.0',
    periodStartMs: 1_754_650_000_000n,
    periodEndMs: 1_754_653_600_000n,
    features: [
      { featureId: Feature.FLOW_CREATED, count: 3 },
      { featureId: Feature.AI_TRIAGE_DEEP, count: 1 },
    ],
    operations: [
      {
        operationId: Operation.GH_PR_LIST_POLL,
        count: 120,
        durationSumMs: 48_000n,
        durationMaxMs: 1_900,
        buckets: [10, 20, 30, 25, 20, 10, 4, 1],
        failures: [{ errorCategory: ErrorCategory.RATE_LIMIT, count: 2 }],
      },
    ],
    usage: [
      {
        bucketStartMs: 1_754_650_000_000n,
        appStarts: 1,
        sessionCount: 1,
        foregroundSeconds: 640,
        runningSeconds: 3_600,
        cleanShutdowns: 1,
        uncleanExits: 0,
      },
    ],
    crashes: [
      {
        occurredAtMs: 1_754_651_000_000n,
        appVersion: '2.2.0',
        source: CrashSource.REACT_BOUNDARY,
        exceptionType: 'TypeError',
        fingerprint: bytes(9),
        stack: 'at FlowRunsGrid (app:/assets/index.js:1:2)',
        count: 2,
      },
    ],
    droppedRecords: 0,
  });
}

describe('codec', () => {
  it('round-trips every field', () => {
    const original = sampleBatch();
    const decoded = decodeBatch(encodeBatch(original));

    expect(decoded.appVersion).toBe('2.2.0');
    expect(decoded.platform).toBe(Platform.LINUX);
    expect(decoded.periodStartMs).toBe(1_754_650_000_000n);
    expect(decoded.features).toHaveLength(2);
    expect(decoded.features[0].featureId).toBe(Feature.FLOW_CREATED);
    expect(decoded.operations[0].buckets).toHaveLength(DURATION_BUCKET_COUNT);
    expect(decoded.operations[0].durationSumMs).toBe(48_000n);
    expect(decoded.operations[0].failures[0].errorCategory).toBe(ErrorCategory.RATE_LIMIT);
    expect(decoded.usage[0].runningSeconds).toBe(3_600);
    expect(decoded.crashes[0].exceptionType).toBe('TypeError');
    expect(bytesToHex(decoded.installationId)).toBe(bytesToHex(bytes(2)));
  });

  it('compresses a realistic batch to well under the transport budget', () => {
    // Not a performance assertion — a canary. If this ever balloons, something started putting
    // non-repetitive data in the format.
    expect(encodeBatch(sampleBatch()).length).toBeLessThan(1024);
  });

  it('accepts a legitimate payload that happens to compress enormously', () => {
    // 60 KB of repetitive text deflates to ~76 bytes — a ratio near 790:1, and entirely benign.
    // This is the case a compression-ratio guard would wrongly reject, which is why the guard is
    // an absolute size cap instead. Regression test for that decision.
    const big = create(TelemetryBatchSchema, {
      batchId: bytes(4),
      schemaVersion: SCHEMA_VERSION,
      installationId: bytes(5),
      deploymentId: bytes(6),
      appVersion: '2.2.0',
      crashes: [
        {
          occurredAtMs: 1n,
          appVersion: '2.2.0',
          source: CrashSource.MAIN_UNCAUGHT,
          exceptionType: 'Error',
          fingerprint: bytes(0),
          stack: 'a'.repeat(60_000),
          count: 1,
        },
      ],
    });
    const encoded = encodeBatch(big);
    expect(encoded.length).toBeLessThan(1024);
    expect(decodeBatch(encoded).crashes[0].stack).toHaveLength(60_000);
  });

  it('refuses a payload that inflates past the absolute cap', () => {
    // Hand-built rather than produced by encodeBatch: the client can never emit this, which is
    // exactly why the receiver has to be able to reject it.
    const bomb = bytesToBase64(deflateSync(new Uint8Array(MAX_INFLATED_BYTES + 1024)));
    expect(() => decodeBatch(bomb)).toThrow(/inflate within limits/);
  });

  it('rejects an oversized payload rather than decoding a truncated prefix of it', () => {
    // The subtle failure this guards. fflate does not throw when output overruns a fixed buffer,
    // it truncates — and a truncated proto3 message frequently still parses, just with trailing
    // fields missing. So an oversized batch could arrive as a *plausible* batch with its crash
    // list silently dropped. Build a real, valid, over-cap batch and require a throw, not a parse.
    const huge = create(TelemetryBatchSchema, {
      batchId: bytes(8),
      schemaVersion: SCHEMA_VERSION,
      installationId: bytes(8),
      deploymentId: bytes(8),
      appVersion: '2.2.0',
      // Well past MAX_INFLATED_BYTES once serialized, while still compressing small enough to get
      // past the compressed-size check and reach the inflate guard.
      crashes: Array.from({ length: 40 }, () => ({
        occurredAtMs: 1n,
        appVersion: '2.2.0',
        source: CrashSource.MAIN_UNCAUGHT,
        exceptionType: 'Error',
        fingerprint: bytes(0),
        stack: 'b'.repeat(40_000),
        count: 1,
      })),
    });
    const oversized = bytesToBase64(
      deflateSync(toBinary(TelemetryBatchSchema, huge), { level: 6 }),
    );

    expect(() => decodeBatch(oversized)).toThrow(/inflate within limits/);
  });

  it('rejects malformed base64', () => {
    expect(() => decodeBatch('!!!not base64!!!')).toThrow();
  });
});

describe('Ably transport', () => {
  const receiverSec = secp256k1.utils.randomSecretKey();
  const receiverPub = bytesToHex(schnorr.getPublicKey(receiverSec));

  it('survives encode → seal → publish → open → decode', () => {
    const batch = sampleBatch();

    // ── client ──
    const message = sealBatch(encodeBatch(batch), receiverPub);

    // ── the wire: everything below sees only what Ably would carry ──
    const wire = JSON.parse(JSON.stringify(message));

    // ── receiver ──
    const decoded = decodeBatch(openBatch(wire, receiverSec));

    expect(bytesToHex(decoded.batchId)).toBe(bytesToHex(batch.batchId));
    expect(decoded.features[0].count).toBe(3);
    expect(decoded.crashes[0].stack).toBe('at FlowRunsGrid (app:/assets/index.js:1:2)');
  });

  it('exposes nothing identifying outside the ciphertext', () => {
    // Ably sees the channel name, the timing and the size. The installation id must be inside the
    // encrypted payload, and the ephemeral sender key must not be derived from it.
    const batch = sampleBatch();
    const message = sealBatch(encodeBatch(batch), receiverPub);

    expect(message.epk).not.toBe(bytesToHex(batch.installationId));
    expect(JSON.stringify({ v: message.v, epk: message.epk })).not.toContain(
      bytesToHex(batch.installationId),
    );
  });

  it('uses a fresh sender key for every batch', () => {
    // Nothing is stored, so nothing ties two batches from one installation together — which is
    // also why there is no key rotation to schedule.
    const encoded = encodeBatch(sampleBatch());
    const a = sealBatch(encoded, receiverPub);
    const b = sealBatch(encoded, receiverPub);

    expect(a.epk).not.toBe(b.epk);
    // Same plaintext, different ciphertext: the nonce is fresh too.
    expect(a.payload).not.toBe(b.payload);
  });

  it('cannot be opened with the wrong receiver key', () => {
    // The property that makes an extracted publish-only credential harmless for reading.
    const other = secp256k1.utils.randomSecretKey();
    const message = sealBatch(encodeBatch(sampleBatch()), receiverPub);
    expect(() => openBatch(message, other)).toThrow(/invalid MAC/);
  });

  it('rejects a tampered payload', () => {
    const message = sealBatch(encodeBatch(sampleBatch()), receiverPub);
    const mid = Math.floor(message.payload.length / 2);
    const tampered = {
      ...message,
      payload:
        message.payload.slice(0, mid) +
        (message.payload[mid] === 'A' ? 'B' : 'A') +
        message.payload.slice(mid + 1),
    };
    expect(() => openBatch(tampered, receiverSec)).toThrow();
  });

  it('validates the envelope before reaching any crypto', () => {
    // A malformed key must be rejected here, not discovered as a throw from inside the curve
    // implementation — the receiver processes untrusted input and must fail predictably.
    for (const bad of [
      null,
      'not an object',
      { v: 99, epk: 'a'.repeat(64), payload: 'x' },
      { v: 1, epk: 'nope', payload: 'x' },
      { v: 1, epk: 'A'.repeat(64), payload: 'x' }, // uppercase hex
      { v: 1, epk: 'a'.repeat(63), payload: 'x' },
      { v: 1, epk: 'a'.repeat(64) },
      { v: 1, epk: 'a'.repeat(64), payload: '' },
    ]) {
      expect(() => openBatch(bad, receiverSec)).toThrow();
    }
  });

  it('publishes to one channel and nothing else', () => {
    expect(TELEMETRY_CHANNEL).toBe('jobmonitor:telemetry:v1');
  });
});

describe('transport size budget', () => {
  const receiverSec = secp256k1.utils.randomSecretKey();
  const receiverPub = bytesToHex(schnorr.getPublicKey(receiverSec));

  it('a worst-case batch at the deflate cap still fits inside Ably\'s message limit', () => {
    // The assertion that makes MAX_DEFLATED_BYTES trustworthy. The chain expands a payload by
    // roughly 2.2× (base64, NIP-44 padding, framing, base64 again), and an expansion estimate that
    // is wrong by 10% would only surface as publish failures from the users with the most data —
    // the ones whose telemetry we most want. So the budget is measured, not calculated.
    //
    // Incompressible bytes, so the deflated size is genuinely at the cap rather than a compressed
    // fraction of it.
    const incompressible = bytesToBase64(
      Uint8Array.from({ length: MAX_DEFLATED_BYTES }, (_, i) => (i * 2654435761) % 256),
    ).slice(0, MAX_DEFLATED_BYTES);

    const sealed = sealBatch(incompressible, receiverPub);
    const wireBytes = Buffer.byteLength(JSON.stringify(sealed), 'utf8');

    expect(wireBytes).toBeLessThan(MAX_ABLY_MESSAGE_BYTES);
    expect(openBatch(sealed, receiverSec)).toBe(incompressible);
  });

  it('refuses to seal a message over the cap rather than letting Ably reject it', () => {
    // A publish rejected for size is data lost with no retry that could ever succeed.
    expect(() => sealBatch('x'.repeat(MAX_MESSAGE_CHARS), receiverPub)).toThrow(/over the/);
  });
});

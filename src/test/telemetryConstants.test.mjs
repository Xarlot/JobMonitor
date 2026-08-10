/**
 * The duplicated constants must match the schema package.
 *
 * `electron/telemetry/constants.mjs` restates a handful of values that `@jobmonitor/telemetry-
 * schema` already defines. The duplication is deliberate: the *record* path runs on every user
 * action, and importing the schema package there would drag the protobuf runtime, three noble
 * crypto libraries and fflate into it — a real cost paid on every click, to obtain four numbers.
 *
 * The risk of that trade is drift, and drift here is silent in the worst way. If the client's
 * bucket bounds diverged from the schema's, every histogram would still be produced, still be
 * eight numbers wide, still validate — and mean something different from what the dashboard label
 * says. This test is the entire mitigation, so it checks values rather than just shapes.
 */

import { describe, expect, it } from 'vitest';

import * as client from '../../electron/telemetry/constants.mjs';
import * as schema from '../../packages/telemetry-schema/src/limits.ts';

describe('client constants match the schema package', () => {
  it('uses identical duration bucket bounds', () => {
    // The one that would silently change the meaning of every performance chart.
    expect(client.DURATION_BUCKET_BOUNDS_MS).toEqual([...schema.DURATION_BUCKET_BOUNDS_MS]);
    expect(client.DURATION_BUCKET_COUNT).toBe(schema.DURATION_BUCKET_COUNT);
  });

  it('agrees on every shared cadence', () => {
    expect(client.IPC_FLUSH_MS).toBe(schema.IPC_FLUSH_MS);
    expect(client.SPOOL_FLUSH_MS).toBe(schema.SPOOL_FLUSH_MS);
    expect(client.HEARTBEAT_MS).toBe(schema.HEARTBEAT_MS);
    expect(client.USAGE_BUCKET_MS).toBe(schema.USAGE_BUCKET_MS);
  });

  it('agrees on identifier width and crash-storm limits', () => {
    expect(client.ID_BYTES).toBe(schema.ID_BYTES);
    expect(client.MAX_CRASHES_PER_FINGERPRINT).toBe(schema.MAX_CRASHES_PER_FINGERPRINT);
    expect(client.MAX_CRASHES_PER_SESSION).toBe(schema.MAX_CRASHES_PER_SESSION);
  });

  it('bucket bounds are the same object shape, not merely equal lengths', () => {
    // Guards the case where both sides have 7 bounds but one of them moved.
    for (let i = 0; i < schema.DURATION_BUCKET_BOUNDS_MS.length; i++) {
      expect(client.DURATION_BUCKET_BOUNDS_MS[i], `bound ${i}`).toBe(
        schema.DURATION_BUCKET_BOUNDS_MS[i],
      );
    }
  });
});

/**
 * Publish one test batch to the real Ably channel, exactly as a desktop client would.
 *
 *   npm run dev:publish
 *
 * Uses the shared schema package's own `sealBatch` and the client's publish-only key, so this
 * exercises the real encoding, compression, encryption and envelope — not a simulation of them.
 * Together with `npm run dev:ingest` it makes the whole chain testable from one terminal:
 *
 *   publish → Ably → history read → validation → SQLite → dashboard
 *
 * **This writes to the real channel.** The installation id below is fixed and obviously synthetic
 * so test data can be told apart from, and deleted separately to, anything real:
 *
 *   DELETE FROM usage WHERE installation = 'dd'||'dd'…   -- see TEST_INSTALLATION
 */

import { it } from 'vitest';
import Ably from 'ably';
import { create } from '@bufbuild/protobuf';

import {
  Arch,
  CrashSource,
  Platform,
  SCHEMA_VERSION,
  TELEMETRY_CHANNEL,
  TELEMETRY_MESSAGE_NAME,
  TelemetryBatchSchema,
  encodeBatch,
  sealBatch,
} from '@jobmonitor/telemetry-schema';
import { ErrorCategory, Feature, Operation } from '@jobmonitor/telemetry-schema/registry';

/** Fixed and obviously synthetic, so test rows are identifiable and separately deletable. */
const TEST_INSTALLATION = new Uint8Array(16).fill(0xdd);

const HOUR = 3_600_000;

it('publishes a test batch', async () => {
  const publishKey = process.env.TELEMETRY_ABLY_KEY;
  const receiverPub = process.env.TELEMETRY_RECEIVER_PUBKEY;
  const deploymentId = process.env.TELEMETRY_DEPLOYMENT_ID;

  if (!publishKey || !receiverPub || !deploymentId) {
    console.log('\nNeeds TELEMETRY_ABLY_KEY, TELEMETRY_RECEIVER_PUBKEY and TELEMETRY_DEPLOYMENT_ID');
    console.log('in .env.local — the same three values a client build is given.\n');
    return;
  }

  const now = Date.now();
  const bucket = Math.floor((now - HOUR) / HOUR) * HOUR;

  const batch = create(TelemetryBatchSchema, {
    // Random, so the batch is never a duplicate of an earlier run — which is what makes it useful
    // to run this repeatedly while watching the dashboard.
    batchId: crypto.getRandomValues(new Uint8Array(16)),
    schemaVersion: SCHEMA_VERSION,
    installationId: TEST_INSTALLATION,
    deploymentId: Uint8Array.from(Buffer.from(deploymentId, 'hex')),
    appVersion: '2.2.0',
    platform: Platform.LINUX,
    arch: Arch.X64,
    electronVersion: '42.5.0',
    periodStartMs: BigInt(now - HOUR),
    periodEndMs: BigInt(now),
    features: [
      { featureId: Feature.VIEW_FLOWS, count: 4 },
      { featureId: Feature.FLOW_CREATED, count: 1 },
      { featureId: Feature.AI_TRIAGE_DEEP, count: 1 },
    ],
    operations: [
      {
        operationId: Operation.GH_PR_LIST_POLL,
        count: 6,
        durationSumMs: 1_450n,
        durationMaxMs: 620,
        buckets: [1, 1, 2, 1, 1, 0, 0, 0],
        failures: [{ errorCategory: ErrorCategory.RATE_LIMIT, count: 1 }],
      },
    ],
    usage: [
      {
        bucketStartMs: BigInt(bucket),
        appStarts: 1,
        sessionCount: 1,
        foregroundSeconds: 320,
        runningSeconds: 1_800,
        cleanShutdowns: 1,
        uncleanExits: 0,
      },
    ],
    crashes: [
      {
        occurredAtMs: BigInt(now - 60_000),
        appVersion: '2.2.0',
        source: CrashSource.REACT_BOUNDARY,
        exceptionType: 'TypeError',
        fingerprint: new Uint8Array(16).fill(0xab),
        // Already in the shape the client's sanitizer produces — the receiver rejects traces that
        // do not look sanitized, so an unsanitized one here would be redacted on arrival.
        stack: 'at FlowRunsGrid (app:/assets/index.js:42:13)\nin FlowRunsGrid < FlowsView',
        count: 1,
      },
    ],
    droppedRecords: 0,
  });

  const message = sealBatch(encodeBatch(batch), receiverPub);
  const client = new Ably.Rest({ key: publishKey, logLevel: 0 });

  await client.channels.get(TELEMETRY_CHANNEL).publish([
    {
      name: TELEMETRY_MESSAGE_NAME,
      data: message,
      // The batch id doubles as the Ably message id, so a retried publish cannot become two.
      id: Buffer.from(batch.batchId).toString('hex'),
    },
  ]);

  console.log(`\nPublished batch ${Buffer.from(batch.batchId).toString('hex').slice(0, 8)}`);
  console.log(`  channel     ${TELEMETRY_CHANNEL}`);
  console.log(`  installation ${Buffer.from(TEST_INSTALLATION).toString('hex')}  (synthetic)`);
  console.log('\nNext: npm run dev:ingest, then open http://localhost:3000\n');
}, 60_000);

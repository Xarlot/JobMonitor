import { it } from 'vitest';
import { rmSync } from 'node:fs';

import { create } from '@bufbuild/protobuf';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/ciphers/utils.js';
import { Arch, CrashSource, Platform, SCHEMA_VERSION, TelemetryBatchSchema, encodeBatch, sealBatch } from '@jobmonitor/telemetry-schema';
import { ErrorCategory, Feature, Operation } from '@jobmonitor/telemetry-schema/registry';
import { database, resetDatabase } from '../src/lib/db';
import { processMessage } from '../src/receiver/pipeline';

const SEC = new Uint8Array(32).fill(9);
const PUB = bytesToHex(schnorr.getPublicKey(SEC));
const DEP = 'a'.repeat(32);
const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * Development seed — NOT a test.
 *
 * Run with `npx vitest run --root . scripts/seed.ts` to fill a local database with a realistic
 * three weeks of telemetry, so the dashboards can be looked at without waiting for real data.
 * Lives outside `test/` so the ordinary suite never runs it.
 */
it('seeds a realistic dataset', () => {
  // Same default the app uses in development, so `npm run dev` picks it straight up.
  process.env.TELEMETRY_DB ??= './.data/telemetry.db';

  /**
   * Start from an empty database, every time.
   *
   * The batch ids below are deterministic, so seeding twice over an existing database produces the
   * same ids and deduplication rejects every one of them — correctly, which is what makes it a
   * confusing failure: the pipeline is working exactly as designed and the script looks broken.
   *
   * Making the ids random would be worse. It would succeed and silently double every count, so a
   * second run leaves a dataset that looks plausible and is wrong. "Seed" means a known dataset;
   * appending a second copy of it is not a thing anyone wants.
   */
  const file = process.env.TELEMETRY_DB;
  resetDatabase();
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(file + suffix, { force: true });
  }
  const db = database();
  const now = Date.now();
  let n = 0;

  /** Three routes through the app, each ending somewhere different. */
  const JOURNEYS: number[][] = [
    [Feature.VIEW_FAILURES, Feature.LOGS_JOB_OPENED, Feature.AI_TRIAGE_QUICK, Feature.FAILURES_REPORT_COPIED],
    [Feature.VIEW_FLOWS, Feature.FLOW_RUN_EXPANDED, Feature.LOGS_TIMELINE_OPENED, Feature.ARTIFACT_DOWNLOADED],
    [Feature.VIEW_PRS, Feature.PR_CHECKS_EXPANDED, Feature.LOGS_JOB_SUMMARY_OPENED, Feature.RERUN_MANUAL],
  ];

  // 12 installations over 21 days — enough for the charts to have shape.
  for (let day = 20; day >= 0; day--) {
    const ts = now - day * DAY;
    for (let inst = 0; inst < 8 + (day % 5); inst++) {
      const deps = { db, secretKeys: [SEC], deploymentId: DEP, ratePerHour: 1000, now: () => ts };
      const install = new Uint8Array(16).fill(inst + 1);
      const bucket = Math.floor((ts - HOUR) / HOUR) * HOUR;
      const batch = create(TelemetryBatchSchema, {
        batchId: (() => { const b = new Uint8Array(16); new DataView(b.buffer).setUint32(0, n); b[8] = day; b[9] = inst; return b; })(),
        schemaVersion: SCHEMA_VERSION,
        installationId: install,
        deploymentId: Uint8Array.from(Buffer.from(DEP, 'hex')),
        appVersion: day > 10 ? '2.1.0' : '2.2.0',
        platform: Platform.LINUX, arch: Arch.X64, electronVersion: '42.5.0',
        periodStartMs: BigInt(ts - HOUR), periodEndMs: BigInt(ts),
        features: [
          { featureId: Feature.VIEW_FLOWS, count: 5 + inst },
          { featureId: Feature.FLOW_CREATED, count: 1 + (inst % 3) },
          { featureId: Feature.AI_TRIAGE_DEEP, count: inst % 2 },
          { featureId: Feature.ARTIFACT_BUNDLE_DOWNLOADED, count: day % 3 },
        ].filter((f) => f.count > 0),
        /*
         * A trail, so the feature map has something to draw.
         *
         * Written as a few plausible journeys rather than random pairs: the map exists to show
         * routes through the product, and noise would render as an even mesh that looks like data
         * and means nothing. Each installation walks one of three paths, so the picture has the
         * lopsidedness real usage has.
         */
        trails: [
          {
            bucketStartMs: BigInt(bucket),
            featureIds: JOURNEYS[inst % JOURNEYS.length],
            offsetDeltasS: JOURNEYS[inst % JOURNEYS.length].map((_, i) => (i === 0 ? 30 : 20 + ((inst + i) % 40))),
            truncated: false,
          },
        ],
        operations: [{
          operationId: Operation.GH_PR_LIST_POLL, count: 12,
          durationSumMs: BigInt(1800 + inst * 100), durationMaxMs: 900,
          buckets: [2, 3, 3, 2, 1, 1, 0, 0],
          failures: inst % 4 === 0 ? [{ errorCategory: ErrorCategory.RATE_LIMIT, count: 1 }] : [],
        }],
        usage: [{
          bucketStartMs: BigInt(bucket), appStarts: 1, sessionCount: 1,
          foregroundSeconds: 400 + inst * 30, runningSeconds: 3000, cleanShutdowns: 1, uncleanExits: 0,
        }],
        crashes: (day % 4 === 0 && inst < 2) ? [{
          occurredAtMs: BigInt(ts - 1000), appVersion: day > 10 ? '2.1.0' : '2.2.0',
          source: CrashSource.REACT_BOUNDARY, exceptionType: inst === 0 ? 'TypeError' : 'RangeError',
          fingerprint: new Uint8Array(16).fill(inst === 0 ? 0xab : 0xcd),
          stack: 'at FlowRunsGrid (app:/assets/index.js:42:13)\nin FlowRunsGrid < FlowsView', count: 1,
        }] : [],
        droppedRecords: 0,
      });
      const r = processMessage(deps, sealBatch(encodeBatch(batch), PUB));
      if (r.status !== 'accepted') throw new Error('seed rejected: ' + JSON.stringify(r));
      n++;
    }
  }
  // A successful run just now, so the dashboard does not open with a "telemetry may be
  // incomplete" banner over generated data — which would be true of the banner and confusing here.
  db.prepare(
    `INSERT INTO ingest_runs (ts, ok, messages, accepted, duplicates, rejected, duration_ms, error)
     VALUES (?,1,?,?,0,0,1200,NULL)`,
  ).run(now, n, n);

  console.log(`\nSeeded ${n} batches across 21 days (database recreated).`);
  console.log('  npm run dev   →  http://localhost:3000\n');
});

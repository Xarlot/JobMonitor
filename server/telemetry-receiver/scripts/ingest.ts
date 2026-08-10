/**
 * Run one ingest pass locally, without the server.
 *
 *   npm run dev:ingest
 *
 * Goes straight to `pullOnce` rather than through `POST /api/ingest`, so it works with nothing
 * running and the output lands in the terminal you invoked it from. The HTTP route is the same code
 * behind an auth check.
 *
 * Run through vitest because that is the TypeScript runner this repository already has — it
 * resolves the workspace package and the extensionless imports without adding a second toolchain
 * for the sake of three scripts.
 */

import { it } from 'vitest';

import { loadConfig } from '../src/lib/config';
import { database } from '../src/lib/db';
import { pullOnce } from '../src/receiver/puller';

it('pulls once from Ably', async () => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // The common case in a fresh checkout, and worth saying plainly rather than as a stack trace.
    console.log(`\nNot configured: ${(err as Error).message}`);
    console.log('Copy .env.local.example to .env.local and fill in the LIVE values,');
    console.log('or use `npm run dev:seed` to work against generated data instead.\n');
    return;
  }

  console.log(`\nReading ${config.retentionHours}h of history…`);
  const result = await pullOnce({
    ablyKey: config.ablySubscribeKey,
    retentionHours: config.retentionHours,
    intervalHours: config.intervalHours,
    dedupRetentionDays: config.dedupRetentionDays,
    deps: {
      db: database(),
      secretKeys: config.receiverSecKeys.map((k) => Uint8Array.from(Buffer.from(k, 'hex'))),
      deploymentId: config.deploymentId,
      ratePerHour: config.ratePerHour,
      now: () => Date.now(),
    },
  });

  console.log('\n' + JSON.stringify(result, null, 2));
  if (result.rejected > 0) {
    console.log('\nRejections are recorded by rule — see /health, or:');
    console.log("  sqlite3 .data/telemetry.db 'SELECT rule, COUNT(*) FROM rejections GROUP BY rule'");
  }
  console.log();
}, 300_000);

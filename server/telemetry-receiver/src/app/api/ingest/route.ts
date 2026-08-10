/**
 * The ingest trigger.
 *
 * **This is not a telemetry ingestion endpoint.** No batch is ever posted here — telemetry still
 * arrives only by this server reaching *out* to Ably. What this route accepts is a nudge saying
 * "go and read history now", and the worst an attacker can do by calling it is make us do work we
 * were going to do anyway, against a cursor that makes repeats free.
 *
 * It is still authenticated, because unbounded free work is a denial-of-service primitive even when
 * it is harmless work.
 */

import { NextResponse } from 'next/server';

import { loadConfig } from '@/lib/config';
import { database } from '@/lib/db';
import { log } from '@/lib/log';
import { pullOnce } from '@/receiver/puller';

// No `dynamic` export: route handlers are uncached by default and POST is never cached, so
// forcing it would only be noise.
/** Ingest reads and writes SQLite; it cannot run on the edge runtime. */
export const runtime = 'nodejs';
/** A run after a long gap pages through history; the default 15s is not enough. */
export const maxDuration = 300;

export async function POST(request: Request) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error('ingest: configuration invalid', { message: String((err as Error)?.message ?? err) });
    return NextResponse.json({ ok: false, error: 'not configured' }, { status: 503 });
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!timingSafeEqual(provided, config.ingestToken)) {
    // Deliberately terse. A verbose auth failure tells a prober how close they are.
    return NextResponse.json({ ok: false }, { status: 401 });
  }

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

  log.info('ingest run', { ...result });
  // 200 even on failure: the caller is a scheduler, and the body carries the outcome. A 500 would
  // make a transient Ably hiccup look like a broken deployment in the cron's own history.
  return NextResponse.json(result);
}

/** Constant time, so the response time does not leak how much of the token was right. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

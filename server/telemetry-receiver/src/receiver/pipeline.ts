/**
 * The ordered processing pipeline.
 *
 * ```
 * size → envelope → decrypt → decompress → parse → schema → privacy
 *      → dedupe check → durable write → dedupe insert → done
 * ```
 *
 * **Nothing here throws to the caller.** Every stage returns a value. A malformed message must cost
 * that message and nothing else — the subscriber is a long-lived process and one bad payload
 * taking it down would stop telemetry for every installation until someone noticed.
 *
 * Rejections are logged and counted by *rule*, never by value. That is how a client bug is
 * discovered: a sudden spike in `histogram-mismatch` names both the defect and the version.
 */

import type { DatabaseSync } from 'node:sqlite';
import { decodeBatch, openBatch } from '@jobmonitor/telemetry-schema';
import { MAX_MESSAGE_CHARS } from '@jobmonitor/telemetry-schema/limits';

import { checkEnvelope } from './privacy';
import { recordRejections, withinRateLimit, writeBatch } from './store';

export type Outcome =
  | { status: 'accepted'; batchId: string; records: number; dropped: number }
  | { status: 'duplicate'; batchId: string }
  | { status: 'rejected'; rule: string; field?: string; batchId?: string };

export interface PipelineDeps {
  db: DatabaseSync;
  /** Receiver secret keys, newest first — a list so a key can be rotated without dropping
   *  in-flight batches from clients still carrying the old public half. */
  secretKeys: Uint8Array[];
  deploymentId: string;
  ratePerHour: number;
  now: () => number;
}

export function processMessage(deps: PipelineDeps, raw: unknown): Outcome {
  const now = deps.now();

  // 1. Size, before anything is parsed or allocated.
  const approxSize = typeof raw === 'string' ? raw.length : JSON.stringify(raw ?? null).length;
  if (approxSize > MAX_MESSAGE_CHARS * 2) {
    return reject(deps, now, { rule: 'oversize', field: 'message' });
  }

  // 2. Envelope shape and decryption. Every key is tried: during a rotation both are valid, and
  // which one applies depends on how old the sending client's build is.
  let encoded: string | null = null;
  for (const key of deps.secretKeys) {
    try {
      encoded = openBatch(raw, key);
      break;
    } catch {
      // Wrong key, or not ours at all. Try the next; a failure here is the expected outcome for
      // anything published to the channel by someone else.
    }
  }
  if (encoded === null) return reject(deps, now, { rule: 'undecryptable' });

  // 3. Decompress and parse. Both bounded inside decodeBatch.
  let batch;
  try {
    batch = decodeBatch(encoded);
  } catch {
    return reject(deps, now, { rule: 'unparseable' });
  }

  // 4. Envelope-level validation. A failure here means the sender is not what we think.
  const envelope = checkEnvelope(batch, deps.deploymentId, now);
  if (!envelope.ok) {
    return reject(deps, now, { rule: envelope.rule, field: envelope.field });
  }

  const installation = Buffer.from(batch.installationId).toString('hex');
  const batchId = Buffer.from(batch.batchId).toString('hex');

  // 5. Rate limit. The real control on a model that cannot authenticate senders.
  if (!withinRateLimit(deps.db, installation, now, deps.ratePerHour)) {
    return reject(deps, now, { rule: 'rate-limited', batchId });
  }

  // 6. Record validation and the durable write, in one transaction with the dedup row.
  const result = writeBatch(deps.db, batch, now);
  if (result.duplicate) return { status: 'duplicate', batchId };

  if (result.dropped.length > 0) recordRejections(deps.db, now, batchId, result.dropped);

  return {
    status: 'accepted',
    batchId,
    records: result.records,
    dropped: result.dropped.length,
  };
}

function reject(
  deps: PipelineDeps,
  now: number,
  r: { rule: string; field?: string; batchId?: string },
): Outcome {
  recordRejections(deps.db, now, r.batchId ?? null, [{ rule: r.rule, field: r.field }]);
  return { status: 'rejected', ...r };
}

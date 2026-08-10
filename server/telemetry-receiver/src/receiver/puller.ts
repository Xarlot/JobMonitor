/**
 * Pulling telemetry out of Ably history, on demand.
 *
 * **This replaced a persistent WebSocket subscriber, and the change removed more than it added.**
 * Ably stores published messages durably, so a live subscription was never the only way to receive
 * them — it was simply the way that required a process to be alive at the moment each message
 * arrived. Reading history instead means:
 *
 *   - no `Always On`, and no dependency on a persistent Node process at all;
 *   - no reconnect logic, no connection state machine, no half-open-subscription detection;
 *   - a missed run costs nothing, because the next one picks up from the cursor.
 *
 * **The invariant that replaced the old one.** The previous design had to keep the backfill window
 * inside the dedup retention or a restart would double-count. This one has the opposite failure:
 * if the gap between runs ever exceeds Ably's retention, the messages in that gap are *gone* — not
 * duplicated, not delayed, gone, with nothing anywhere reporting it. So the schedule must stay
 * comfortably inside the retention window, and {@link assertScheduleFitsRetention} checks it at
 * startup rather than leaving it to a comment.
 */

import Ably from 'ably';
import type { DatabaseSync } from 'node:sqlite';
import { TELEMETRY_CHANNEL, TELEMETRY_MESSAGE_NAME } from '@jobmonitor/telemetry-schema';

import { log } from '../lib/log';
import { processMessage, type PipelineDeps } from './pipeline';
import { pruneRetention } from './store';

/**
 * Overlap re-read on every run.
 *
 * The cursor records the newest message seen, but Ably orders by server time and a message
 * published a moment before the cursor could still be settling. Re-reading a slice costs nothing —
 * deduplication by `batch_id` discards the repeats — and not re-reading it would silently drop
 * whatever landed in that window.
 */
const OVERLAP_MS = 5 * 60_000;

/** Pages of 1000. A run after a long outage should not need many, but it must not need unbounded. */
const PAGE_LIMIT = 1000;
const MAX_PAGES = 100;

export interface PullOptions {
  ablyKey: string;
  deps: PipelineDeps;
  /** Ably's retention for this channel, hours. Free tier is 24; Standard 72 or more. */
  retentionHours: number;
  /** How often the schedule runs, hours. Used only for the startup safety check. */
  intervalHours: number;
  dedupRetentionDays: number;
}

export interface PullResult {
  ok: boolean;
  messages: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  durationMs: number;
  error?: string;
}

/**
 * Refuse a schedule that cannot keep up with expiry.
 *
 * Called at startup and again before each run. The failure it prevents is the worst kind available
 * in this system: data that was published, accepted by Ably, and then expired unread — invisible on
 * every chart, because the charts can only show what arrived.
 */
export function assertScheduleFitsRetention(intervalHours: number, retentionHours: number): void {
  // Two consecutive failures should still be survivable — a deploy plus a transient error is an
  // ordinary Tuesday. Three intervals inside the window is the minimum worth accepting.
  const needed = intervalHours * 3;
  if (needed > retentionHours) {
    throw new Error(
      `Ingest runs every ${intervalHours}h but Ably retains messages for only ${retentionHours}h. ` +
        `Two consecutive failed runs would lose data permanently. Either run more often ` +
        `(interval <= ${(retentionHours / 3).toFixed(1)}h) or raise retention.`,
    );
  }
}

function readCursor(db: DatabaseSync): { ts: number; id: string | null } {
  const row = db.prepare('SELECT last_ts, last_id FROM ingest_cursor WHERE id = 1').get() as
    | { last_ts: number; last_id: string | null }
    | undefined;
  return { ts: row?.last_ts ?? 0, id: row?.last_id ?? null };
}

function writeCursor(db: DatabaseSync, ts: number, id: string | null): void {
  db.prepare(
    `INSERT INTO ingest_cursor (id, last_ts, last_id) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_ts = excluded.last_ts, last_id = excluded.last_id`,
  ).run(ts, id);
}

/**
 * Run one ingest pass.
 *
 * Never throws. The caller is an HTTP route or a scheduled job, and both want a result they can
 * record rather than an exception they have to interpret.
 */
export async function pullOnce(options: PullOptions): Promise<PullResult> {
  const { deps, ablyKey, retentionHours, intervalHours, dedupRetentionDays } = options;
  const startedAt = deps.now();
  const result: PullResult = {
    ok: false,
    messages: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    durationMs: 0,
  };

  try {
    assertScheduleFitsRetention(intervalHours, retentionHours);

    const cursor = readCursor(deps.db);
    // First ever run: take everything Ably still holds. Afterwards: from the cursor, minus overlap.
    const start =
      cursor.ts > 0
        ? cursor.ts - OVERLAP_MS
        : startedAt - retentionHours * 3_600_000;

    const client = new Ably.Rest({ key: ablyKey, logLevel: 0 });
    const channel = client.channels.get(TELEMETRY_CHANNEL);

    let page = await channel.history({
      start,
      end: startedAt,
      direction: 'forwards',
      limit: PAGE_LIMIT,
    });

    let newestTs = cursor.ts;
    let newestId = cursor.id;

    for (let pages = 0; pages < MAX_PAGES; pages++) {
      for (const message of page.items) {
        result.messages++;
        if (message.timestamp && message.timestamp > newestTs) {
          newestTs = message.timestamp;
          newestId = message.id ?? null;
        }
        if (message.name !== TELEMETRY_MESSAGE_NAME) continue;

        const outcome = processMessage(deps, message.data);
        if (outcome.status === 'accepted') result.accepted++;
        else if (outcome.status === 'duplicate') result.duplicates++;
        else {
          result.rejected++;
          // Rule and field only — never the value.
          log.warn('batch rejected', { rule: outcome.rule, field: outcome.field });
        }
      }

      if (!page.hasNext()) break;
      const next = await page.next();
      if (!next) break;
      page = next;
    }

    // Written only after the whole pass. A crash midway leaves the cursor where it was, so the next
    // run re-reads the same slice — which dedup makes free, and which is the direction to fail in.
    if (newestTs > cursor.ts) writeCursor(deps.db, newestTs, newestId);

    pruneRetention(deps.db, deps.now(), dedupRetentionDays);

    result.ok = true;
  } catch (err) {
    result.error = String((err as Error)?.message ?? err);
    log.error('ingest failed', { error: result.error });
  }
  // No teardown: Ably's REST client holds no connection to close — it is a stateless HTTP wrapper,
  // which is precisely why this design does not need a process to stay alive.

  result.durationMs = deps.now() - startedAt;
  recordRun(deps.db, deps.now(), result);
  return result;
}

/**
 * Record every run, successful or not.
 *
 * With no long-lived process there is no heartbeat, so "is ingest alive" becomes "when did a run
 * last succeed" — which is a better question anyway, because it survives the process restarting and
 * cannot be answered wrongly by a process that is running but stuck.
 */
function recordRun(db: DatabaseSync, at: number, result: PullResult): void {
  try {
    db.prepare(
      `INSERT INTO ingest_runs (ts, ok, messages, accepted, duplicates, rejected, duration_ms, error)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      at,
      result.ok ? 1 : 0,
      result.messages,
      result.accepted,
      result.duplicates,
      result.rejected,
      result.durationMs,
      result.error ?? null,
    );
  } catch (err) {
    log.warn('could not record ingest run', { message: String((err as Error)?.message ?? err) });
  }
}

/** When ingest last ran, and whether it worked. Drives the health page and the staleness trigger. */
export function lastRun(db: DatabaseSync) {
  return db.prepare('SELECT * FROM ingest_runs ORDER BY ts DESC LIMIT 1').get() as
    | {
        ts: number;
        ok: number;
        messages: number;
        accepted: number;
        duplicates: number;
        rejected: number;
        duration_ms: number;
        error: string | null;
      }
    | undefined;
}

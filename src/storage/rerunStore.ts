/**
 * What we have already asked GitHub to re-run, keyed by workflow-run id.
 *
 * Persistence is load-bearing rather than a nicety. The auto-rerun trigger is
 * state-based — it acts on any completed+failed run, including one that failed
 * while the app was closed — so without a durable record every page reload would
 * re-POST for a run it had already handled.
 *
 * The stored fingerprints are also what makes "stop when the failure repeats
 * identically" work across restarts: comparing this attempt's failure against the
 * previous attempt's requires remembering the previous one.
 */

import type { RerunSkipReason } from '../lib/autoRerun';

export interface RerunAttempt {
  /** GitHub's `run_attempt` that we asked to re-run (1-based). */
  attempt: number;
  /** Failure fingerprint of that attempt; null when it couldn't be computed. */
  fingerprint: string | null;
  /** When the request was made (epoch ms). */
  at: number;
  /** Whether GitHub accepted it. */
  ok: boolean;
  /** Failure detail, when it didn't. */
  error?: string;
}

/**
 * A terminal verdict reached *without* asking GitHub for anything.
 *
 * Kept apart from `attempts` because the two are different facts and conflating them
 * costs twice. Once in truth: every row in `attempts` is a request we made, so a decision
 * filed among them makes the engine report "this attempt was already re-run" about an
 * attempt it never re-ran. Once in arithmetic: the number of re-runs is then unreadable
 * from the record, which is the one question anyone asks of it.
 *
 * It is still persisted, because the point is not to re-derive the verdict — and for
 * `identical_failure` that would mean re-fetching every failed job's annotations on every
 * tick, forever.
 */
export interface RerunDecline {
  /** GitHub's `run_attempt` this verdict is about. */
  attempt: number;
  /** The policy's own reason, so the engine can report what it actually concluded. */
  reason: RerunSkipReason;
  fingerprint: string | null;
  at: number;
}

export interface RerunRecord {
  runId: number;
  /** Re-runs we asked GitHub for. `attempts.length` is the number of requests made. */
  attempts: RerunAttempt[];
  /** The latest "decided not to", when there is one. */
  declined?: RerunDecline;
  updatedAt: number;
}

const STORAGE_KEY = 'job-monitor.rerun';
/** GitHub refuses re-runs after 30 days, so older records can never matter. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Bound the record count so a busy repo can't grow this without limit. */
const MAX_RECORDS = 500;

type Stored = Record<string, RerunRecord>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Stored;
  } catch {
    return {};
  }
}

function writeAll(records: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* storage full/unavailable — the in-memory decision still holds this session */
  }
}

/** Drop expired records, and the oldest ones past the cap. */
function prune(records: Stored, now: number): Stored {
  const live = Object.values(records).filter(
    (r) => r && typeof r.updatedAt === 'number' && now - r.updatedAt <= TTL_MS,
  );
  live.sort((a, b) => b.updatedAt - a.updatedAt);
  const kept: Stored = {};
  for (const r of live.slice(0, MAX_RECORDS)) kept[String(r.runId)] = r;
  return kept;
}

/**
 * The exact text the identical-failure latch used to write into `attempts` before
 * declines were separated out. Frozen deliberately: a migration must match the literal
 * that was actually stored, not a label that may be reworded later.
 */
const LEGACY_DECLINE_ERROR = 'the failure repeated identically';

/**
 * Lift a legacy decline out of `attempts`.
 *
 * Records written before {@link RerunDecline} existed filed "gave up, identical failure"
 * as a failed *request*, which both overstates the re-run count and makes the engine
 * report the wrong reason for ever after. Migrating on read fixes existing installs
 * without anyone having to clear their storage.
 */
function migrateLegacyDecline(record: RerunRecord): RerunRecord {
  if (record.declined) return record;
  const legacy = record.attempts.find((a) => a.ok === false && a.error === LEGACY_DECLINE_ERROR);
  if (!legacy) return record;
  return {
    ...record,
    attempts: record.attempts.filter((a) => a !== legacy),
    declined: {
      attempt: legacy.attempt,
      reason: 'identical_failure',
      fingerprint: legacy.fingerprint,
      at: legacy.at,
    },
  };
}

/** Every remembered run, as a map for cheap lookup by run id. */
export function loadRerunRecords(now: number = Date.now()): Map<number, RerunRecord> {
  const pruned = prune(readAll(), now);
  const map = new Map<number, RerunRecord>();
  for (const r of Object.values(pruned)) {
    map.set(
      r.runId,
      migrateLegacyDecline({
        runId: r.runId,
        attempts: Array.isArray(r.attempts) ? r.attempts : [],
        declined: r.declined,
        updatedAt: r.updatedAt,
      }),
    );
  }
  return map;
}

/** How many re-runs we have actually asked GitHub for, across every attempt. */
export function rerunRequestCount(record: RerunRecord | undefined): number {
  return record?.attempts.length ?? 0;
}

/**
 * Remember an attempt. Re-recording the same `attempt` overwrites it, so a
 * retried rate-limit failure doesn't accumulate duplicates.
 */
export function recordRerun(
  runId: number,
  attempt: RerunAttempt,
  now: number = Date.now(),
): void {
  const records = prune(readAll(), now);
  const key = String(runId);
  const existing = records[key];
  const attempts = (existing?.attempts ?? []).filter((a) => a.attempt !== attempt.attempt);
  attempts.push(attempt);
  attempts.sort((a, b) => a.attempt - b.attempt);
  records[key] = { runId, attempts, declined: existing?.declined, updatedAt: now };
  writeAll(records);
}

/**
 * Remember a verdict reached without asking GitHub anything, so the engine neither
 * re-derives it nor pays for the annotations behind it on every tick.
 *
 * One per run rather than a list: the only question ever asked of it is "did we already
 * settle *this* attempt", and a newer verdict always supersedes an older one.
 */
export function recordDecline(
  runId: number,
  decline: RerunDecline,
  now: number = Date.now(),
): void {
  const records = prune(readAll(), now);
  const key = String(runId);
  const existing = records[key];
  records[key] = {
    runId,
    attempts: existing?.attempts ?? [],
    declined: decline,
    updatedAt: now,
  };
  writeAll(records);
}

/** Forget everything (used by tests and when a repo/token changes identity). */
export function clearRerunRecords(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

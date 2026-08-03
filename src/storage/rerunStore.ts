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

export interface RerunRecord {
  runId: number;
  attempts: RerunAttempt[];
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

/** Every remembered run, as a map for cheap lookup by run id. */
export function loadRerunRecords(now: number = Date.now()): Map<number, RerunRecord> {
  const pruned = prune(readAll(), now);
  const map = new Map<number, RerunRecord>();
  for (const r of Object.values(pruned)) {
    map.set(r.runId, {
      runId: r.runId,
      attempts: Array.isArray(r.attempts) ? r.attempts : [],
      updatedAt: r.updatedAt,
    });
  }
  return map;
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
  records[key] = { runId, attempts, updatedAt: now };
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

/**
 * Week-long caches for the Failures tab.
 *
 * Everything cached here describes work that has already **finished**, and a
 * finished job's annotations, logs and job list are immutable — GitHub will keep
 * answering with the same bytes. So the only reason the tab refetched them on every
 * visit was that it forgot between mounts.
 *
 * Cache keys are attempt-unique rather than run-unique, which is what makes a week
 * safe: re-running failed jobs mints **new check-run and job ids**, so a re-run
 * cannot be served a previous attempt's data — it simply misses.
 */

import type { Annotation, Job } from '../api/types';
import { createTtlCache } from './localTtlCache';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The parts of a FailureDetail worth remembering (loading/error state isn't). */
export interface CachedFailureDetail {
  annotations: Annotation[] | null;
  failedStep: string | null;
  workflowFile: string | null;
  runNumber: number | null;
  runAttempt: number | null;
  logTail: string[] | null;
}

/**
 * Keyed by `FailedJobRef.key`. Log tails dominate the size (up to 500 lines), hence
 * the tighter entry count and the byte ceiling.
 */
export const failureDetailCache = createTtlCache<CachedFailureDetail>({
  storageKey: 'job-monitor.failureDetails',
  ttlMs: WEEK_MS,
  maxEntries: 80,
  maxBytes: 400_000,
});

/** Keyed by `${runId}:${run_attempt}` — see the note on attempt-uniqueness above. */
export const flowRunJobsCache = createTtlCache<Job[]>({
  storageKey: 'job-monitor.flowRunJobs',
  ttlMs: WEEK_MS,
  maxEntries: 60,
  maxBytes: 300_000,
});

export function flowRunJobsKey(runId: number, runAttempt: number): string {
  return `${runId}:${runAttempt}`;
}

/** A stored Claude analysis. */
export interface CachedAnalysis {
  problem: string;
  solution: string;
  /**
   * What it did to get there — the tool calls, in order.
   *
   * Stored with the conclusion because it is how you judge the conclusion: an answer
   * backed by "downloaded the artifacts, read the TRX report" earns more trust than the
   * same words with nothing behind them. Dropping it on reload left a week-old verdict
   * with its evidence trail missing. Optional, so entries written before this still load.
   */
  activity?: string[];
  /**
   * Which log it read, and whether that log was truncated — the other half of judging the
   * answer. Reading the whole run via `gh` and reading a tail the app already had bound
   * the conclusion differently, so a restored analysis should say which it was rather than
   * going quiet about it.
   */
  logSource?: 'gh' | 'app' | 'none';
  logTruncated?: boolean;
  /**
   * The narration — what it said it was doing as it went, in prose. Stored with the trail
   * because the two panes answer different questions (`activity` is the argv, this is the
   * reasoning) and a restored analysis with only the verdict left both unanswerable.
   */
  narration?: string;
  /**
   * A whole-document answer — the rewritten log, or the blame report. Present instead of
   * `problem`/`solution` for the tasks that return prose with its own structure rather
   * than a verdict in two parts.
   */
  document?: string;
  /** The old name for {@link document}. Read only, so week-old entries still load. */
  rewrittenLog?: string;
  /**
   * Why an unfinished run stopped, and the CLI session to continue it from.
   *
   * Stored so a run that ran out of time is still resumable after a restart — the
   * conversation itself lives in the CLI's own state, and this is the handle to it.
   */
  incompleteReason?: string;
  sessionId?: string;
  /**
   * Whether the reader chose to carry this result into the bug report.
   *
   * Stored with the result rather than in component state so the choice survives closing
   * the dialog, switching rows and restarting the app — it expires with the analysis it
   * belongs to, on the same week-long TTL, because a verdict about an attempt is
   * meaningless once that attempt has aged out.
   */
  inReport?: boolean;
}

/**
 * Analyses, keyed by `${failureKey}|${depth}` so the quick and deep reads of the same
 * failure coexist.
 *
 * Persisted for the same reason and on the same terms as the rest: the analysis
 * describes one *attempt* of one job, and the failure key changes when a re-run mints
 * new job ids — so a cached read can never be served against a different attempt.
 * Worth keeping because these calls are slow and billable, and re-opening a failure you
 * looked at yesterday shouldn't spend another one.
 */
export const claudeAnalysisCache = createTtlCache<CachedAnalysis>({
  storageKey: 'job-monitor.claudeAnalyses',
  ttlMs: WEEK_MS,
  maxEntries: 60,
  // Roomier than the 200KB it needed for prose alone: the activity trail is worth
  // keeping, and evicting analyses to make room for it would be the wrong trade.
  maxBytes: 400_000,
});

export function analysisKey(failureKey: string, depth: string): string {
  return `${failureKey}|${depth}`;
}

/**
 * Whole-run failed-step logs fetched with `gh`, keyed `${runId}:${runAttempt}`.
 *
 * Worth a week for the same reason as everything else here: a finished run's log is
 * immutable, and a re-run is a new attempt with a new key. Worth caching at all because
 * this is the slow fetch — `gh` downloads it from blob storage, which is where the stall
 * that used to hang the app came from. Few entries and a hard byte ceiling: these are the
 * largest things the app stores, and one big log must not evict everything else.
 */
export const runLogCache = createTtlCache<{ text: string; truncated: boolean }>({
  storageKey: 'job-monitor.runLogs',
  ttlMs: WEEK_MS,
  maxEntries: 8,
  maxBytes: 600_000,
});

export function runLogKey(runId: number, runAttempt: number | null): string {
  return `${runId}:${runAttempt ?? 1}`;
}

/**
 * Origin prefixes (`pr:37977`, `flow:abc`) that have at least one stored Claude result.
 *
 * Lets the pull-request and flow lists show that an analysis exists without holding any
 * per-failure state: the cache keys already encode the origin, so a scan over at most a
 * few dozen entries answers it.
 */
/**
 * Which results exist per failure, as `failureKey -> {'quick','deep','log'}`.
 *
 * Built in one pass so a list of rows costs a single scan rather than a lookup each. Lets
 * the failure list show at a glance what has already been produced for a row — which of
 * the three was run, and therefore what is worth spending a call on next.
 */
export function analysedFailures(): Map<string, Set<string>> {
  const byFailure = new Map<string, Set<string>>();
  for (const [key] of claudeAnalysisCache.entries()) {
    const at = key.lastIndexOf('|');
    if (at === -1) continue;
    const failureKey = key.slice(0, at);
    const depth = key.slice(at + 1);
    const set = byFailure.get(failureKey);
    if (set) set.add(depth);
    else byFailure.set(failureKey, new Set([depth]));
  }
  return byFailure;
}

export function analysedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const [key] of claudeAnalysisCache.entries()) {
    // `pr:37977:91164948690|deep` → `pr:37977`
    const parts = key.split(':');
    if (parts.length >= 2) origins.add(`${parts[0]}:${parts[1]}`);
  }
  return origins;
}

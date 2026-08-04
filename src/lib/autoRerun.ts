/**
 * Should this failed workflow run have its failed jobs re-run automatically?
 *
 * Pure and side-effect free, so the whole policy can be unit-tested without a
 * network or a clock. The engine in usePrAutoRerun.ts does the I/O; this file owns
 * the decision — including the two brakes that stop a genuinely broken PR from
 * burning CI forever (`maxAttempts` and the identical-failure check).
 *
 * The checks are ordered cheapest-first so the common case (a PR with no
 * auto-merge, or a run of an unwatched workflow) is rejected before the engine
 * spends any request on jobs or annotations.
 */

import type { PullRequest, RunConclusion, WorkflowRun } from '../api/types';
import type { PrAutoRerunConfig } from '../storage/configStore';
import { workflowBasename } from './workflow';
import type { RerunRecord } from '../storage/rerunStore';

/**
 * Conclusions worth retrying.
 *
 * Deliberately narrow, because `statusToOverall` in lib/status.ts buckets several
 * conclusions in ways that are wrong for this decision:
 *  - `action_required` maps to "failure" there, but it means a human must approve
 *    something — re-running it just re-queues the same wait.
 *  - `cancelled` and `stale` map to "neutral"; a cancel is normally deliberate, so
 *    undoing it behind the user's back would be rude.
 * That leaves the two conclusions that actually mean "the work ran and broke".
 */
export const RETRYABLE_CONCLUSIONS: ReadonlySet<RunConclusion> = new Set<RunConclusion>([
  'failure',
  'timed_out',
]);

/**
 * Conclusions a *person* may re-run on request — deliberately wider than
 * {@link RETRYABLE_CONCLUSIONS}. Someone may well want to re-run a run they
 * cancelled, or one that never got started; what would be wrong is doing either
 * unattended. Kept beside the automatic set so the "wider than" relationship is
 * visible and testable rather than asserted in a comment somewhere else.
 */
export const MANUALLY_RERUNNABLE_CONCLUSIONS: ReadonlySet<RunConclusion> =
  new Set<RunConclusion>(['failure', 'timed_out', 'cancelled', 'startup_failure']);

export type RerunSkipReason =
  | 'disabled'
  | 'no_workflows'
  | 'not_matched'
  | 'no_auto_merge'
  | 'not_final'
  | 'not_failed'
  | 'too_old'
  | 'rerun_window_closed'
  | 'already_requested'
  | 'attempts_exhausted'
  | 'identical_failure'
  | 'fingerprint_unavailable';

/**
 * GitHub refuses to re-run a workflow more than 30 days after its *first* run,
 * whatever has happened since. Our own `maxRunAgeHours` is a separate, usually much
 * tighter judgement about staleness; this is the wall behind it.
 */
export const GITHUB_RERUN_LIMIT_HOURS = 30 * 24;

/**
 * When the work now being judged actually ran.
 *
 * `created_at` is when the run was *first* created and GitHub never moves it, so a run
 * that has been re-run for three days still reports itself as three days old. What is
 * being considered for a retry is the latest attempt, and `run_started_at` is the field
 * that resets with each one — measuring staleness against anything else means a PR that
 * is actively being retried silently ages out of the window while its last attempt was
 * minutes ago.
 *
 * Falls back to `created_at`, which is all there is for a first attempt (and all the API
 * returns on some older payloads).
 */
export function runAgeBasis(run: WorkflowRun): string {
  return run.run_started_at ?? run.created_at;
}

export type RerunDecision =
  | { rerun: true }
  | { rerun: false; reason: RerunSkipReason };

/** Human-readable explanation, for the activity log and tooltips. */
export const SKIP_REASON_LABEL: Record<RerunSkipReason, string> = {
  disabled: 'auto-rerun is off',
  no_workflows: 'no workflows configured',
  not_matched: 'workflow not in the configured list',
  no_auto_merge: 'auto-merge is not enabled on the PR',
  not_final: 'the run has not finished',
  not_failed: 'the run did not fail',
  too_old: 'the last attempt is older than the configured window',
  rerun_window_closed: 'GitHub no longer allows this run to be re-run (30 days)',
  already_requested: 'this attempt was already re-run',
  attempts_exhausted: 'attempt limit reached',
  identical_failure: 'the failure repeated identically',
  fingerprint_unavailable: 'the failure could not be checked against the previous one',
};

/**
 * Exact match of a run's workflow file name against the configured allow-list.
 * `run.path` is a repo-relative path (".github/workflows/ci.yml"), so it is
 * reduced to its basename first. Comparison is case-insensitive because GitHub
 * paths are, in practice, typed by hand into settings.
 */
export function matchesWorkflowFile(
  run: WorkflowRun,
  files: readonly string[],
): boolean {
  if (!run.path) return false;
  const base = workflowBasename(run.path).toLowerCase();
  return files.some((f) => f.trim().toLowerCase() === base);
}

/** How many attempts of this run we have already asked GitHub to re-run. */
function requestedAttempts(record: RerunRecord | undefined): Set<number> {
  return new Set((record?.attempts ?? []).map((a) => a.attempt));
}

/**
 * Is the identical-failure brake in use at all? `0` means "never stop for this".
 *
 * Exported because the engine uses it to decide whether a fingerprint is worth computing:
 * with the brake off, the annotation fetches behind one buy nothing.
 */
export function identicalFailuresLimited(settings: PrAutoRerunConfig): boolean {
  return settings.maxIdenticalFailures > 0;
}

/**
 * Every fingerprint we know for this run, by attempt number.
 *
 * Both sources matter. `attempts` covers the failures we re-ran; `declined` covers the one
 * we stopped on — and leaving that out would restart the streak from zero the moment
 * someone re-ran the run by hand, which is precisely when the count should keep climbing.
 */
function fingerprintsByAttempt(record: RerunRecord | undefined): Map<number, string> {
  const byAttempt = new Map<number, string>();
  for (const a of record?.attempts ?? []) {
    if (a.fingerprint) byAttempt.set(a.attempt, a.fingerprint);
  }
  const declined = record?.declined;
  if (declined?.fingerprint) byAttempt.set(declined.attempt, declined.fingerprint);
  return byAttempt;
}

/**
 * How many times in a row this exact failure has now been seen, counting this attempt.
 *
 * Consecutive rather than total: a different failure in between means something changed,
 * and the streak that matters is the one that has not budged. So F,G,F,F reads as two —
 * the earlier F is not part of the current run of them.
 *
 * A missing fingerprint (one that couldn't be computed) breaks the chain rather than
 * being assumed to match, for the same reason `decideRerun` treats null as "unknown": it
 * must never manufacture a reason to stop.
 */
export function identicalStreak(
  record: RerunRecord | undefined,
  attempt: number,
  fingerprint: string,
): number {
  const byAttempt = fingerprintsByAttempt(record);
  let streak = 1; // this attempt
  for (let prev = attempt - 1; prev >= 1; prev -= 1) {
    if (byAttempt.get(prev) !== fingerprint) break;
    streak += 1;
  }
  return streak;
}

/**
 * Does a stored verdict still hold under the settings in force now?
 *
 * A decline is a cache of a decision, so raising `maxIdenticalFailures` has to invalidate
 * it. Without this, a run refused under a tighter limit stays refused forever: its attempt
 * number never changes again, so nothing would ever reconsider it, and the new setting
 * would appear to do nothing at all.
 *
 * Re-checking is free, which is what makes this safe to do on every tick: the streak comes
 * from fingerprints already in the record, with nothing to fetch. Falling through to the
 * full decision is also safe — the engine computes this attempt's fingerprint before the
 * decision that can act on it.
 */
function declineStillHolds(
  record: RerunRecord,
  run: WorkflowRun,
  settings: PrAutoRerunConfig,
): boolean {
  const declined = record.declined;
  if (!declined) return false;
  // Only the identical-failure verdict is settings-dependent; any other stands as filed.
  if (declined.reason !== 'identical_failure') return true;
  if (!identicalFailuresLimited(settings)) return false;
  if (!declined.fingerprint) return false;
  return (
    identicalStreak(record, run.run_attempt, declined.fingerprint) >= settings.maxIdenticalFailures
  );
}

export function decideRerun(args: {
  run: WorkflowRun;
  pr: PullRequest;
  settings: PrAutoRerunConfig;
  record: RerunRecord | undefined;
  /** Failure fingerprint of this attempt; null when it isn't known. */
  fingerprint: string | null;
  /**
   * Why the fingerprint is missing, when it is missing because *computing* it failed.
   *
   * This is what separates "not worked out yet" from "cannot be worked out". The engine's
   * cheap pre-pass deliberately passes no fingerprint, and that must not be mistaken for a
   * failure to obtain one — otherwise the pre-pass would refuse every run before anything
   * ever tried.
   */
  fingerprintProblem?: string | null;
  now: number;
}): RerunDecision {
  const { run, pr, settings, record, fingerprint, fingerprintProblem, now } = args;

  if (!settings.enabled) return { rerun: false, reason: 'disabled' };
  if (settings.workflowFiles.length === 0) return { rerun: false, reason: 'no_workflows' };
  if (!matchesWorkflowFile(run, settings.workflowFiles)) {
    return { rerun: false, reason: 'not_matched' };
  }
  // Auto-merge is a deliberate human act on GitHub, and it is what makes an
  // unattended re-run appropriate: someone has already said "land this when green".
  if (!pr.auto_merge) return { rerun: false, reason: 'no_auto_merge' };
  if (run.status !== 'completed') return { rerun: false, reason: 'not_final' };
  if (!RETRYABLE_CONCLUSIONS.has(run.conclusion)) return { rerun: false, reason: 'not_failed' };

  // Staleness of the attempt that failed, not of the run's first ever attempt — see
  // runAgeBasis. An unparseable date reads as "unknown", which must not block a retry.
  const ageMs = now - Date.parse(runAgeBasis(run));
  if (Number.isFinite(ageMs) && ageMs > settings.maxRunAgeHours * 3600_000) {
    return { rerun: false, reason: 'too_old' };
  }

  // The hard wall, which is measured from the original creation because that is what
  // GitHub measures. Without it a long-lived run kept alive by re-runs would eventually
  // be asked to do something GitHub answers with a 403 on every tick.
  const sinceCreated = now - Date.parse(run.created_at);
  if (Number.isFinite(sinceCreated) && sinceCreated > GITHUB_RERUN_LIMIT_HOURS * 3600_000) {
    return { rerun: false, reason: 'rerun_window_closed' };
  }

  // GitHub bumps run_attempt on a successful re-run, so the attempt number is a
  // natural idempotency key: having recorded this one means the request is already
  // in flight or done.
  if (requestedAttempts(record).has(run.run_attempt)) {
    return { rerun: false, reason: 'already_requested' };
  }

  // A verdict already reached for this exact attempt, replayed rather than re-derived.
  // Reporting the stored reason and not a generic "already handled" is the whole point:
  // the reason is what someone reading the log is trying to find out.
  if (record?.declined?.attempt === run.run_attempt && declineStillHolds(record, run, settings)) {
    return { rerun: false, reason: record.declined.reason };
  }

  // run_attempt is 1-based, so `>= maxAttempts` means this is the last permitted
  // attempt and re-running would exceed the ceiling.
  if (run.run_attempt >= settings.maxAttempts) {
    return { rerun: false, reason: 'attempts_exhausted' };
  }

  // Can't check, don't retry. A fingerprint that failed to compute leaves the brake with
  // nothing to compare, and treating that as "go ahead" turns an intermittent lookup
  // failure into an unbounded licence to re-run — the limit stops applying precisely when
  // something is already wrong. Not latched: the next tick may well manage it.
  if (identicalFailuresLimited(settings) && !fingerprint && fingerprintProblem) {
    return { rerun: false, reason: 'fingerprint_unavailable' };
  }

  // Retrying the same failure has some value — a flaky test can fail identically twice
  // and pass on the third go — but it runs out. `maxIdenticalFailures` is where.
  if (identicalFailuresLimited(settings) && fingerprint) {
    if (identicalStreak(record, run.run_attempt, fingerprint) >= settings.maxIdenticalFailures) {
      return { rerun: false, reason: 'identical_failure' };
    }
  }

  return { rerun: true };
}

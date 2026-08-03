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
  | 'already_requested'
  | 'attempts_exhausted'
  | 'identical_failure';

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
  too_old: 'the run is older than the configured window',
  already_requested: 'this attempt was already re-run',
  attempts_exhausted: 'attempt limit reached',
  identical_failure: 'the failure repeated identically',
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

/** The fingerprint recorded for the most recent *earlier* attempt, if any. */
function previousFingerprint(
  record: RerunRecord | undefined,
  attempt: number,
): string | null {
  const earlier = (record?.attempts ?? [])
    .filter((a) => a.attempt < attempt && a.fingerprint)
    .sort((a, b) => b.attempt - a.attempt);
  return earlier[0]?.fingerprint ?? null;
}

export function decideRerun(args: {
  run: WorkflowRun;
  pr: PullRequest;
  settings: PrAutoRerunConfig;
  record: RerunRecord | undefined;
  /** Failure fingerprint of this attempt; null when it couldn't be computed. */
  fingerprint: string | null;
  now: number;
}): RerunDecision {
  const { run, pr, settings, record, fingerprint, now } = args;

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

  const ageMs = now - Date.parse(run.created_at);
  if (Number.isFinite(ageMs) && ageMs > settings.maxRunAgeHours * 3600_000) {
    return { rerun: false, reason: 'too_old' };
  }

  // GitHub bumps run_attempt on a successful re-run, so the attempt number is a
  // natural idempotency key: having recorded this one means the request is already
  // in flight or done.
  if (requestedAttempts(record).has(run.run_attempt)) {
    return { rerun: false, reason: 'already_requested' };
  }

  // run_attempt is 1-based, so `>= maxAttempts` means this is the last permitted
  // attempt and re-running would exceed the ceiling.
  if (run.run_attempt >= settings.maxAttempts) {
    return { rerun: false, reason: 'attempts_exhausted' };
  }

  if (settings.stopOnIdenticalFailure && fingerprint) {
    if (previousFingerprint(record, run.run_attempt) === fingerprint) {
      return { rerun: false, reason: 'identical_failure' };
    }
  }

  return { rerun: true };
}

/**
 * Normalization + aggregation of GitHub run states into the dashboard's
 * OverallStatus, plus the rule for which states are still "active" (worth polling).
 */

import type {
  CheckRun,
  CombinedStatus,
  OverallStatus,
  RunConclusion,
  RunStatus,
} from '../api/types';

/** A run is active (and should keep being polled) until it is completed. */
export function isActiveStatus(status: RunStatus): boolean {
  return status !== 'completed';
}

/** Map a single run's (status, conclusion) to an OverallStatus. */
export function statusToOverall(status: RunStatus, conclusion: RunConclusion): OverallStatus {
  if (status !== 'completed') {
    return status === 'in_progress' ? 'in_progress' : 'pending';
  }
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
    case 'action_required':
      return 'failure';
    case 'cancelled':
    case 'neutral':
    case 'skipped':
    case 'stale':
      return 'neutral';
    default:
      return 'neutral';
  }
}

// Lower number = higher precedence when aggregating.
const PRECEDENCE: Record<OverallStatus, number> = {
  failure: 0,
  in_progress: 1,
  pending: 2,
  success: 3,
  neutral: 4,
  unknown: 5,
};

/**
 * How a flow last *finished*: the status of its most recent completed run.
 *
 * Deliberately not the newest run, and deliberately not {@link aggregateStatuses} over the runs a
 * flow holds.
 *
 * The newest run answers "what is happening now", which is `in_progress` or `pending` for as long as
 * it takes — so a badge built on it stops reporting a result while anything is building, and a group
 * tally built on it omitted any flow that happened to be mid-build: a group of three showed two
 * verdicts and the third read as missing rather than as its last result.
 *
 * Aggregating is worse again: it ranks failure first and unfinished ahead of finished, so a flow read
 * as red long after going green, and one stale queued run dragged a whole group to *pending*. Runs
 * are independent attempts, not parts of one thing. (Aggregation stays right where the parts really
 * are parts of one whole — the check-runs of a commit.)
 *
 * This skips unfinished runs and reports the last verdict there was. A cancelled or skipped run
 * counts: it is finished, and `neutral` is a final state.
 *
 * It is not the same as "ignore failures until something passes" — only *unfinished* runs are
 * skipped, so a flow that failed and is now rebuilding still reads as failed until the rebuild
 * finishes and says otherwise.
 */
export function latestFinalStatus(
  runs: readonly { status: RunStatus; conclusion: RunConclusion }[],
): OverallStatus {
  const finished = runs.find((r) => r.status === 'completed');
  return finished ? statusToOverall(finished.status, finished.conclusion) : 'unknown';
}

export function aggregateStatuses(statuses: OverallStatus[]): OverallStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce((acc, s) => (PRECEDENCE[s] < PRECEDENCE[acc] ? s : acc), 'unknown');
}

function combinedStatusToOverall(state: CombinedStatus['state']): OverallStatus {
  if (state === 'success') return 'success';
  if (state === 'failure') return 'failure';
  return 'pending';
}

/** Overall status for a PR head: aggregate of all check-runs + the combined commit status. */
export function combineChecksAndStatus(
  checkRuns: CheckRun[],
  combined: CombinedStatus | null,
): OverallStatus {
  const parts: OverallStatus[] = checkRuns.map((c) => statusToOverall(c.status, c.conclusion));
  if (combined && combined.total_count > 0) {
    parts.push(combinedStatusToOverall(combined.state));
  }
  return aggregateStatuses(parts);
}

export const STATUS_LABEL: Record<OverallStatus, string> = {
  success: 'Success',
  failure: 'Failure',
  pending: 'Pending',
  in_progress: 'In progress',
  neutral: 'Neutral',
  unknown: 'No checks',
};

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

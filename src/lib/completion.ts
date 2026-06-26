/**
 * Pure detection of items that have just *finished* between two polls, used to
 * drive completion notifications for PRs and flow runs.
 *
 * Rule: fire only on an observed `active -> completed` transition. An item must
 * have been seen in a non-terminal ("active") phase first, then completed.
 *  - Items already complete the first time we see them (page load, or a run that
 *    finished before we ever polled it) never fire — no startup flood, no false
 *    positives.
 *  - "unknown" phase (e.g. a PR whose checks haven't been fetched yet) is not
 *    recorded as active, so the first real status isn't mistaken for a finish.
 */

import type { OverallStatus, RunConclusion, RunStatus } from '../api/types';

export type Phase = 'unknown' | 'active' | 'completed';

export function detectNewlyCompleted<T, Id>(
  prev: ReadonlyMap<Id, boolean>,
  items: readonly T[],
  getId: (item: T) => Id,
  getPhase: (item: T) => Phase,
): { completed: T[]; next: Map<Id, boolean> } {
  const completed: T[] = [];
  const next = new Map<Id, boolean>();
  for (const item of items) {
    const id = getId(item);
    const phase = getPhase(item);
    if (phase === 'unknown') {
      // Preserve any previously-known state; "not yet known" is not "active".
      if (prev.has(id)) next.set(id, prev.get(id)!);
      continue;
    }
    const done = phase === 'completed';
    if (done && prev.get(id) === false) completed.push(item);
    next.set(id, done);
  }
  return { completed, next };
}

/** Phase of a PR's aggregate checks. `checksFetched` guards the "unknown" window. */
export function prPhase(overall: OverallStatus, checksFetched: boolean): Phase {
  if (!checksFetched) return 'unknown';
  if (overall === 'success' || overall === 'failure') return 'completed';
  if (overall === 'pending' || overall === 'in_progress') return 'active';
  // neutral / unknown: no meaningful finish to announce.
  return 'unknown';
}

/** Phase of a workflow run: `completed` is the unambiguous finish signal. */
export function runPhase(status: RunStatus): Phase {
  return status === 'completed' ? 'completed' : 'active';
}

/** Human-friendly outcome word for a finished run's conclusion. */
export function runConclusionLabel(conclusion: RunConclusion): string {
  switch (conclusion) {
    case 'success':
      return 'succeeded';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
    case 'action_required':
      return 'failed';
    case 'cancelled':
      return 'was cancelled';
    case 'skipped':
      return 'was skipped';
    default:
      return 'completed';
  }
}

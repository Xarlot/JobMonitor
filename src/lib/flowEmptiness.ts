/**
 * Decides whether the Flows view and Overview should hide a flow, per its
 * per-flow visibility filter. The filter tests an "empty" condition and its
 * `mode` picks the direction:
 *  - hide: hide the flow when it matches the condition.
 *  - show: show the flow only when it matches (hide the non-empty ones).
 *
 * Emptiness signals:
 *  - no_runs:      the flow produced no runs for its branches/events.
 *  - only_skipped: it has runs, but every one is skipped/neutral (nothing ran).
 *  - no_artifacts: the latest completed run uploaded no artifacts, or a total
 *                  size at/below the configured KB threshold.
 *  - job:          the latest run has a job whose name contains `jobName` and that
 *                  is in `jobState` (e.g. a "test" job that was skipped).
 */

import type { Job, WorkflowRun } from '../api/types';
import type { EmptyFlowFilter } from '../storage/configStore';
import { statusToOverall } from './status';

const FAILURE_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure', 'action_required'];

export interface FlowEmptinessInput {
  runs: WorkflowRun[];
  /** Total non-expired artifact bytes of the latest run, or null if unknown/not loaded. */
  latestArtifactBytes: number | null;
  /** Jobs of the latest run, or null if unknown/not loaded. */
  latestJobs: Job[] | null;
}

function jobInState(job: Job, state: EmptyFlowFilter['jobState']): boolean {
  switch (state) {
    case 'skipped':
      return job.conclusion === 'skipped';
    case 'failure':
      return FAILURE_CONCLUSIONS.includes(job.conclusion ?? '');
    case 'success':
      return job.conclusion === 'success';
    case 'in_progress':
      return job.status !== 'completed';
  }
}

/**
 * Whether the flow matches the "empty" condition.
 * Returns `null` when the answer isn't known yet (data still loading, or the
 * condition isn't configured) so callers can keep the flow visible meanwhile.
 */
function emptinessSignal(input: FlowEmptinessInput, filter: EmptyFlowFilter): boolean | null {
  switch (filter.by) {
    case 'no_runs':
      return input.runs.length === 0;
    case 'only_skipped':
      return (
        input.runs.length > 0 &&
        input.runs.every((r) => statusToOverall(r.status, r.conclusion) === 'neutral')
      );
    case 'no_artifacts':
      if (input.latestArtifactBytes === null) return null; // unknown -> keep visible
      return input.latestArtifactBytes <= filter.minArtifactKB * 1024;
    case 'job': {
      const name = filter.jobName.trim().toLowerCase();
      if (!name) return null; // no job specified -> not configured yet
      if (input.latestJobs === null) return null; // unknown -> keep visible while loading
      const matching = input.latestJobs.filter((j) => j.name.toLowerCase().includes(name));
      if (matching.length === 0) return false;
      return matching.some((j) => jobInState(j, filter.jobState));
    }
  }
}

/** True when the flow matches its "empty" condition (unknown counts as not empty). */
export function isFlowEmpty(input: FlowEmptinessInput, filter: EmptyFlowFilter): boolean {
  if (!filter.enabled) return false;
  return emptinessSignal(input, filter) === true;
}

/**
 * Whether the Flows view / Overview should hide the flow, honoring the filter's
 * `mode`. A flow whose emptiness is still unknown is kept visible in both modes.
 */
export function isFlowHidden(input: FlowEmptinessInput, filter: EmptyFlowFilter): boolean {
  if (!filter.enabled) return false;
  const empty = emptinessSignal(input, filter);
  if (empty === null) return false; // loading / not configured -> keep visible
  return filter.mode === 'hide' ? empty : !empty;
}

/** The filter needs the latest run's artifact size fetched. */
export function emptyFilterNeedsArtifacts(filter: EmptyFlowFilter): boolean {
  return filter.enabled && filter.by === 'no_artifacts';
}

/** The filter needs the latest run's jobs fetched. */
export function emptyFilterNeedsLatestJobs(filter: EmptyFlowFilter): boolean {
  return filter.enabled && filter.by === 'job';
}

/** Latest run's jobs from a jobs-by-run cache, or null if not loaded yet. */
export function latestRunJobs(
  runs: WorkflowRun[],
  jobsByRun: Record<number, { jobs: Job[]; loading: boolean }>,
): Job[] | null {
  const latest = runs[0];
  if (!latest) return null;
  const cache = jobsByRun[latest.id];
  return cache && !cache.loading ? cache.jobs : null;
}

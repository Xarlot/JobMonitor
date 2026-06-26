/**
 * Decides whether a flow is "empty" per its per-flow empty filter, so the Flows
 * view and Overview can hide no-op / misconfigured flows.
 *
 * Signals:
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

export function isFlowEmpty(input: FlowEmptinessInput, filter: EmptyFlowFilter): boolean {
  if (!filter.enabled) return false;
  switch (filter.by) {
    case 'no_runs':
      return input.runs.length === 0;
    case 'only_skipped':
      return (
        input.runs.length > 0 &&
        input.runs.every((r) => statusToOverall(r.status, r.conclusion) === 'neutral')
      );
    case 'no_artifacts':
      if (input.latestArtifactBytes === null) return false; // unknown -> keep visible
      return input.latestArtifactBytes <= filter.minArtifactKB * 1024;
    case 'job': {
      const name = filter.jobName.trim().toLowerCase();
      if (!name) return false; // no job specified -> nothing to match
      if (input.latestJobs === null) return false; // unknown -> keep visible while loading
      const matching = input.latestJobs.filter((j) => j.name.toLowerCase().includes(name));
      if (matching.length === 0) return false;
      return matching.some((j) => jobInState(j, filter.jobState));
    }
  }
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

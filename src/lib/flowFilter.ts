/**
 * Pure predicates for the Flows view filters: run-level status and an optional
 * job-level condition (e.g. "a job named X that did not skip").
 */

import type { Job, OverallStatus, WorkflowRun } from '../api/types';
import type { FlowsFilter, RunStatusFilter } from '../context/FlowsFilterContext';
import { statusToOverall } from './status';

const FAILURE_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure', 'action_required'];

export function matchesRunStatus(status: OverallStatus, filter: RunStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return status === 'in_progress' || status === 'pending' || status === 'unknown';
    case 'failed':
      return status === 'failure';
    case 'success':
      return status === 'success' || status === 'neutral';
  }
}

/** Does any job matching the filter's name satisfy the chosen job state? */
export function jobConditionMatches(jobs: Job[], filter: FlowsFilter): boolean {
  const name = filter.jobName.trim().toLowerCase();
  if (!name) return true;
  const matching = jobs.filter((j) => j.name.toLowerCase().includes(name));
  if (matching.length === 0) return false;
  switch (filter.jobState) {
    case 'any':
      return true;
    case 'success':
      return matching.some((j) => j.conclusion === 'success');
    case 'failure':
      return matching.some((j) => FAILURE_CONCLUSIONS.includes(j.conclusion ?? ''));
    case 'in_progress':
      return matching.some((j) => j.status !== 'completed');
    case 'not_skipped':
      return matching.some((j) => j.conclusion !== 'skipped');
  }
}

/**
 * Filter runs. When a job filter is active but a run's jobs aren't loaded yet
 * (`jobsLoaded` false), the run is kept visible to avoid flicker while loading.
 */
export function filterRuns(
  runs: WorkflowRun[],
  filter: FlowsFilter,
  jobsFor: (runId: number) => { jobs: Job[]; loaded: boolean },
): WorkflowRun[] {
  const jobFilterActive = filter.jobName.trim().length > 0;
  return runs.filter((run) => {
    if (!matchesRunStatus(statusToOverall(run.status, run.conclusion), filter.runStatus)) {
      return false;
    }
    if (jobFilterActive) {
      const { jobs, loaded } = jobsFor(run.id);
      if (!loaded) return true;
      return jobConditionMatches(jobs, filter);
    }
    return true;
  });
}

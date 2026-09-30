/**
 * Pure predicates for the Flows view filters: a status condition and an optional
 * job-level condition (e.g. "a job named X that did not skip").
 *
 * The filter decides whether a whole flow is shown, not which of its runs are: it looks at the
 * flow's latest *finished* run only — success, failure, cancelled and the like. A run still queued or
 * building has no verdict yet, so it is passed over and the run before it answers, the same rule as
 * {@link latestFinalStatus}. A flow that has never finished a run matches nothing but "All".
 */

import type { Job, WorkflowRun } from '../api/types';
import type { FlowsFilter, RunStatusFilter } from '../context/FlowsFilterContext';
import { isJobFilterActive } from '../context/FlowsFilterContext';
import { statusToOverall } from './status';

const FAILURE_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure', 'action_required'];

/**
 * Does a finished run satisfy the status filter?
 *
 * *Failed* and *Success* go by {@link statusToOverall}, so they read a run the way the rest of the
 * app does — a cancel is a failure, a skip a pass, as GitHub has it. *Cancelled* picks out the
 * cancels on their own, a subset of *Failed*.
 */
export function matchesRunStatus(run: WorkflowRun, filter: RunStatusFilter): boolean {
  const overall = statusToOverall(run.status, run.conclusion);
  switch (filter) {
    case 'all':
      return true;
    case 'failed':
      return overall === 'failure';
    case 'success':
      return overall === 'success';
    case 'cancelled':
      return run.conclusion === 'cancelled';
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
    case 'not_skipped':
      return matching.some((j) => j.conclusion !== 'skipped');
  }
}

/** Is the filter narrowing anything at all? */
export function isFlowsFilterActive(filter: FlowsFilter): boolean {
  return filter.runStatus !== 'all' || isJobFilterActive(filter);
}

/** The run the filter judges a flow by: its newest finished one (runs arrive newest first). */
export function latestFinishedRun(runs: readonly WorkflowRun[]): WorkflowRun | undefined {
  return runs.find((r) => r.status === 'completed');
}

/**
 * Why a flow is shown or hidden by the filter — the same decision as {@link flowMatchesFilter},
 * spelled out for the diagnostics log.
 *  - `match` / `off`: shown, because it matches or because no filter is on.
 *  - `loading`: shown for now; the judged run's jobs are still loading.
 *  - `no_finished_run`: hidden, the flow has never finished a run.
 *  - `status` / `job`: hidden by the status condition, or by the job condition.
 */
export type FlowFilterVerdict = 'off' | 'match' | 'loading' | 'no_finished_run' | 'status' | 'job';

export function flowFilterVerdict(
  runs: readonly WorkflowRun[],
  filter: FlowsFilter,
  jobsFor: (runId: number) => { jobs: Job[]; loaded: boolean },
): FlowFilterVerdict {
  if (!isFlowsFilterActive(filter)) return 'off';
  const run = latestFinishedRun(runs);
  if (!run) return 'no_finished_run';
  if (!matchesRunStatus(run, filter.runStatus)) return 'status';
  if (isJobFilterActive(filter)) {
    const { jobs, loaded } = jobsFor(run.id);
    if (!loaded) return 'loading';
    if (!jobConditionMatches(jobs, filter)) return 'job';
  }
  return 'match';
}

/** Does the verdict leave the flow on screen? */
export function isShownVerdict(verdict: FlowFilterVerdict): boolean {
  return verdict === 'off' || verdict === 'match' || verdict === 'loading';
}

/**
 * Whether the flow passes the filter, judged by its latest finished run. When the job filter is on
 * but that run's jobs aren't loaded yet (`loaded` false), the flow is kept visible to avoid flicker.
 */
export function flowMatchesFilter(
  runs: readonly WorkflowRun[],
  filter: FlowsFilter,
  jobsFor: (runId: number) => { jobs: Job[]; loaded: boolean },
): boolean {
  return isShownVerdict(flowFilterVerdict(runs, filter, jobsFor));
}

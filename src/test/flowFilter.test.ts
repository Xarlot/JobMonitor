import { describe, expect, it } from 'vitest';
import { flowFilterVerdict, flowMatchesFilter, jobConditionMatches, matchesRunStatus } from '../lib/flowFilter';
import { DEFAULT_FLOWS_FILTER } from '../context/FlowsFilterContext';
import type { Job, WorkflowRun } from '../api/types';

function run(over: Partial<WorkflowRun> & { id: number }): WorkflowRun {
  return {
    name: 'CI',
    display_title: 'CI',
    head_branch: 'main',
    head_sha: 'sha',
    run_number: over.id,
    run_attempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    html_url: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_started_at: null,
    ...over,
  };
}

function job(name: string, over: Partial<Job> = {}): Job {
  return {
    id: Math.random(),
    run_id: 1,
    name,
    status: 'completed',
    conclusion: 'success',
    started_at: null,
    completed_at: null,
    html_url: null,
    steps: [],
    ...over,
  };
}

describe('matchesRunStatus', () => {
  it('classifies a finished run by its conclusion', () => {
    expect(matchesRunStatus(run({ id: 1, conclusion: 'failure' }), 'failed')).toBe(true);
    expect(matchesRunStatus(run({ id: 1, conclusion: 'timed_out' }), 'failed')).toBe(true);
    expect(matchesRunStatus(run({ id: 1, conclusion: 'success' }), 'failed')).toBe(false);
    expect(matchesRunStatus(run({ id: 1, conclusion: 'cancelled' }), 'cancelled')).toBe(true);
    expect(matchesRunStatus(run({ id: 1, conclusion: 'success' }), 'all')).toBe(true);
    // As GitHub reads them: a cancel is a failure, a skip a pass.
    expect(matchesRunStatus(run({ id: 1, conclusion: 'cancelled' }), 'failed')).toBe(true);
    expect(matchesRunStatus(run({ id: 1, conclusion: 'skipped' }), 'success')).toBe(true);
    expect(matchesRunStatus(run({ id: 1, conclusion: 'skipped' }), 'cancelled')).toBe(false);
  });
});

describe('jobConditionMatches', () => {
  const jobs = [job('build'), job('integration', { conclusion: 'skipped' })];

  it('matches presence by substring', () => {
    expect(jobConditionMatches(jobs, { ...DEFAULT_FLOWS_FILTER, jobName: 'integ', jobState: 'any' })).toBe(true);
    expect(jobConditionMatches(jobs, { ...DEFAULT_FLOWS_FILTER, jobName: 'deploy', jobState: 'any' })).toBe(false);
  });

  it('handles the "not skipped" condition (the requested example)', () => {
    // integration was skipped -> "not skipped" should NOT match it
    expect(
      jobConditionMatches(jobs, { ...DEFAULT_FLOWS_FILTER, jobName: 'integration', jobState: 'not_skipped' }),
    ).toBe(false);
    // build succeeded (not skipped) -> matches
    expect(
      jobConditionMatches(jobs, { ...DEFAULT_FLOWS_FILTER, jobName: 'build', jobState: 'not_skipped' }),
    ).toBe(true);
  });
});

describe('flowMatchesFilter', () => {
  const loaded = () => ({ jobs: [] as Job[], loaded: true });

  it('judges the flow by its latest run, not by any of its runs', () => {
    const runs = [run({ id: 2, conclusion: 'success' }), run({ id: 1, conclusion: 'failure' })];
    expect(flowMatchesFilter(runs, { ...DEFAULT_FLOWS_FILTER, runStatus: 'failed' }, loaded)).toBe(false);
    expect(flowMatchesFilter(runs, { ...DEFAULT_FLOWS_FILTER, runStatus: 'success' }, loaded)).toBe(true);
  });

  it('skips unfinished runs and uses the last finished one', () => {
    const runs = [
      run({ id: 3, status: 'in_progress', conclusion: null }),
      run({ id: 2, status: 'queued', conclusion: null }),
      run({ id: 1, conclusion: 'cancelled' }),
    ];
    expect(flowMatchesFilter(runs, { ...DEFAULT_FLOWS_FILTER, runStatus: 'cancelled' }, loaded)).toBe(true);
    expect(flowMatchesFilter(runs, { ...DEFAULT_FLOWS_FILTER, runStatus: 'success' }, loaded)).toBe(false);
  });

  it('rules out a flow with no finished run once a filter is on', () => {
    const runs = [run({ id: 1, status: 'in_progress', conclusion: null })];
    expect(flowMatchesFilter(runs, { ...DEFAULT_FLOWS_FILTER, runStatus: 'failed' }, loaded)).toBe(false);
    expect(flowMatchesFilter([], { ...DEFAULT_FLOWS_FILTER, jobName: 'build' }, loaded)).toBe(false);
    expect(flowMatchesFilter([], DEFAULT_FLOWS_FILTER, loaded)).toBe(true);
  });

  it('keeps the flow visible while the judged run\'s jobs are loading', () => {
    const runs = [run({ id: 1 })];
    const out = flowMatchesFilter(runs, { ...DEFAULT_FLOWS_FILTER, jobName: 'build' }, () => ({
      jobs: [],
      loaded: false,
    }));
    expect(out).toBe(true);
  });

  it('checks the job condition against the latest finished run only', () => {
    const runs = [
      run({ id: 3, status: 'in_progress', conclusion: null }),
      run({ id: 2 }),
      run({ id: 1 }),
    ];
    const jobsFor = (id: number) => ({ jobs: id === 2 ? [job('test')] : [job('build')], loaded: true });
    expect(flowMatchesFilter(runs, { ...DEFAULT_FLOWS_FILTER, jobName: 'build' }, jobsFor)).toBe(false);
    expect(flowMatchesFilter(runs, { ...DEFAULT_FLOWS_FILTER, jobName: 'test' }, jobsFor)).toBe(true);
  });
});

describe('flowFilterVerdict', () => {
  const loaded = (jobs: Job[]) => () => ({ jobs, loaded: true });

  it('says why a flow was hidden', () => {
    const f = DEFAULT_FLOWS_FILTER;
    expect(flowFilterVerdict([run({ id: 1 })], f, loaded([]))).toBe('off');
    expect(flowFilterVerdict([], { ...f, runStatus: 'failed' }, loaded([]))).toBe('no_finished_run');
    expect(flowFilterVerdict([run({ id: 1 })], { ...f, runStatus: 'failed' }, loaded([]))).toBe('status');
    expect(flowFilterVerdict([run({ id: 1 })], { ...f, jobName: 'build' }, loaded([job('test')]))).toBe('job');
    expect(flowFilterVerdict([run({ id: 1 })], { ...f, jobName: 'build' }, loaded([job('build')]))).toBe('match');
    expect(
      flowFilterVerdict([run({ id: 1 })], { ...f, jobName: 'build' }, () => ({ jobs: [], loaded: false })),
    ).toBe('loading');
  });
});

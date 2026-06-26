import { describe, expect, it } from 'vitest';
import { filterRuns, jobConditionMatches, matchesRunStatus } from '../lib/flowFilter';
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
  it('classifies overall statuses', () => {
    expect(matchesRunStatus('failure', 'failed')).toBe(true);
    expect(matchesRunStatus('success', 'failed')).toBe(false);
    expect(matchesRunStatus('in_progress', 'active')).toBe(true);
    expect(matchesRunStatus('success', 'all')).toBe(true);
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

describe('filterRuns', () => {
  const runs = [
    run({ id: 1, conclusion: 'success' }),
    run({ id: 2, conclusion: 'failure' }),
  ];

  it('filters by run status', () => {
    const out = filterRuns(runs, { ...DEFAULT_FLOWS_FILTER, runStatus: 'failed' }, () => ({
      jobs: [],
      loaded: true,
    }));
    expect(out.map((r) => r.id)).toEqual([2]);
  });

  it('keeps runs visible while their jobs are still loading', () => {
    const out = filterRuns(runs, { ...DEFAULT_FLOWS_FILTER, jobName: 'build' }, () => ({
      jobs: [],
      loaded: false,
    }));
    expect(out).toHaveLength(2);
  });

  it('filters by job condition once jobs are loaded', () => {
    const out = filterRuns(
      runs,
      { ...DEFAULT_FLOWS_FILTER, jobName: 'build', jobState: 'any' },
      (id) => ({ jobs: id === 1 ? [job('build')] : [job('test')], loaded: true }),
    );
    expect(out.map((r) => r.id)).toEqual([1]);
  });
});

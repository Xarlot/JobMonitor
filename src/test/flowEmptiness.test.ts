import { describe, expect, it } from 'vitest';
import {
  emptyFilterNeedsArtifacts,
  emptyFilterNeedsLatestJobs,
  isFlowEmpty,
} from '../lib/flowEmptiness';
import type { EmptyFlowFilter } from '../storage/configStore';
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
    id: Math.floor(Math.random() * 1e6),
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

const filter = (over: Partial<EmptyFlowFilter>): EmptyFlowFilter => ({
  enabled: true,
  by: 'no_runs',
  minArtifactKB: 0,
  jobName: '',
  jobState: 'skipped',
  ...over,
});

const input = (over: Partial<{ runs: WorkflowRun[]; latestArtifactBytes: number | null; latestJobs: Job[] | null }>) => ({
  runs: [] as WorkflowRun[],
  latestArtifactBytes: null,
  latestJobs: null,
  ...over,
});

describe('isFlowEmpty', () => {
  it('is never empty when the filter is disabled', () => {
    expect(isFlowEmpty(input({}), filter({ enabled: false }))).toBe(false);
  });

  it('no_runs: empty only with zero runs', () => {
    expect(isFlowEmpty(input({ runs: [] }), filter({ by: 'no_runs' }))).toBe(true);
    expect(isFlowEmpty(input({ runs: [run({ id: 1 })] }), filter({ by: 'no_runs' }))).toBe(false);
  });

  it('only_skipped: empty when every run is skipped/neutral', () => {
    const skipped = [run({ id: 1, conclusion: 'skipped' }), run({ id: 2, conclusion: 'neutral' })];
    expect(isFlowEmpty(input({ runs: skipped }), filter({ by: 'only_skipped' }))).toBe(true);
    const mixed = [run({ id: 1, conclusion: 'skipped' }), run({ id: 2, conclusion: 'success' })];
    expect(isFlowEmpty(input({ runs: mixed }), filter({ by: 'only_skipped' }))).toBe(false);
  });

  it('no_artifacts: empty at/below threshold, unknown size keeps it visible', () => {
    const f = filter({ by: 'no_artifacts', minArtifactKB: 10 });
    expect(isFlowEmpty(input({ runs: [run({ id: 1 })], latestArtifactBytes: 0 }), f)).toBe(true);
    expect(isFlowEmpty(input({ runs: [run({ id: 1 })], latestArtifactBytes: 5 * 1024 }), f)).toBe(true);
    expect(isFlowEmpty(input({ runs: [run({ id: 1 })], latestArtifactBytes: 50 * 1024 }), f)).toBe(false);
    expect(isFlowEmpty(input({ runs: [run({ id: 1 })], latestArtifactBytes: null }), f)).toBe(false);
  });

  it('job: empty when a matching job is in the chosen state (the requested example)', () => {
    const f = filter({ by: 'job', jobName: 'test', jobState: 'skipped' });
    // a "unit-test" job that was skipped -> flow is empty
    expect(
      isFlowEmpty(input({ latestJobs: [job('build'), job('unit-test', { conclusion: 'skipped' })] }), f),
    ).toBe(true);
    // the test job ran (succeeded) -> not empty
    expect(
      isFlowEmpty(input({ latestJobs: [job('build'), job('unit-test', { conclusion: 'success' })] }), f),
    ).toBe(false);
    // no matching job -> not empty
    expect(isFlowEmpty(input({ latestJobs: [job('build')] }), f)).toBe(false);
    // jobs not loaded yet -> keep visible
    expect(isFlowEmpty(input({ latestJobs: null }), f)).toBe(false);
  });

  it('flags which criteria need extra fetches', () => {
    expect(emptyFilterNeedsArtifacts(filter({ by: 'no_artifacts' }))).toBe(true);
    expect(emptyFilterNeedsArtifacts(filter({ by: 'no_runs' }))).toBe(false);
    expect(emptyFilterNeedsLatestJobs(filter({ by: 'job' }))).toBe(true);
    expect(emptyFilterNeedsLatestJobs(filter({ enabled: false, by: 'job' }))).toBe(false);
    expect(emptyFilterNeedsLatestJobs(filter({ by: 'no_runs' }))).toBe(false);
  });
});

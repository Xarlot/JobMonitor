import { describe, expect, it } from 'vitest';
import { mergeCheckRunsWithJobs } from '../components/TimelineDialog';
import type { CheckRun, Job } from '../api/types';

function check(over: Partial<CheckRun>): CheckRun {
  return {
    id: 1,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-19T10:05:00Z',
    completed_at: '2026-10-19T10:15:00Z',
    html_url: null,
    details_url: null,
    app: null,
    ...over,
  };
}

function job(over: Partial<Job>): Job {
  return {
    id: 1,
    run_id: 77,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-10-19T10:00:00Z',
    started_at: '2026-10-19T10:05:00Z',
    completed_at: '2026-10-19T10:15:00Z',
    html_url: null,
    steps: [
      {
        name: 'Set up job',
        number: 1,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-19T10:05:00Z',
        completed_at: '2026-10-19T10:06:00Z',
      },
    ],
    ...over,
  } as Job;
}

describe('mergeCheckRunsWithJobs', () => {
  it('starts an Actions check at its queue time and splits off queue + set-up', () => {
    const [item] = mergeCheckRunsWithJobs(
      [check({ id: 500, name: 'CI / build', details_url: 'https://github.com/o/r/actions/runs/77/job/9' })],
      [job({ id: 9 })],
    );
    expect(item).toMatchObject({
      id: 500,
      label: 'CI / build',
      started_at: '2026-10-19T10:00:00Z',
      completed_at: '2026-10-19T10:15:00Z',
      allocationEndIso: '2026-10-19T10:06:00Z',
    });
  });

  it("finds the job by its check-run id when the details URL doesn't name it", () => {
    const [item] = mergeCheckRunsWithJobs(
      [check({ id: 42 })],
      [job({ id: 9, check_run_url: 'https://api.github.com/repos/o/r/check-runs/42' })],
    );
    expect(item.started_at).toBe('2026-10-19T10:00:00Z');
  });

  it('keeps a plain bar for a check with no job behind it', () => {
    const [item] = mergeCheckRunsWithJobs([check({ id: 3, name: 'codecov' })], [job({ id: 9 })]);
    expect(item).toMatchObject({ id: 3, label: 'codecov', started_at: '2026-10-19T10:05:00Z' });
    expect(item.allocationEndIso).toBeUndefined();
  });
});

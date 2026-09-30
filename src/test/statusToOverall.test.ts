/**
 * How a finished run's conclusion reads. GitHub's own rule for a required check is the reference:
 * `neutral` and `skipped` let a merge through, `cancelled` blocks it like a failure.
 */

import { describe, expect, it } from 'vitest';
import { BROKEN_CONCLUSIONS, statusToOverall } from '../lib/status';
import { isFailingJob } from '../lib/failures';
import type { Job, RunConclusion } from '../api/types';

describe('statusToOverall', () => {
  it.each<[RunConclusion, string]>([
    ['success', 'success'],
    ['neutral', 'success'],
    ['skipped', 'success'],
    ['failure', 'failure'],
    ['timed_out', 'failure'],
    ['startup_failure', 'failure'],
    ['action_required', 'failure'],
    ['cancelled', 'failure'],
    ['stale', 'pending'],
    [null, 'neutral'],
  ])('reads a completed %s as %s', (conclusion, expected) => {
    expect(statusToOverall('completed', conclusion)).toBe(expected);
  });

  it('reads unfinished runs by their status', () => {
    expect(statusToOverall('in_progress', null)).toBe('in_progress');
    expect(statusToOverall('queued', null)).toBe('pending');
  });
});

describe('what counts as broken', () => {
  /** A fail-fast matrix cancels every sibling of the job that failed; those are not failures to report. */
  it('leaves a cancel out of the Failures tab although it reads as failed', () => {
    expect(BROKEN_CONCLUSIONS.has('cancelled')).toBe(false);
    const job = { status: 'completed', conclusion: 'cancelled' } as Job;
    expect(isFailingJob(job)).toBe(false);
    expect(isFailingJob({ ...job, conclusion: 'failure' })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { formatMs, jobTiming, summarizeTiming } from '../lib/jobTiming';
import type { Job } from '../api/types';

const T = (s: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, s)).toISOString();

function job(over: Partial<Job>): Job {
  return {
    id: 1,
    run_id: 7,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    created_at: T(0),
    started_at: T(30),
    completed_at: T(300),
    html_url: null,
    steps: [
      { name: 'Set up job', number: 1, status: 'completed', conclusion: 'success', started_at: T(30), completed_at: T(40) },
    ],
    ...over,
  };
}

describe('jobTiming', () => {
  it('splits a job into queue, set-up and work', () => {
    expect(jobTiming(job({}))).toMatchObject({ queuedMs: 30_000, setupMs: 10_000, workMs: 260_000, stillQueued: false });
  });

  it('counts a job still waiting for a runner up to now', () => {
    const t = jobTiming(job({ status: 'queued', conclusion: null, started_at: null, completed_at: null, steps: [] }), Date.parse(T(45)));
    expect(t).toMatchObject({ queuedMs: 45_000, stillQueued: true, setupMs: null, workMs: null });
  });

  it('has no queue time for a job cancelled before it started', () => {
    const t = jobTiming(job({ conclusion: 'cancelled', started_at: null, steps: [] }));
    expect(t.queuedMs).toBeNull();
  });

  it('treats the whole run as work when there is no set-up step', () => {
    expect(jobTiming(job({ steps: [] }))).toMatchObject({ setupMs: null, workMs: 270_000 });
  });
});

describe('summarizeTiming', () => {
  it('finds the longest wait and sums them', () => {
    const s = summarizeTiming([job({ id: 1, name: 'a' }), job({ id: 2, name: 'b', created_at: T(-60) })]);
    expect(s.longestQueue?.name).toBe('b');
    expect(s.totalQueuedMs).toBe(120_000);
    expect(s.stillQueued).toBe(0);
  });

  it('has no longest wait when no job reports a queue time', () => {
    expect(summarizeTiming([job({ created_at: null })]).longestQueue).toBeNull();
  });
});

describe('formatMs', () => {
  it('formats like formatDuration', () => {
    expect(formatMs(4_000)).toBe('4s');
    expect(formatMs(125_000)).toBe('2m 5s');
    expect(formatMs(3_780_000)).toBe('1h 3m');
    expect(formatMs(null)).toBe('—');
  });
});

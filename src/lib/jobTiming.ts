/**
 * Where a job's time went: waiting in the queue for a runner, setting the runner up, and the work.
 *
 * Queue = created_at → started_at (GitHub creates the job when it is queued, and starts it when a
 * runner picks it up); set-up = the "Set up job" step; work = everything after it. A job still
 * waiting for a runner has queued up to `now`.
 */

import type { Job } from '../api/types';

export interface JobTiming {
  id: number;
  name: string;
  /** Null when GitHub didn't say when the job was queued. */
  queuedMs: number | null;
  /** True while the job is still waiting for a runner — `queuedMs` keeps growing. */
  stillQueued: boolean;
  setupMs: number | null;
  workMs: number | null;
}

function span(from: string | null | undefined, to: string | null | undefined, now: number): number | null {
  if (!from) return null;
  const a = Date.parse(from);
  const b = to ? Date.parse(to) : now;
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

export function setupStep(job: Job) {
  return job.steps.find((s) => s.number === 1 || /set up job/i.test(s.name)) ?? null;
}

export function jobTiming(job: Job, now: number = Date.now()): JobTiming {
  const stillQueued = !job.started_at && job.status !== 'completed';
  const setup = setupStep(job);
  const setupEnd = setup?.completed_at ?? null;
  return {
    id: job.id,
    name: job.name,
    // A job that finished without ever starting (cancelled in the queue) has no queue end.
    queuedMs: job.started_at || stillQueued ? span(job.created_at, job.started_at, now) : null,
    stillQueued,
    setupMs: job.started_at && setupEnd ? span(job.started_at, setupEnd, now) : null,
    workMs: job.started_at
      ? span(setupEnd ?? job.started_at, job.completed_at, now)
      : null,
  };
}

export interface TimingSummary {
  jobs: JobTiming[];
  /** The job that waited longest for a runner; null when no job reports a queue time. */
  longestQueue: JobTiming | null;
  /** Queue time summed over every job — runner-minutes not spent working. */
  totalQueuedMs: number;
  /** Jobs that have not got a runner yet. */
  stillQueued: number;
}

export function summarizeTiming(jobs: Job[], now: number = Date.now()): TimingSummary {
  const timings = jobs.map((j) => jobTiming(j, now));
  let longestQueue: JobTiming | null = null;
  let totalQueuedMs = 0;
  for (const t of timings) {
    if (t.queuedMs === null) continue;
    totalQueuedMs += t.queuedMs;
    if (!longestQueue || t.queuedMs > (longestQueue.queuedMs ?? 0)) longestQueue = t;
  }
  return {
    jobs: timings,
    longestQueue,
    totalQueuedMs,
    stillQueued: timings.filter((t) => t.stillQueued).length,
  };
}

/** `4s`, `2m 5s`, `1h 3m` — the same shape as formatDuration, from milliseconds. */
export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  let secs = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

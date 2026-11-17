import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../api/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Drops the database; the open connection closes itself on `versionchange`. */
function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('job-monitor');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** A fresh module instance — what a restart gives: memory gone, IndexedDB kept. */
async function restart() {
  vi.resetModules();
  return await import('../storage/failureCaches');
}

/** A run shaped like java cron #595: 540 jobs, each with 25 steps, a handful failing. */
function bigRun(): Job[] {
  return Array.from({ length: 540 }, (_, i) => ({
    id: 134053968690 + i,
    run_id: 44036084120,
    name: `java / shard-${i} / test-java (spreadsheet-core, UBUNTU)`,
    status: 'completed',
    conclusion: i % 100 === 7 ? 'failure' : 'success',
    started_at: '2026-11-17T07:06:04Z',
    completed_at: '2026-11-17T07:06:19Z',
    html_url: `https://github.com/o/r/actions/runs/44036084120/job/${134053968690 + i}`,
    check_run_url: `https://api.github.com/repos/o/r/check-runs/${134053968690 + i}`,
    steps: Array.from({ length: 25 }, (_, n) => ({
      name: `Step number ${n + 1} of the job`,
      status: 'completed',
      conclusion: 'success',
      number: n + 1,
      started_at: '2026-11-17T07:06:05Z',
      completed_at: '2026-11-17T07:06:07Z',
    })),
  })) as Job[];
}

describe('flowRunJobsCache (IndexedDB)', () => {
  beforeEach(async () => {
    vi.resetModules();
    await deleteDb();
  });
  afterEach(() => vi.useRealTimers());

  /**
   * In localStorage's 300 KB budget a run this size trimmed the whole cache to nothing, so it and
   * every other flow were refetched after each restart.
   */
  it('keeps a whole 540-job run, with its steps, across a restart — and the other runs too', async () => {
    const { flowRunJobsCache } = await import('../storage/failureCaches');
    const jobs = bigRun();
    expect(JSON.stringify(jobs).length).toBeGreaterThan(1_000_000);
    await flowRunJobsCache.setMany([
      ['1:1', jobs.slice(0, 3)],
      ['44036084120:3', jobs],
    ]);

    const reloaded = (await restart()).flowRunJobsCache;
    expect(reloaded.peek()).toBeNull(); // not read yet — callers must wait for load()
    const entries = new Map(await reloaded.load());
    expect(entries.get('44036084120:3')).toHaveLength(540);
    expect(entries.get('44036084120:3')?.[0].steps).toHaveLength(25);
    expect(entries.get('1:1')).toHaveLength(3);
    expect(reloaded.peek()).toHaveLength(2);
  });

  it('drops entries older than a week, from memory and from the database', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const { flowRunJobsCache } = await import('../storage/failureCaches');
    await flowRunJobsCache.load();
    await flowRunJobsCache.setMany([['old:1', bigRun().slice(0, 1)]]);
    vi.setSystemTime(new Date(Date.parse('2026-11-01T00:00:00Z') + 6 * DAY_MS));
    await flowRunJobsCache.setMany([['new:1', bigRun().slice(0, 1)]]);

    // Still within the week: both live in this session.
    expect(flowRunJobsCache.peek()?.map(([k]) => k).sort()).toEqual(['new:1', 'old:1']);

    vi.setSystemTime(new Date(Date.parse('2026-11-01T00:00:00Z') + 8 * DAY_MS));
    expect(flowRunJobsCache.peek()?.map(([k]) => k)).toEqual(['new:1']);

    const reloaded = (await restart()).flowRunJobsCache;
    expect((await reloaded.load()).map(([k]) => k)).toEqual(['new:1']);

    // ...and the expired record is gone from IndexedDB, not just filtered out.
    const { idbEntries, FLOW_RUN_JOBS_STORE } = await import('../storage/db');
    expect((await idbEntries(FLOW_RUN_JOBS_STORE)).map(([k]) => k)).toEqual(['new:1']);
  });

  it('keeps at most 200 runs, evicting the oldest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { flowRunJobsCache } = await import('../storage/failureCaches');
    const job = bigRun().slice(0, 1);
    for (let i = 0; i < 205; i++) {
      vi.setSystemTime(1_800_000_000_000 + i * 1000);
      await flowRunJobsCache.setMany([[`${i}:1`, job]]);
    }
    const keys = (await (await restart()).flowRunJobsCache.load()).map(([k]) => k);
    expect(keys).toHaveLength(200);
    expect(keys).not.toContain('0:1');
    expect(keys).toContain('204:1');
  });

  /** What a flow's runs table does on expand after a restart. */
  it('serves a finished run attempt from the cache, never a running one or another attempt', async () => {
    const { rememberFinishedRunJobs } = await import('../storage/failureCaches');
    const jobs = bigRun();
    const run = { id: 44036084120, run_attempt: 3, status: 'completed' };
    await rememberFinishedRunJobs({ ...run, id: 1, status: 'in_progress' }, jobs);
    await rememberFinishedRunJobs(run, jobs);

    const reloaded = await restart();
    expect(await reloaded.readFinishedRunJobs(run)).toHaveLength(540);
    expect(await reloaded.readFinishedRunJobs({ ...run, run_attempt: 4 })).toBeUndefined();
    expect(await reloaded.readFinishedRunJobs({ ...run, id: 1 })).toBeUndefined();
    expect(await reloaded.readFinishedRunJobs({ ...run, status: 'in_progress' })).toBeUndefined();
  });
});

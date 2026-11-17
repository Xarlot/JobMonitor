/**
 * Fetches ALL jobs of a workflow run, following pagination. A run can have more
 * than 100 jobs (the API page size cap); without this, jobs beyond the first
 * page are missed — which can hide the failing job while the run's own
 * conclusion is `failure`.
 *
 * GitHub builds a jobs page with every job's steps inline, and for a big re-run
 * (540 jobs, attempt 3) a 100-job page takes it longer than its gateway allows:
 * the answer is a 502 without CORS headers, which `fetch` reports as a network
 * failure, on every try. Smaller pages come back, so a failed page drops the
 * page size and starts over, and the size that worked is kept for that run.
 */

import { ghGet, GitHubApiError } from './githubClient';
import { runJobsPath } from './endpoints';
import type { Job, JobsResponse } from './types';

/** Page sizes to try, largest first. */
export const JOB_PAGE_SIZES = [100, 50, 25] as const;
const MAX_JOBS = 2000; // safety cap
/** Pages after the first fetched at once — each can take GitHub several seconds. */
const PAGE_CONCURRENCY = 4;

/** Page size that last worked per run, so polling does not re-hit the 502 first. */
const pageSizeByRun = new Map<string, number>();

/** Network failures, timeouts and gateway errors — the ones a smaller page can cure. */
function isRetryableWithSmallerPage(e: unknown): boolean {
  return e instanceof GitHubApiError && (e.status === 0 || e.status >= 500);
}

async function fetchWithPageSize(
  owner: string,
  repo: string,
  runId: number,
  perPage: number,
): Promise<Job[]> {
  const first = await ghGet<JobsResponse>(runJobsPath(owner, repo, runId, 1, perPage));
  const total = Math.min(first.data.total_count, MAX_JOBS);
  const lastPage = Math.ceil(total / perPage);
  const pages: Job[][] = [first.data.jobs];

  let next = 2;
  const worker = async () => {
    while (next <= lastPage) {
      const page = next++;
      const res = await ghGet<JobsResponse>(runJobsPath(owner, repo, runId, page, perPage));
      pages[page - 1] = res.data.jobs;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, lastPage - 1) }, worker));

  // Pages in order; de-dupe by id in case the list shifted between page reads.
  const seen = new Set<number>();
  const jobs: Job[] = [];
  for (const page of pages) {
    for (const job of page ?? []) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(job);
    }
  }
  return jobs;
}

export async function fetchAllRunJobs(owner: string, repo: string, runId: number): Promise<Job[]> {
  const key = `${owner}/${repo}/${runId}`;
  const known = pageSizeByRun.get(key);
  const sizes = known ? JOB_PAGE_SIZES.filter((s) => s <= known) : [...JOB_PAGE_SIZES];

  for (let i = 0; ; i++) {
    try {
      const jobs = await fetchWithPageSize(owner, repo, runId, sizes[i]);
      pageSizeByRun.set(key, sizes[i]);
      return jobs;
    } catch (e) {
      if (i === sizes.length - 1 || !isRetryableWithSmallerPage(e)) throw e;
    }
  }
}

/** Every cache key a run's jobs may sit under — one per page size and page. */
export function runJobsCachePaths(owner: string, repo: string, runId: number): string[] {
  const out: string[] = [];
  for (const size of JOB_PAGE_SIZES) {
    for (let page = 1; page <= Math.ceil(MAX_JOBS / size); page++) {
      out.push(runJobsPath(owner, repo, runId, page, size));
    }
  }
  return out;
}

/** Test seam. */
export function __resetJobPageSizes(): void {
  pageSizeByRun.clear();
}

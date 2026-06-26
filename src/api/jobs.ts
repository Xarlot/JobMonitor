/**
 * Fetches ALL jobs of a workflow run, following pagination. A run can have more
 * than 100 jobs (the API page size cap); without this, jobs beyond the first
 * page are missed — which can hide the failing job while the run's own
 * conclusion is `failure`.
 */

import { ghGet } from './githubClient';
import { runJobsPath } from './endpoints';
import type { Job, JobsResponse } from './types';

const MAX_PAGES = 20; // safety cap (up to ~2000 jobs)

export async function fetchAllRunJobs(owner: string, repo: string, runId: number): Promise<Job[]> {
  const first = await ghGet<JobsResponse>(runJobsPath(owner, repo, runId, 1));
  const total = first.data.total_count;
  let jobs = first.data.jobs;

  for (let page = 2; jobs.length < total && page <= MAX_PAGES; page++) {
    const res = await ghGet<JobsResponse>(runJobsPath(owner, repo, runId, page));
    if (res.data.jobs.length === 0) break;
    jobs = jobs.concat(res.data.jobs);
  }
  return jobs;
}

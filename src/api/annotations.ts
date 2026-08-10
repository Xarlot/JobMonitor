/**
 * Check-run annotations — the structured "which test failed, where, and why" that
 * GitHub attaches to a check. Read by the per-job summary, the run-wide summary,
 * the failure reports and the auto-rerun fingerprint, so the request and its
 * best-effort policy live here rather than in four callers.
 */

import { checkRunAnnotationsPath, checkRunIdFromUrl } from './endpoints';
import { ghGet } from './githubClient';
import type { Annotation, Job } from './types';
import { Operation, Telemetry } from '../lib/telemetry';

export async function fetchAnnotations(
  owner: string,
  repo: string,
  checkRunId: number,
): Promise<Annotation[]> {
  const { data } = await ghGet<Annotation[]>(checkRunAnnotationsPath(owner, repo, checkRunId));
  return data;
}

/**
 * Best-effort variant: an unavailable annotation list is normal (not every check
 * emits them, and a fine-grained token may be refused), and every caller treats it
 * as "none" rather than an error worth surfacing.
 */
export async function fetchAnnotationsOrEmpty(
  owner: string,
  repo: string,
  checkRunId: number,
): Promise<Annotation[]> {
  try {
    return await fetchAnnotations(owner, repo, checkRunId);
  } catch {
    return [];
  }
}

/**
 * Annotations for a job, resolved from its `check_run_url`. Returns none when the
 * job carries no check-run link.
 */
export async function fetchJobAnnotations(
  owner: string,
  repo: string,
  job: Job,
): Promise<Annotation[]> {
  return Telemetry.measure(Operation.GH_ANNOTATIONS_FETCH, () => fetchJobAnnotations__impl(owner, repo, job));
}

async function fetchJobAnnotations__impl(
  owner: string,
  repo: string,
  job: Job,
): Promise<Annotation[]> {
  const checkRunId = checkRunIdFromUrl(job.check_run_url);
  if (checkRunId == null) return [];
  return fetchAnnotationsOrEmpty(owner, repo, checkRunId);
}

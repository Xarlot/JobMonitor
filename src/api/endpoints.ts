/**
 * Builders for the GitHub REST paths the dashboard reads. Each returns a path
 * (with query) relative to https://api.github.com; the same string doubles as
 * the ETag cache key in githubClient.
 */

const enc = encodeURIComponent;

export function pullsPath(
  owner: string,
  repo: string,
  opts: { head?: string | null } = {},
): string {
  const params = new URLSearchParams({ state: 'open', per_page: '100', sort: 'updated', direction: 'desc' });
  if (opts.head) params.set('head', opts.head);
  return `/repos/${enc(owner)}/${enc(repo)}/pulls?${params.toString()}`;
}

export function checkRunsPath(owner: string, repo: string, ref: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/check-runs?per_page=100`;
}

export function combinedStatusPath(owner: string, repo: string, ref: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/status`;
}

export function workflowsPath(owner: string, repo: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/workflows?per_page=100`;
}

export function workflowRunsPath(
  owner: string,
  repo: string,
  workflowFile: string,
  opts: { branch?: string; event?: string; perPage?: number } = {},
): string {
  const params = new URLSearchParams({ per_page: String(opts.perPage ?? 5) });
  if (opts.branch) params.set('branch', opts.branch);
  if (opts.event) params.set('event', opts.event);
  return `/repos/${enc(owner)}/${enc(repo)}/actions/workflows/${enc(workflowFile)}/runs?${params.toString()}`;
}

export function runJobsPath(owner: string, repo: string, runId: number, page = 1): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/jobs?per_page=100&page=${page}`;
}

export function runArtifactsPath(owner: string, repo: string, runId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/artifacts?per_page=100`;
}

/** Download endpoint for a single artifact's zip; 302-redirects to a signed blob URL. */
export function artifactZipPath(owner: string, repo: string, artifactId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/artifacts/${artifactId}/zip`;
}

/** Extract the Actions run id from a URL like `.../actions/runs/{id}` (job/check URLs included). */
export function runIdFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/actions\/runs\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function jobLogsPath(owner: string, repo: string, jobId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/jobs/${jobId}/logs`;
}

export function singleJobPath(owner: string, repo: string, jobId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/jobs/${jobId}`;
}

/** Extract the Actions job id from a check-run's details_url/html_url (.../job/{id}). */
export function jobIdFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/job\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function checkRunAnnotationsPath(owner: string, repo: string, checkRunId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/check-runs/${checkRunId}/annotations?per_page=50`;
}

/** Extract the trailing check-run id from a job's `check_run_url`, if present. */
export function checkRunIdFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/check-runs\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The fork-branch `head` filter value: `forkOwner:branch`. */
export function headFilter(forkOwner: string, branch: string | null): string | null {
  return branch ? `${forkOwner}:${branch}` : null;
}

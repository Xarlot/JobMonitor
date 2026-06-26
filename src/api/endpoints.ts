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

export function runJobsPath(owner: string, repo: string, runId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/jobs?per_page=100`;
}

export function runArtifactsPath(owner: string, repo: string, runId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/artifacts?per_page=100`;
}

/** The fork-branch `head` filter value: `forkOwner:branch`. */
export function headFilter(forkOwner: string, branch: string | null): string | null {
  return branch ? `${forkOwner}:${branch}` : null;
}

/**
 * Builders for the GitHub REST paths the dashboard reads. Each returns a path
 * (with query) relative to https://api.github.com; the same string doubles as
 * the ETag cache key in githubClient.
 */

const enc = encodeURIComponent;

export function pullsPath(
  owner: string,
  repo: string,
  opts: { head?: string | null; base?: string | null; state?: 'open' | 'closed'; perPage?: number } = {},
): string {
  const params = new URLSearchParams({
    state: opts.state ?? 'open',
    per_page: String(opts.perPage ?? 100),
    sort: 'updated',
    direction: 'desc',
  });
  if (opts.head) params.set('head', opts.head);
  // Left out when unset, so every path an earlier version built stays byte-identical —
  // these strings double as ETag cache keys, and a changed key throws the cache away.
  if (opts.base) params.set('base', opts.base);
  return `/repos/${enc(owner)}/${enc(repo)}/pulls?${params.toString()}`;
}

/**
 * One pull request.
 *
 * GET is the **only** source of `mergeable` and `mergeable_state` — the list endpoint
 * omits both — which is what the feature-branch tab reads to say why a merge is stuck.
 * PATCHed to clear the description when arming auto-merge from the PR list.
 */
export function pullPath(owner: string, repo: string, number: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`;
}

/** POST target: open a pull request. Both refs are plain branch names within `repo`. */
export function createPullPath(owner: string, repo: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/pulls`;
}

/**
 * POST target: sync one branch of a fork from the same-named branch of its parent.
 *
 * GitHub's "Sync fork" button. The body names only the branch — the source repository is
 * the fork's **actual parent**, which the request cannot override, so callers must first
 * establish that the parent is the upstream they think it is. See forkSync.ts.
 */
export function mergeUpstreamPath(owner: string, repo: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/merge-upstream`;
}

/**
 * Every ref whose name starts with `prefix`, e.g. `heads/feature/` for the feature
 * branches. GitHub matches on the prefix server-side, which is why this is used instead
 * of listing all branches and filtering here: a large repository has many pages of
 * branches, each entry carrying a full commit object.
 *
 * `prefix` is **not** encoded — its slashes are path separators to this endpoint, and
 * percent-encoding them makes the prefix match nothing.
 */
export function matchingRefsPath(owner: string, repo: string, prefix: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/git/matching-refs/${prefix}`;
}

/**
 * One ref, by name — `heads/main`, `heads/feature/x`.
 *
 * Like {@link matchingRefsPath} the name is **not** encoded: its slashes separate path segments to
 * this endpoint, so `feature%2Fx` resolves to nothing. Unlike the matching-refs endpoint this one
 * answers 404 for a ref that does not exist, which is how "does this branch exist" is asked.
 */
export function refPath(owner: string, repo: string, ref: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/git/ref/${ref}`;
}

/** POST target for creating a ref. The body carries `ref` (full `refs/heads/...`) and `sha`. */
export function createRefPath(owner: string, repo: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/git/refs`;
}

/**
 * What is in `head` that is not in `base`: commits and changed files.
 *
 * Each side must be a **commit SHA or a branch name with no slash in it**. A `feature/x`
 * cannot be passed by name: the two refs share one path segment here, so its slash would
 * have to be percent-encoded, and that is not reliably interpreted. The ref listing
 * already yields every feature branch's SHA — which also pins the comparison to exactly
 * the commit the UI displayed.
 */
export function comparePath(owner: string, repo: string, base: string, head: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/compare/${enc(base)}...${enc(head)}`;
}

/**
 * GitHub's GraphQL endpoint.
 *
 * Needed because enabling auto-merge has no REST equivalent — `enablePullRequestAutoMerge`
 * is a GraphQL mutation and nothing else offers it. Everything the app *reads* stays REST.
 */
export const GRAPHQL_PATH = '/graphql';

/**
 * The repository itself. Read for `permissions.push` — whether the authenticated
 * account has the Write role, which re-running workflows requires on top of the
 * token's own scope.
 */
export function repoPath(owner: string, repo: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}`;
}

export function checkRunsPath(owner: string, repo: string, ref: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/check-runs?per_page=100`;
}

export function combinedStatusPath(owner: string, repo: string, ref: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/status`;
}

/**
 * One page of the repo's workflow list (100 is GitHub's cap). `page` is left out
 * of the query when 1, so the first page's path — which doubles as its ETag cache
 * key — stays byte-identical to what earlier versions requested.
 */
export function workflowsPath(owner: string, repo: string, page = 1): string {
  const params = new URLSearchParams({ per_page: '100' });
  if (page > 1) params.set('page', String(page));
  return `/repos/${enc(owner)}/${enc(repo)}/actions/workflows?${params.toString()}`;
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

/**
 * Repo-wide workflow runs across all workflows, most-recent first. `created`
 * accepts a GitHub date filter (e.g. ">=2024-01-01T00:00:00Z") to bound the window.
 *
 * `headSha` narrows to one commit, which is how a pull request is mapped to the
 * workflow runs it triggered: a single request yields every run for the PR head,
 * each with its `path` (workflow file), `run_attempt`, `status` and `conclusion`.
 * Options left unset don't appear in the query, so existing callers keep their
 * exact path — which doubles as the ETag cache key.
 */
export function repoRunsPath(
  owner: string,
  repo: string,
  opts: { created?: string; perPage?: number; page?: number; headSha?: string } = {},
): string {
  const params = new URLSearchParams({ per_page: String(opts.perPage ?? 100) });
  if (opts.created) params.set('created', opts.created);
  if (opts.page && opts.page > 1) params.set('page', String(opts.page));
  if (opts.headSha) params.set('head_sha', opts.headSha);
  return `/repos/${enc(owner)}/${enc(repo)}/actions/runs?${params.toString()}`;
}

/**
 * POST target: re-run only the failed jobs (and their dependents) of a run.
 * Answers 201 with an empty body. Requires Actions write — see tokenCapability.
 */
export function rerunFailedJobsPath(owner: string, repo: string, runId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}/rerun-failed-jobs`;
}

/** A single workflow run — the authoritative source of its workflow file + attempt. */
export function singleRunPath(owner: string, repo: string, runId: number): string {
  return `/repos/${enc(owner)}/${enc(repo)}/actions/runs/${runId}`;
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

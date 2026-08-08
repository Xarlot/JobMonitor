/**
 * Discovery of the shared feature branches: the ones present in **both** the upstream and
 * the fork.
 *
 * Read-only, and the only part of this feature that runs unprompted, so it is built to be
 * cheap. `git/matching-refs` filters by prefix server-side and answers with just a name
 * and a SHA per ref — where listing branches would return every branch in the repository,
 * each carrying a full commit object and a protection block, several pages deep on a real
 * repository. Both pages are ETag-cached like every other read, so re-polling costs a 304.
 */

import { matchingRefsPath } from './endpoints';
import { ghGet, GitHubApiError } from './githubClient';
import type { GitRef } from './types';

/** Safety cap. 100 refs per page, so ~1000 feature branches — far past any real repo. */
const MAX_REF_PAGES = 10;
const REFS_PER_PAGE = 100;

/** A branch that exists in both repositories, with each side's tip. */
export interface FeatureBranch {
  /** Short name, e.g. `feature/payments`. */
  name: string;
  upstreamSha: string;
  forkSha: string;
}

/** Strip the `refs/heads/` qualification `matching-refs` answers with. */
function shortName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Every branch of one repository under `prefix`, as name → tip SHA.
 *
 * A prefix that matches nothing answers 404 rather than an empty array, which is a normal
 * outcome here — a repository with no feature branches at all — and so is mapped to an
 * empty map rather than propagated. Any other failure propagates: "no feature branches"
 * and "we could not find out" must not look the same to the caller.
 */
export async function fetchBranchesUnder(
  owner: string,
  repo: string,
  prefix: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let page = 1; page <= MAX_REF_PAGES; page++) {
    const path = `${matchingRefsPath(owner, repo, `heads/${prefix}`)}?per_page=${REFS_PER_PAGE}${
      page > 1 ? `&page=${page}` : ''
    }`;
    let batch: GitRef[];
    try {
      ({ data: batch } = await ghGet<GitRef[]>(path));
    } catch (e) {
      if (e instanceof GitHubApiError && e.status === 404) return out;
      throw e;
    }
    // A single exact match answers with an object rather than an array. It cannot happen
    // for a prefix ending in `/`, but the prefix is user-editable, so handle it.
    if (!Array.isArray(batch)) batch = [batch as GitRef];
    for (const ref of batch) out.set(shortName(ref.ref), ref.object.sha);
    if (batch.length < REFS_PER_PAGE) break;
  }
  return out;
}

/**
 * The branches shared by the upstream and the fork, sorted by name.
 *
 * Matched **case-sensitively**, because git refs are: `feature/Payments` and
 * `feature/payments` are two different branches and can both exist. Lower-casing to be
 * forgiving here would silently pair a branch with one it isn't.
 */
export async function fetchFeatureBranches(
  upstream: { owner: string; repo: string },
  fork: { owner: string; repo: string },
  prefix: string,
): Promise<FeatureBranch[]> {
  const [upstreamRefs, forkRefs] = await Promise.all([
    fetchBranchesUnder(upstream.owner, upstream.repo, prefix),
    fetchBranchesUnder(fork.owner, fork.repo, prefix),
  ]);

  const out: FeatureBranch[] = [];
  for (const [name, upstreamSha] of upstreamRefs) {
    const forkSha = forkRefs.get(name);
    if (forkSha) out.push({ name, upstreamSha, forkSha });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

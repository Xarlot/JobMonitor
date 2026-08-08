/**
 * Pulling a branch of the upstream down into the same-named branch of the fork —
 * GitHub's "Sync fork", done through the API.
 *
 * **The request cannot name where to sync from.** The body carries only a branch name;
 * GitHub resolves the source as that branch in the fork's *actual parent*. If the
 * repository configured as the upstream is not that parent, this call still answers 200
 * and still updates the branch — from somewhere else. There is no error to catch, so the
 * only defence is to establish the relationship first, which is what `verifyForkParent`
 * is for and why nothing here calls the endpoint without it.
 *
 * The sync is also a **write into the user's fork that this app cannot undo**: a branch
 * that has diverged is not refused, it is merged, leaving a merge commit behind. Callers
 * must say so before asking.
 */

import { mergeUpstreamPath, repoPath } from './endpoints';
import { ghGet, ghWriteJson, GitHubApiError, type WriteSubject } from './githubClient';
import { recordWriteRefused } from './tokenCapability';
import type { MergeUpstreamResult, Repository } from './types';

const SYNC_SUBJECT: WriteSubject = { action: 'sync this branch', noun: 'Branch' };

/** Why the fork can't be synced from the configured upstream, or null when it can. */
export type ForkParentProblem =
  | { kind: 'not-a-fork'; forkSlug: string }
  | { kind: 'wrong-parent'; forkSlug: string; actualParent: string; expected: string }
  | { kind: 'unreadable'; message: string };

export interface ForkParentCheck {
  ok: boolean;
  problem?: ForkParentProblem;
}

/**
 * Establish that the fork really is a fork of the configured upstream.
 *
 * Cheap — the repository read is ETag-cached like every other, and `probePushAccess`
 * already fetches the upstream's — and it is the only thing standing between a mistyped
 * fork owner and a branch quietly synced from an unrelated repository.
 */
export async function verifyForkParent(
  fork: { owner: string; repo: string },
  upstream: { owner: string; repo: string },
): Promise<ForkParentCheck> {
  const forkSlug = `${fork.owner}/${fork.repo}`;
  const expected = `${upstream.owner}/${upstream.repo}`;

  let data: Repository;
  try {
    ({ data } = await ghGet<Repository>(repoPath(fork.owner, fork.repo)));
  } catch (e) {
    return {
      ok: false,
      problem: { kind: 'unreadable', message: e instanceof Error ? e.message : String(e) },
    };
  }

  if (!data.fork) return { ok: false, problem: { kind: 'not-a-fork', forkSlug } };

  const actualParent = data.parent?.full_name ?? '';
  if (actualParent.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, problem: { kind: 'wrong-parent', forkSlug, actualParent, expected } };
  }
  return { ok: true };
}

export interface SyncForkOutcome {
  /**
   * What GitHub did. `none` means the branch was already current — a success, and the
   * commonest one, so callers must not treat it as a failed sync.
   */
  mergeType: 'merge' | 'fast-forward' | 'none';
  /** The branch GitHub says it synced. Compared against the request as a last check. */
  baseBranch: string;
  message: string;
}

/**
 * Sync one branch of the fork from its parent.
 *
 * Failures worth distinguishing, all of which arrive as a `GitHubApiError`:
 *  - **409** — the branch has diverged in a way that conflicts. Nothing this app can do;
 *    it needs a working copy.
 *  - **422** — everything else, including a branch protection rule on the *fork's* branch,
 *    which GitHub reports without saying so.
 */
export async function syncForkBranch(
  forkOwner: string,
  forkRepoName: string,
  branch: string,
): Promise<SyncForkOutcome> {
  let result: MergeUpstreamResult;
  try {
    result = await ghWriteJson<MergeUpstreamResult>(
      'POST',
      mergeUpstreamPath(forkOwner, forkRepoName),
      { branch },
      SYNC_SUBJECT,
    );
  } catch (e) {
    if (e instanceof GitHubApiError && e.refusal === 'permission') recordWriteRefused();
    throw e;
  }

  // The parent was checked before the call; this checks that the *branch* GitHub acted on is
  // the one asked for. Cheap, and the failure it guards against is silent otherwise.
  const acted = bareBranch(result.base_branch);
  if (acted && acted !== branch) {
    throw new GitHubApiError(`GitHub synced "${acted}" rather than "${branch}".`, 200);
  }

  return {
    mergeType: result.merge_type ?? 'none',
    baseBranch: acted ?? branch,
    message: result.message,
  };
}

/**
 * The branch out of the `owner:branch` GitHub answers with.
 *
 * `base_branch` in a merge-upstream reply is **qualified** — `"DevExpress:feature/x"`, not
 * `"feature/x"`. Comparing it against the bare name we asked for therefore failed on every
 * successful sync, and the check meant to catch GitHub acting on the wrong branch instead
 * reported the right one as wrong. Worse than a harmless false alarm: the sync had already
 * happened, so the user was told it failed while their fork *had* been updated.
 *
 * Split on the first colon: neither a login nor a git branch name may contain one, so there
 * is no ambiguity about which side is which.
 */
function bareBranch(qualified: string | undefined): string | null {
  if (!qualified) return null;
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

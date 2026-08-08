/**
 * The three things the Feature branches tab does, each as one call that either finishes
 * the job or says exactly how far it got.
 *
 * These are **multi-step writes**, which is the whole reason they live here rather than in
 * a component. Shipping a branch opens a pull request, waits for GitHub to work out
 * whether it can be merged, and then either queues it or reports why it can't — and any
 * of those can fail after the earlier ones have already changed the repository. A caller
 * that only learns "it failed" cannot tell whether a pull request now exists, which is the
 * one thing it needs to know before letting someone press the button again. So every
 * outcome carries the steps that actually ran.
 *
 * The decision these functions exist to get right: **GitHub only allows auto-merge on a
 * pull request it cannot merge right now.** Arming a clean one is refused outright, and a
 * backmerge into an unprotected feature branch is clean the moment it opens — the common
 * case, not the edge case. So mergeability is established first, and it chooses between
 * two different API calls rather than being reported as a failure.
 */

import { enableAutoMerge, type MergeMethod } from './autoMerge';
import { syncForkBranch, type SyncForkOutcome } from './forkSync';
import { GitHubApiError } from './githubClient';
import {
  awaitMergeability,
  createPull,
  isNothingToMerge,
  type RestMergeMethod,
} from './pullRequests';
import type { PullRequest } from './types';
import { mergeVerdict } from '../lib/featureBranch';

/** One thing that happened, in the order it happened. */
export interface ActionStep {
  label: string;
  state: 'done' | 'skipped' | 'failed';
  detail?: string;
}

export interface ActionOutcome {
  ok: boolean;
  steps: ActionStep[];
  /** The pull request, when one was opened or adopted — even if a later step failed. */
  pr?: PullRequest;
  /** One sentence for the dialog to lead with. */
  message: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface SyncParams {
  owner: string;
  repo: string;
  /** The feature branch, which is the pull request's **base**. */
  branch: string;
  defaultBranch: string;
}

/**
 * Bring the default branch into a feature branch.
 *
 * Fixed at `merge`, not the configured strategy. Squashing the default branch into a
 * feature branch would replace hundreds of shared commits with one that exists nowhere
 * else, and every later merge between the two would then conflict against history they no
 * longer agree on. That is not a preference worth exposing.
 */
export async function syncIntoFeatureBranch(params: SyncParams): Promise<ActionOutcome> {
  const { owner, repo, branch, defaultBranch } = params;
  const steps: ActionStep[] = [];

  let pr: PullRequest;
  try {
    const created = await createPull(owner, repo, {
      head: defaultBranch,
      base: branch,
      title: `Merge ${defaultBranch} into ${branch}`,
      body: '',
    });
    pr = created.pr;
    steps.push({
      label: created.existing ? 'Found the open pull request' : 'Opened a pull request',
      state: 'done',
      detail: `#${created.pr.number}`,
    });
  } catch (e) {
    if (isNothingToMerge(e)) {
      // Not a failure: the branch already has everything the default branch does, which
      // is the state this action exists to reach.
      return {
        ok: true,
        steps: [{ label: 'Nothing to merge', state: 'skipped', detail: 'already up to date' }],
        message: `${branch} already has everything in ${defaultBranch}.`,
      };
    }
    return {
      ok: false,
      steps: [{ label: 'Open a pull request', state: 'failed', detail: errorText(e) }],
      message: `Could not open the pull request: ${errorText(e)}`,
    };
  }

  return finishMerge({ owner, repo, pr, steps, method: 'merge' });
}

export interface ProposeParams {
  /** The upstream, which owns the feature branch and receives the pull request. */
  owner: string;
  repo: string;
  /** The login whose fork holds the work being offered. */
  forkOwner: string;
  /** The shared branch. It is the head *and* the base — in different repositories. */
  branch: string;
  title: string;
  body: string;
  /** The configured strategy. */
  method: RestMergeMethod;
}

/**
 * Offer the fork's work on a feature branch back to the upstream's copy of it.
 *
 * A **cross-fork** pull request, and the only one in this app: head is `{forkOwner}:branch`
 * and base is the same `branch` in the upstream. The branch name is identical on both sides,
 * which is the whole point — this is the third leg of a loop whose other two keep the two
 * copies of one branch in step. Nothing here targets the default branch; getting the feature
 * branch into `main` is somebody else's decision.
 *
 * **Never merges on its own.** The backmerge from the default branch completes a mechanical
 * operation the user asked for; this one puts code into a branch a team shares, so if GitHub
 * won't queue it because it is already mergeable, that is reported and the merge waits for a
 * second, deliberate click.
 */
export async function proposeToFeatureBranch(params: ProposeParams): Promise<ActionOutcome> {
  const { owner, repo, forkOwner, branch, title, body, method } = params;
  const steps: ActionStep[] = [];

  let pr: PullRequest;
  try {
    const created = await createPull(owner, repo, {
      headOwner: forkOwner,
      head: branch,
      base: branch,
      title,
      body,
    });
    pr = created.pr;
    steps.push({
      label: created.existing ? 'Found the open pull request' : 'Opened a pull request',
      state: 'done',
      detail: created.existing
        ? `#${created.pr.number} — its title and description were left as they are`
        : `#${created.pr.number}`,
    });
  } catch (e) {
    if (isNothingToMerge(e)) {
      return {
        ok: true,
        steps: [{ label: 'Nothing to commit', state: 'skipped', detail: 'already up to date' }],
        message: `The upstream's ${branch} already has everything on your copy of it.`,
      };
    }
    return {
      ok: false,
      steps: [{ label: 'Open a pull request', state: 'failed', detail: errorText(e) }],
      message: `Could not open the pull request: ${errorText(e)}`,
    };
  }

  return finishMerge({ owner, repo, pr, steps, method });
}

/**
 * The half both actions share: wait for mergeability, then arm auto-merge.
 *
 * **Arming is the only way anything lands.** Landing directly in a feature branch is
 * forbidden by the repository, so this app never merges: it opens the pull request and hands
 * it to GitHub. Which means the whole clean-versus-blocked branch that used to live here is
 * gone, and so is the "Merge now" it existed to offer — on a protected branch a pull request
 * is never mergeable-right-now, so those states were unreachable, and the code that served
 * them only made it harder to see what actually happens.
 *
 * The one case worth keeping is the refusal it produces when the branch turns out *not* to be
 * protected: GitHub declines to queue a pull request it could merge already, and the honest
 * answer is to say so rather than to merge on the user's behalf.
 */
async function finishMerge({
  owner,
  repo,
  pr,
  steps,
  method,
}: {
  owner: string;
  repo: string;
  pr: PullRequest;
  steps: ActionStep[];
  method: RestMergeMethod;
}): Promise<ActionOutcome> {
  let detailed: PullRequest;
  try {
    detailed = await awaitMergeability(owner, repo, pr.number);
    steps.push({
      label: 'Checked whether GitHub can merge it',
      state: 'done',
      detail: mergeVerdict(detailed).text,
    });
  } catch (e) {
    return {
      ok: false,
      pr,
      steps: [...steps, { label: 'Check mergeability', state: 'failed', detail: errorText(e) }],
      message: `The pull request is open, but its state could not be read: ${errorText(e)}`,
    };
  }

  if (detailed.auto_merge) {
    return {
      ok: true,
      pr: detailed,
      steps: [...steps, { label: 'Auto-merge was already enabled', state: 'skipped' }],
      message: `#${detailed.number} already has auto-merge enabled.`,
    };
  }

  if (detailed.mergeable === false) {
    const verdict = mergeVerdict(detailed);
    return {
      ok: false,
      pr: detailed,
      steps: [...steps, { label: 'Enable auto-merge', state: 'failed', detail: verdict.text }],
      message: `#${detailed.number} is open, but GitHub can't merge it: ${verdict.text.toLowerCase()}.`,
    };
  }

  try {
    await enableAutoMerge(detailed, method.toUpperCase() as MergeMethod);
    return {
      ok: true,
      pr: detailed,
      steps: [...steps, { label: 'Enabled auto-merge', state: 'done', detail: method }],
      message: `#${detailed.number} will merge when its checks pass.`,
    };
  } catch (e) {
    return {
      ok: false,
      pr: detailed,
      steps: [...steps, { label: 'Enable auto-merge', state: 'failed', detail: errorText(e) }],
      message: `#${detailed.number} is open, but auto-merge could not be enabled: ${errorText(e)}`,
    };
  }
}

/**
 * Queue a pull request that is already open — no text written, nothing created.
 *
 * The counterpart to {@link proposeToFeatureBranch} for a branch whose pull request exists
 * already. Kept separate rather than folded in, because "open one and describe it" and
 * "queue the one that is there" are different operations with different consequences: this
 * one deliberately does **not** touch the title or description, since replacing text
 * someone may have edited by hand is not something to do as a side effect of arming.
 */
export async function armExistingPull(
  owner: string,
  repo: string,
  pr: PullRequest,
  method: RestMergeMethod,
): Promise<ActionOutcome> {
  return finishMerge({ owner, repo, pr, steps: [], method });
}

/**
 * Pull the upstream's copy of a branch down into the fork's.
 *
 * A write into the user's own repository that this app cannot undo: a branch that has
 * diverged is merged rather than refused, leaving a merge commit behind. The dialog says
 * so; this reports which of the three things GitHub did.
 */
export async function pullIntoFork(
  forkOwner: string,
  forkRepoName: string,
  branch: string,
): Promise<ActionOutcome & { sync?: SyncForkOutcome }> {
  try {
    const result = await syncForkBranch(forkOwner, forkRepoName, branch);
    const detail =
      result.mergeType === 'none'
        ? 'already up to date'
        : result.mergeType === 'fast-forward'
          ? 'fast-forwarded'
          : 'merged, leaving a merge commit';
    return {
      ok: true,
      sync: result,
      steps: [{ label: `Synced ${branch}`, state: 'done', detail }],
      message:
        result.mergeType === 'none'
          ? `Your ${branch} was already level with the upstream.`
          : `Your ${branch} now matches the upstream (${detail}).`,
    };
  } catch (e) {
    const conflict = e instanceof GitHubApiError && e.status === 409;
    return {
      ok: false,
      steps: [{ label: `Sync ${branch}`, state: 'failed', detail: errorText(e) }],
      message: conflict
        ? `${branch} has conflicting changes in your fork, so GitHub can't sync it. This one needs a working copy.`
        : `Could not sync ${branch}: ${errorText(e)}`,
    };
  }
}

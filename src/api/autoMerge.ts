/**
 * Arming auto-merge on a pull request — the app's second write, after re-running jobs.
 *
 * Two calls, because GitHub splits them:
 *  - clearing the description is REST (`PATCH .../pulls/{n}` with an empty `body`);
 *  - enabling auto-merge has **no REST equivalent** at all. `enablePullRequestAutoMerge`
 *    is a GraphQL mutation, which is why this is the one place the app speaks GraphQL.
 *
 * GraphQL also fails differently: a rejected mutation arrives as HTTP 200 with an `errors`
 * array, so status alone proves nothing and the body has to be inspected. That is what
 * `ghWriteJson` exists for.
 *
 * The "GitHub says this token can't write after all" latch is applied here as it is in
 * workflows.ts, so a refusal retires the feature from the UI rather than leaving a button
 * that 403s.
 */

import { GRAPHQL_PATH, pullPath } from './endpoints';
import { ghWriteJson, GitHubApiError } from './githubClient';
import { recordWriteRefused } from './tokenCapability';
import type { PullRequest } from './types';

/** GitHub's three merge strategies, as the GraphQL enum spells them. */
export type MergeMethod = 'SQUASH' | 'MERGE' | 'REBASE';

interface GraphQlResponse<T> {
  data?: T | null;
  errors?: { message?: string; type?: string }[];
}

const ENABLE_AUTO_MERGE = `
mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
    pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
  }
}`;

interface EnableAutoMergeData {
  enablePullRequestAutoMerge?: {
    pullRequest?: { number?: number; autoMergeRequest?: { mergeMethod?: string } | null } | null;
  } | null;
}

/**
 * Turn a GraphQL error array into one message worth showing.
 *
 * Exported for its tests, and because the failures here are the *interesting* part of this
 * feature: auto-merge is refused for a whole family of ordinary reasons — the repository
 * has the feature switched off, the branch has no required checks, the PR is already
 * mergeable, the chosen method is disallowed — and a bare "GraphQL error" would send
 * someone to the wrong place every time.
 */
export function graphQlErrorMessage(errors: { message?: string; type?: string }[]): string {
  const messages = errors.map((e) => e.message).filter((m): m is string => Boolean(m));
  if (messages.length === 0) return 'GitHub refused the request but gave no reason.';
  return messages.join('; ');
}

/**
 * Ask GitHub to merge this PR as soon as its required checks pass.
 *
 * Not idempotent in GitHub's eyes: enabling it on a PR that already has it answers with an
 * error, so callers should not offer this for a PR whose `auto_merge` is already set.
 */
export async function enableAutoMerge(pr: PullRequest, mergeMethod: MergeMethod): Promise<void> {
  let body: GraphQlResponse<EnableAutoMergeData>;
  try {
    body = await ghWriteJson<GraphQlResponse<EnableAutoMergeData>>('POST', GRAPHQL_PATH, {
      query: ENABLE_AUTO_MERGE,
      variables: { pullRequestId: pr.node_id, mergeMethod },
    });
  } catch (e) {
    if (e instanceof GitHubApiError && e.refusal === 'permission') recordWriteRefused();
    throw e;
  }

  if (body.errors?.length) {
    // 200 with errors — a real refusal, and the only place it is visible.
    throw new GitHubApiError(graphQlErrorMessage(body.errors), 200, false, 'forbidden');
  }
  // A mutation that returns neither errors nor the enabled request did not do the job;
  // reporting success here would leave the UI claiming something that never happened.
  if (!body.data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest) {
    throw new GitHubApiError('GitHub did not confirm auto-merge was enabled.', 200);
  }
}

/**
 * Empty the PR description.
 *
 * Irreversible as far as this app and the GitHub API are concerned: a PR body has no
 * exposed edit history, so nothing here can put it back. Callers must confirm first.
 */
export async function clearPrDescription(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  try {
    await ghWriteJson<unknown>('PATCH', pullPath(owner, repo, prNumber), { body: '' });
  } catch (e) {
    if (e instanceof GitHubApiError && e.refusal === 'permission') recordWriteRefused();
    throw e;
  }
}

export interface ArmAutoMergeResult {
  descriptionCleared: boolean;
  autoMergeEnabled: boolean;
  /** What went wrong, when something did. */
  error?: string;
}

/**
 * Clear the description, then arm auto-merge.
 *
 * **That order is deliberate.** Auto-merge is not "merge later" — a PR whose checks are
 * already green merges within seconds of arming it. Clearing afterwards would therefore
 * race the merge and lose, which for the case this exists to serve (keeping the
 * description out of what gets merged) means failing exactly when it matters.
 *
 * The cost of that choice is stated plainly rather than hidden: if arming then fails, the
 * description is already gone, and the result says so. It is not put back — a "restore"
 * that silently re-published a description the user had just asked to remove would be a
 * worse surprise than the one it prevents.
 */
export async function armAutoMerge(
  owner: string,
  repo: string,
  pr: PullRequest,
  mergeMethod: MergeMethod,
): Promise<ArmAutoMergeResult> {
  try {
    await clearPrDescription(owner, repo, pr.number);
  } catch (e) {
    return {
      descriptionCleared: false,
      autoMergeEnabled: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    await enableAutoMerge(pr, mergeMethod);
  } catch (e) {
    return {
      descriptionCleared: true,
      autoMergeEnabled: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  return { descriptionCleared: true, autoMergeEnabled: true };
}

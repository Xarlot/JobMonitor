/**
 * "Update branch" on a pull request — bring the base branch's new commits into the PR head,
 * as GitHub's own button does.
 *
 * GraphQL rather than REST: `PUT .../pulls/{n}/update-branch` only merges, while
 * `updatePullRequestBranch` offers the rebase GitHub's button also has. Both go through the
 * capability-gated write path, and a rejected mutation arrives as HTTP 200 with an `errors`
 * array, exactly as arming auto-merge does.
 *
 * `expectedHeadOid` pins the update to the commit the dialog showed: if someone pushed in the
 * meantime GitHub refuses rather than updating a head nobody looked at.
 */

import { GRAPHQL_PATH } from './endpoints';
import { ghWriteJson, GitHubApiError, type WriteSubject } from './githubClient';
import { graphQlErrorMessage } from './autoMerge';
import { recordWriteRefused } from './tokenCapability';
import type { PullRequest } from './types';

/** The two ways GitHub can update a PR branch, as the GraphQL enum spells them. */
export type UpdateBranchMethod = 'MERGE' | 'REBASE';

const UPDATE_BRANCH_SUBJECT: WriteSubject = {
  action: "update this pull request's branch",
  noun: 'Pull request',
};

const UPDATE_PULL_REQUEST_BRANCH = `
mutation UpdatePullRequestBranch($pullRequestId: ID!, $expectedHeadOid: GitObjectID, $updateMethod: PullRequestBranchUpdateMethod) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, updateMethod: $updateMethod }) {
    pullRequest { number headRefOid }
  }
}`;

interface UpdateBranchData {
  updatePullRequestBranch?: {
    pullRequest?: { number?: number; headRefOid?: string } | null;
  } | null;
}

interface GraphQlResponse<T> {
  data?: T | null;
  errors?: { message?: string; type?: string }[];
}

/** Update the PR's head with its base. Resolves to the new head SHA. */
export async function updatePullRequestBranch(
  pr: PullRequest,
  method: UpdateBranchMethod,
): Promise<string> {
  let body: GraphQlResponse<UpdateBranchData>;
  try {
    body = await ghWriteJson<GraphQlResponse<UpdateBranchData>>(
      'POST',
      GRAPHQL_PATH,
      {
        query: UPDATE_PULL_REQUEST_BRANCH,
        variables: { pullRequestId: pr.node_id, expectedHeadOid: pr.head.sha, updateMethod: method },
      },
      UPDATE_BRANCH_SUBJECT,
    );
  } catch (e) {
    if (e instanceof GitHubApiError && e.refusal === 'permission') recordWriteRefused();
    throw e;
  }

  if (body.errors?.length) {
    throw new GitHubApiError(graphQlErrorMessage(body.errors), 200, false, 'forbidden');
  }
  const head = body.data?.updatePullRequestBranch?.pullRequest?.headRefOid;
  if (!head) throw new GitHubApiError('GitHub did not confirm the branch was updated.', 200);
  return head;
}

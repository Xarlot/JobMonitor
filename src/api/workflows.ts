/** The repo's workflow list — the input for regex (pattern) flows. */

import { workflowsPath } from './endpoints';
import { ghGet } from './githubClient';
import type { Workflow, WorkflowsResponse } from './types';

/**
 * ETag-cached by githubClient, so re-polling a repo's list is a cheap 304.
 * One page (GitHub's max, 100 workflows) — same limit as workflow-name resolution.
 */
export async function fetchWorkflows(owner: string, repo: string): Promise<Workflow[]> {
  const { data } = await ghGet<WorkflowsResponse>(workflowsPath(owner, repo));
  return data.workflows;
}

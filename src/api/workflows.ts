/** The repo's workflow list, its push permission, and the one write: re-running jobs. */

import { repoPath, repoRunsPath, rerunFailedJobsPath, workflowsPath } from './endpoints';
import { ghGet, ghPost, GitHubApiError } from './githubClient';
import { recordPushAccess, recordWriteRefused } from './tokenCapability';
import { Operation, Telemetry } from '../lib/telemetry';
import type {
  Repository,
  Workflow,
  WorkflowRun,
  WorkflowRunsResponse,
  WorkflowsResponse,
} from './types';

/** GitHub's page size cap for the workflows list. */
const WORKFLOWS_PER_PAGE = 100;
/** Safety cap: ~2000 workflows, well past any real repository. */
const MAX_WORKFLOW_PAGES = 20;

/**
 * ALL workflows of a repo, following pagination — a monorepo can easily hold more
 * than one page of them, and a single page silently truncated everything built on
 * this list: regex (pattern) flows only ever saw the first 100 workflows, so a
 * matching workflow further down the list produced no card at all, and resolving a
 * flow's workflow *name* to its id failed with "not found" for the same reason.
 *
 * Each page is ETag-cached by githubClient, so re-polling a repo costs one cheap
 * 304 per page. Pages are merged by workflow id: a workflow added between two page
 * requests shifts the window and can otherwise repeat an entry, which downstream
 * would become two derived flows with the same id.
 */
export async function fetchWorkflows(owner: string, repo: string): Promise<Workflow[]> {
  return Telemetry.measure(Operation.GH_WORKFLOW_LIST, () => fetchWorkflows__impl(owner, repo));
}

async function fetchWorkflows__impl(owner: string, repo: string): Promise<Workflow[]> {
  const byId = new Map<number, Workflow>();
  for (let page = 1; page <= MAX_WORKFLOW_PAGES; page++) {
    const { data } = await ghGet<WorkflowsResponse>(workflowsPath(owner, repo, page));
    const batch = data.workflows ?? [];
    if (batch.length === 0) break;
    for (const w of batch) byId.set(w.id, w);
    // A short page is the last one; total_count stops us when it is exact.
    if (batch.length < WORKFLOWS_PER_PAGE || byId.size >= data.total_count) break;
  }
  return [...byId.values()];
}

/**
 * Read the repo to learn whether the authenticated account has the Write role,
 * and feed that into the token-capability store. Re-running workflows needs Write
 * on top of the token's own scope, so a `repo`-scoped token belonging to a
 * read-only collaborator must not unlock the re-run controls.
 *
 * ETag-cached like every other read, so re-probing is a cheap 304. Failures are
 * swallowed: an unreadable repo simply leaves capability unproven (and therefore
 * off), which is the safe direction.
 */
export async function probePushAccess(owner: string, repo: string): Promise<void> {
  try {
    const { data } = await ghGet<Repository>(repoPath(owner, repo));
    recordPushAccess(data.permissions?.push === true);
  } catch {
    recordPushAccess(false);
  }
}

/** Runs to look at for one commit. A commit rarely triggers more than a handful. */
const RUNS_PER_COMMIT = 50;

/**
 * Every workflow run for one commit — how a pull request is mapped to the runs it
 * triggered, complete with each one's workflow file, attempt and conclusion.
 */
export async function fetchRunsForHead(
  owner: string,
  repo: string,
  headSha: string,
): Promise<WorkflowRun[]> {
  const { data } = await ghGet<WorkflowRunsResponse>(
    repoRunsPath(owner, repo, { headSha, perPage: RUNS_PER_COMMIT }),
  );
  return data.workflow_runs;
}

/**
 * Ask GitHub to re-run a run's failed jobs — the app's only write.
 *
 * The "GitHub says this token can't write after all" latch lives here rather than
 * in each caller: it is a security-relevant policy, and a future third caller
 * would otherwise have to remember it from scratch.
 */
export async function rerunFailedJobs(
  owner: string,
  repo: string,
  runId: number,
): Promise<void> {
  try {
    await ghPost(rerunFailedJobsPath(owner, repo, runId));
  } catch (e) {
    if (e instanceof GitHubApiError && e.refusal === 'permission') recordWriteRefused();
    throw e;
  }
}

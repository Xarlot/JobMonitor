/**
 * Opening and inspecting pull requests — the writes behind the feature-branch tab.
 *
 * **There is no merge here.** Landing directly in a feature branch is forbidden by the
 * repository, so the tab opens a pull request and arms auto-merge; GitHub does the merging
 * when the required checks say so. Nothing in this module can merge one, which is the point.
 *
 * Two GitHub behaviours shape what is left:
 *
 *  - **`mergeable` is computed asynchronously.** The single-PR endpoint answers `null`
 *    until a background job finishes, so anything that acts on mergeability has to wait
 *    for it rather than read it once — hence `awaitMergeability`.
 *  - **A head in a fork is spelled two different ways.** The list filter always wants
 *    `owner:branch`; create wants it only when the head really is in another repository.
 *    See {@link PullRef}.
 */

import {
  createPullPath,
  pullPath,
  pullsPath,
} from './endpoints';
import { ghGet, ghWriteJson, GitHubApiError, type WriteSubject } from './githubClient';
import { recordWriteRefused } from './tokenCapability';
import type { PullRequest } from './types';

const OPEN_SUBJECT: WriteSubject = { action: 'open a pull request', noun: 'Branch' };

/** The permission latch, applied identically wherever this app writes. */
function latch(e: unknown): void {
  if (e instanceof GitHubApiError && e.refusal === 'permission') recordWriteRefused();
}

/**
 * Where a pull request's head branch lives.
 *
 * `headOwner` is what makes a cross-fork pull request possible, and it is a separate field
 * rather than something baked into `head` because the two GitHub fields want it differently:
 * the **list** filter takes `owner:branch`, while **create** takes `owner:branch` only when
 * the head is in another repository and a bare branch name when it is in this one. Passing
 * one string for both got that wrong in one direction or the other.
 */
export interface PullRef {
  /** Login owning the head repository. Omit when the head is in `owner` itself. */
  headOwner?: string;
  head: string;
  base: string;
}

/** How `head` is spelled for the list filter, which always wants it qualified. */
function headFilterValue(owner: string, ref: PullRef): string {
  return `${ref.headOwner ?? owner}:${ref.head}`;
}

/**
 * The open PR for exactly this head→base pair, if one is already there.
 *
 * Called before creating, because a second attempt at the same action is the normal case —
 * someone clicks again while the first PR is still waiting on checks. GitHub would answer
 * 422 rather than opening a duplicate; adopting the existing PR is both cheaper and what
 * the user meant.
 */
export async function findOpenPull(
  owner: string,
  repo: string,
  ref: PullRef,
): Promise<PullRequest | null> {
  const { data } = await ghGet<PullRequest[]>(
    pullsPath(owner, repo, { head: headFilterValue(owner, ref), base: ref.base }),
  );
  const headOwner = (ref.headOwner ?? owner).toLowerCase();
  return (
    data.find(
      (pr) =>
        pr.head.ref === ref.head &&
        pr.base.ref === ref.base &&
        // The filter is server-side, but a same-named branch in another fork would match
        // it too, and adopting *that* would attach this action to someone else's work.
        (pr.head.user?.login ?? '').toLowerCase() === headOwner,
    ) ?? null
  );
}

export interface CreatePullResult {
  pr: PullRequest;
  /** True when an open PR was already there and this call adopted it. */
  existing: boolean;
}

/**
 * Open a pull request, or adopt the one that is already open for this pair.
 *
 * The pre-check races — two clicks, or a colleague opening the same PR in between — so the
 * 422 is caught as well and resolved by looking again. GitHub phrases it as "A pull
 * request already exists for owner:branch."
 *
 * `No commits between X and Y` is *not* handled here: it means there is nothing to merge,
 * which is a legitimate outcome the caller has to report as "already up to date" rather
 * than as a failure, and it is only distinguishable by message.
 */
export async function createPull(
  owner: string,
  repo: string,
  params: PullRef & { title: string; body: string },
): Promise<CreatePullResult> {
  const existing = await findOpenPull(owner, repo, params);
  if (existing) return { pr: existing, existing: true };

  // Qualified only when the head really is elsewhere: `owner:branch` naming *this*
  // repository is accepted, but a bare name is what GitHub's own examples use and what the
  // same-repo callers have always sent.
  const head =
    params.headOwner && params.headOwner.toLowerCase() !== owner.toLowerCase()
      ? `${params.headOwner}:${params.head}`
      : params.head;

  try {
    const pr = await ghWriteJson<PullRequest>(
      'POST',
      createPullPath(owner, repo),
      { head, base: params.base, title: params.title, body: params.body },
      OPEN_SUBJECT,
    );
    return { pr, existing: false };
  } catch (e) {
    latch(e);
    if (e instanceof GitHubApiError && /already exists/i.test(e.message)) {
      const found = await findOpenPull(owner, repo, params);
      if (found) return { pr: found, existing: true };
    }
    throw e;
  }
}

/** True for the 422 that means "these two branches are identical" — a success, not a fault. */
export function isNothingToMerge(e: unknown): boolean {
  return e instanceof GitHubApiError && /no commits between/i.test(e.message);
}

/** One pull request with its mergeability — the fields the list endpoint omits. */
export async function fetchPullDetail(
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  const { data } = await ghGet<PullRequest>(pullPath(owner, repo, number));
  return data;
}

/** How long to wait for GitHub to work out mergeability before giving up on knowing. */
const MERGEABILITY_TRIES = 5;
const MERGEABILITY_DELAY_MS = 1200;

/**
 * Poll a PR until GitHub has decided whether it is mergeable.
 *
 * A freshly created PR answers `mergeable: null` while a background job computes it, and
 * the decision this feature makes — arm auto-merge, or report why it cannot be — turns on
 * the answer. Reading it once would decide from a coin toss.
 *
 * Bounded, and returns the last PR it saw either way: a PR whose mergeability is still
 * unknown after several seconds is reported as unknown, which the UI can say plainly.
 * Blocking longer would trade a legible "GitHub is still thinking" for a spinner that
 * never ends.
 */
export async function awaitMergeability(
  owner: string,
  repo: string,
  number: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<PullRequest> {
  let latest = await fetchPullDetail(owner, repo, number);
  for (let i = 1; i < MERGEABILITY_TRIES && latest.mergeable == null; i++) {
    await sleep(MERGEABILITY_DELAY_MS);
    latest = await fetchPullDetail(owner, repo, number);
  }
  return latest;
}

export type RestMergeMethod = 'merge' | 'squash' | 'rebase';


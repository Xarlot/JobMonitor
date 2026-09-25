/**
 * Who reviews a pull request, and where each of them stands — the reviewers box on GitHub's
 * own PR page, folded into one list.
 *
 * Two sources, because GitHub splits the answer:
 *
 *  - **`requested_reviewers` / `requested_teams`** on the PR say who is *still owed* a review.
 *    A reviewer leaves that list the moment they submit one and comes back on a re-request.
 *  - **The reviews endpoint** says what everyone who did review said.
 *
 * Per person, the verdict is their latest review that *decided* something. A comment after an
 * approval does not withdraw it — GitHub shows that reviewer as approved, and so does this.
 * A re-requested reviewer is shown as awaiting, whatever they said before: the author asked
 * them to look again, which is the point that needs attention.
 */

import type { GitHubTeam, GitHubUser, PullRequest, PullReview } from '../api/types';

export type ReviewerState =
  | 'changes_requested'
  | 'requested'
  | 'approved'
  | 'commented'
  | 'dismissed';

export interface Reviewer {
  /** Lower-cased login for a person, `team:<slug>` for a team. Unique within one PR. */
  key: string;
  name: string;
  avatarUrl: string | null;
  htmlUrl: string;
  isTeam: boolean;
  state: ReviewerState;
}

/** Most pressing first: what blocks the merge, then what is still owed, then what is done. */
const ORDER: Record<ReviewerState, number> = {
  changes_requested: 0,
  requested: 1,
  approved: 2,
  commented: 3,
  dismissed: 4,
};

function person(u: GitHubUser, state: ReviewerState): Reviewer {
  return {
    key: u.login.toLowerCase(),
    name: u.login,
    avatarUrl: u.avatar_url,
    htmlUrl: u.html_url,
    isTeam: false,
    state,
  };
}

function team(t: GitHubTeam): Reviewer {
  return {
    key: `team:${t.slug.toLowerCase()}`,
    name: t.name || t.slug,
    avatarUrl: null,
    htmlUrl: t.html_url,
    isTeam: true,
    state: 'requested',
  };
}

export function summarizeReviewers(
  pr: Pick<PullRequest, 'user' | 'requested_reviewers' | 'requested_teams'>,
  reviews: readonly PullReview[] | null | undefined,
): Reviewer[] {
  const author = (pr.user?.login ?? '').toLowerCase();
  const byKey = new Map<string, Reviewer>();

  // Oldest first, as the endpoint answers — so a later review simply overwrites.
  for (const r of reviews ?? []) {
    if (!r.user || r.state === 'PENDING') continue;
    const key = r.user.login.toLowerCase();
    // The author replying in a review thread is not a reviewer; GitHub leaves them out too.
    if (key === author) continue;
    const prev = byKey.get(key);
    if (r.state === 'COMMENTED') {
      if (!prev) byKey.set(key, person(r.user, 'commented'));
      continue;
    }
    const state =
      r.state === 'APPROVED'
        ? 'approved'
        : r.state === 'CHANGES_REQUESTED'
          ? 'changes_requested'
          : 'dismissed';
    byKey.set(key, person(r.user, state));
  }

  for (const u of pr.requested_reviewers ?? []) {
    byKey.set(u.login.toLowerCase(), person(u, 'requested'));
  }
  for (const t of pr.requested_teams ?? []) {
    const r = team(t);
    byKey.set(r.key, r);
  }

  // Map iteration keeps first-seen order, and sort is stable — so within one state the
  // reviewers stay in the order they first turned up.
  return [...byKey.values()].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
}

export const REVIEWER_STATE_LABEL: Record<ReviewerState, string> = {
  changes_requested: 'requested changes',
  requested: 'review requested',
  approved: 'approved',
  commented: 'commented',
  dismissed: 'review dismissed',
};

/**
 * Reviews in `next` that were not in `prev` — what arrived since the last read.
 *
 * `prev` undefined means this PR has never been read, and nothing counts as new: that read is
 * the baseline, and without it every existing review would announce itself at startup. The
 * author's own reviews are left out for the same reason they are left out of the reviewer list,
 * and so are unsubmitted ones.
 */
export function newReviews(
  prev: readonly PullReview[] | undefined,
  next: readonly PullReview[],
  authorLogin: string | null | undefined,
): PullReview[] {
  if (!prev) return [];
  const seen = new Set(prev.map((r) => r.id));
  const author = (authorLogin ?? '').toLowerCase();
  return next.filter(
    (r) =>
      !seen.has(r.id) &&
      r.state !== 'PENDING' &&
      r.user != null &&
      r.user.login.toLowerCase() !== author,
  );
}

const REVIEW_VERB: Record<PullReview['state'], string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes on',
  COMMENTED: 'reviewed',
  DISMISSED: 'reviewed',
  PENDING: 'reviewed',
};

/**
 * One notification for a PR's new reviews. Several at once — a busy poll interval, or the app
 * waking from sleep — collapse into one: the most pressing verdict leads, the rest are counted.
 */
export function reviewNotification(
  pr: Pick<PullRequest, 'number' | 'title' | 'html_url'>,
  reviews: readonly PullReview[],
): { title: string; body: string; tag: string; url: string } | null {
  if (reviews.length === 0) return null;
  const rank = (r: PullReview) =>
    r.state === 'CHANGES_REQUESTED' ? 0 : r.state === 'APPROVED' ? 1 : 2;
  // Latest first, then stable-sorted by rank: the newest of the most pressing verdict leads.
  const lead = [...reviews].reverse().sort((a, b) => rank(a) - rank(b))[0];
  const others = reviews.length - 1;
  return {
    title: `${lead.user?.login ?? 'Someone'} ${REVIEW_VERB[lead.state]} #${pr.number}`,
    body: others > 0 ? `${pr.title} · +${others} more review${others > 1 ? 's' : ''}` : pr.title,
    tag: `pr-review-${pr.number}-${lead.id}`,
    url: lead.html_url || pr.html_url,
  };
}

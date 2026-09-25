import { describe, expect, it } from 'vitest';
import type { GitHubUser, PullReview } from '../api/types';
import { newReviews, reviewNotification, summarizeReviewers } from '../lib/reviewers';

function user(login: string): GitHubUser {
  return { login, avatar_url: `https://a/${login}`, html_url: `https://github.com/${login}` };
}

let id = 0;
function review(login: string, state: PullReview['state']): PullReview {
  return { id: ++id, user: user(login), state, html_url: '' };
}

const author = user('author');

function states(...args: Parameters<typeof summarizeReviewers>): string[] {
  return summarizeReviewers(...args).map((r) => `${r.name}:${r.state}`);
}

describe('summarizeReviewers', () => {
  it('shows nothing for a PR nobody was asked to review', () => {
    expect(summarizeReviewers({ user: author }, [])).toEqual([]);
    expect(summarizeReviewers({ user: author }, undefined)).toEqual([]);
  });

  it('lists requested reviewers before their reviews have been read', () => {
    expect(
      states({ user: author, requested_reviewers: [user('ann')] }, undefined),
    ).toEqual(['ann:requested']);
  });

  it('keeps an approval through a later comment', () => {
    expect(
      states({ user: author }, [review('ann', 'APPROVED'), review('ann', 'COMMENTED')]),
    ).toEqual(['ann:approved']);
  });

  it('lets a later decision replace an earlier one', () => {
    expect(
      states({ user: author }, [review('ann', 'CHANGES_REQUESTED'), review('ann', 'APPROVED')]),
    ).toEqual(['ann:approved']);
  });

  it('shows a re-requested reviewer as awaiting, whatever they said before', () => {
    expect(
      states({ user: author, requested_reviewers: [user('Ann')] }, [review('ann', 'APPROVED')]),
    ).toEqual(['Ann:requested']);
  });

  it('leaves out the author and unsubmitted reviews', () => {
    expect(
      states({ user: author }, [review('author', 'COMMENTED'), review('bob', 'PENDING')]),
    ).toEqual([]);
  });

  it('includes requested teams', () => {
    const [t] = summarizeReviewers(
      { user: author, requested_teams: [{ slug: 'core', name: 'Core', html_url: 'u' }] },
      [],
    );
    expect(t).toMatchObject({ name: 'Core', isTeam: true, state: 'requested', avatarUrl: null });
  });

  it('puts what blocks the merge first', () => {
    expect(
      states({ user: author, requested_reviewers: [user('dan')] }, [
        review('ann', 'COMMENTED'),
        review('bob', 'APPROVED'),
        review('cat', 'CHANGES_REQUESTED'),
      ]),
    ).toEqual(['cat:changes_requested', 'dan:requested', 'bob:approved', 'ann:commented']);
  });
});

describe('newReviews', () => {
  it('treats the first read of a PR as the baseline', () => {
    expect(newReviews(undefined, [review('ann', 'APPROVED')], 'author')).toEqual([]);
  });

  it('returns only reviews not seen before', () => {
    const old = review('ann', 'COMMENTED');
    const fresh = review('bob', 'APPROVED');
    expect(newReviews([old], [old, fresh], 'author')).toEqual([fresh]);
  });

  it("ignores the author's own reviews and unsubmitted ones", () => {
    expect(
      newReviews([], [review('Author', 'COMMENTED'), review('bob', 'PENDING')], 'author'),
    ).toEqual([]);
  });
});

describe('reviewNotification', () => {
  const pr = { number: 7, title: 'Fix it', html_url: 'https://github.com/o/r/pull/7' };

  it('sends nothing when nothing is new', () => {
    expect(reviewNotification(pr, [])).toBeNull();
  });

  it('names the reviewer and the verdict', () => {
    const r = { ...review('ann', 'APPROVED'), html_url: 'https://github.com/o/r/pull/7#r' };
    expect(reviewNotification(pr, [r])).toEqual({
      title: 'ann approved #7',
      body: 'Fix it',
      tag: `pr-review-7-${r.id}`,
      url: 'https://github.com/o/r/pull/7#r',
    });
  });

  it('collapses several reviews into one, led by the most pressing', () => {
    const note = reviewNotification(pr, [
      review('ann', 'APPROVED'),
      review('bob', 'CHANGES_REQUESTED'),
      review('cat', 'COMMENTED'),
    ]);
    expect(note?.title).toBe('bob requested changes on #7');
    expect(note?.body).toBe('Fix it · +2 more reviews');
    // No review link on the fixture, so the PR itself is opened.
    expect(note?.url).toBe(pr.html_url);
  });
});

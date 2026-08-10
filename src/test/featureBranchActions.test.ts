/**
 * What these actions may and may not do.
 *
 * **They open a pull request and enable auto-merge. They never merge.** Landing directly in a
 * feature branch is forbidden by the repository, so merging here would be a route around the
 * branch protection that forbids it — `mergePull` is asserted unused throughout, and the
 * module no longer imports it.
 *
 * Also covered: the description written for an offer must survive. `armAutoMerge`
 * clears a PR body before arming, deliberately and irreversibly, so this path has to use
 * `enableAutoMerge` directly — a regression there would silently delete the text a moment
 * after writing it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enableAutoMerge = vi.fn();
const clearPrDescription = vi.fn();
const createPull = vi.fn();
const awaitMergeability = vi.fn();
const mergePull = vi.fn();
const syncForkBranch = vi.fn();
const ghGet = vi.fn();
const ghWriteJson = vi.fn();

vi.mock('../api/autoMerge', () => ({
  enableAutoMerge: (...args: unknown[]) => enableAutoMerge(...args),
  clearPrDescription: (...args: unknown[]) => clearPrDescription(...args),
  armAutoMerge: () => {
    throw new Error('armAutoMerge must not be used here: it deletes the description first');
  },
}));

vi.mock('../api/pullRequests', async () => {
  const actual = await vi.importActual<typeof import('../api/pullRequests')>('../api/pullRequests');
  return {
    ...actual,
    createPull: (...args: unknown[]) => createPull(...args),
    awaitMergeability: (...args: unknown[]) => awaitMergeability(...args),
    mergePull: (...args: unknown[]) => mergePull(...args),
  };
});

vi.mock('../api/forkSync', () => ({
  syncForkBranch: (...args: unknown[]) => syncForkBranch(...args),
}));

/**
 * The ref reads and writes the sync branch needs. `GitHubApiError` is kept real, because the
 * "does this branch exist" check turns on its status being exactly 404 — a stubbed error class
 * would let a wrong status pass unnoticed.
 */
vi.mock('../api/githubClient', async () => {
  const actual =
    await vi.importActual<typeof import('../api/githubClient')>('../api/githubClient');
  return {
    ...actual,
    ghGet: (...args: unknown[]) => ghGet(...args),
    ghWriteJson: (...args: unknown[]) => ghWriteJson(...args),
  };
});

const { pullIntoFork, proposeToFeatureBranch, syncIntoFeatureBranch } = await import(
  '../api/featureBranchActions'
);
const { GitHubApiError } = await import('../api/githubClient');
import type { PullRequest } from '../api/types';

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    node_id: 'PR_1',
    number: 7,
    title: 'T',
    html_url: 'https://github.com/o/r/pull/7',
    state: 'open',
    draft: false,
    user: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    auto_merge: null,
    merged_at: null,
    head: { sha: 'head-sha', ref: 'main', label: 'o:main', user: null },
    base: { ref: 'feature/x', repo: null },
    ...overrides,
  };
}

const SYNC = { owner: 'o', repo: 'r', branch: 'feature/x', defaultBranch: 'main' };
const OFFER = {
  owner: 'o',
  repo: 'r',
  forkOwner: 'me',
  branch: 'feature/x',
  title: 'Add retries',
  body: 'Because flakes.',
  method: 'squash' as const,
};

beforeEach(() => {
  // The sync branch is absent by default, so the ordinary path creates it.
  ghGet.mockImplementation(async (path: string) =>
    path.includes('/git/ref/heads/main')
      ? { data: { object: { sha: 'main-sha' } }, status: 200, notModified: false }
      : Promise.reject(new GitHubApiError('Not Found', 404)),
  );
  ghWriteJson.mockResolvedValue({});
  createPull.mockResolvedValue({ pr: pr(), existing: false });
  enableAutoMerge.mockResolvedValue(undefined);
  mergePull.mockResolvedValue({ merged: true, message: 'Pull Request successfully merged' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('syncIntoFeatureBranch', () => {
  /**
   * The pull request is opened from a sync branch, never straight from the default branch.
   *
   * A pull request whose head is `main` cannot finish: `main` keeps moving, so its diff changes
   * under review and the head cannot be deleted on merge. This mirrors the `create-merge.yml`
   * workflow the same repositories are driven by, down to the branch name and the title, so that
   * two tools producing the same operation produce the same shape of pull request.
   */
  it('creates a sync branch at the default branch tip and opens the PR from it', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(ghWriteJson).toHaveBeenCalledWith(
      'POST',
      '/repos/o/r/git/refs',
      { ref: 'refs/heads/sync/main-into-feature-x', sha: 'main-sha' },
      expect.anything(),
    );
    expect(createPull).toHaveBeenCalledWith('o', 'r', {
      head: 'sync/main-into-feature-x',
      base: 'feature/x',
      title: "Merge branch 'main' into 'feature/x'",
      body: '',
    });
    expect(outcome.steps.map((s) => s.label)).toContain('Created the sync branch');
  });

  /**
   * Reuse, not fast-forward. An existing sync branch almost certainly has an open pull request,
   * and moving the branch under a review would change what people had already looked at.
   */
  it('reuses an existing sync branch rather than moving it', async () => {
    ghGet.mockResolvedValue({ data: { object: { sha: 'whatever' } }, status: 200, notModified: false });
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(ghWriteJson).not.toHaveBeenCalled();
    expect(outcome.steps.map((s) => s.label)).toContain('Found the sync branch');
  });

  /** A failure creating the branch is reported as such, and no pull request is attempted. */
  it('stops if the sync branch cannot be created', async () => {
    ghWriteJson.mockRejectedValue(new GitHubApiError('Reference already exists', 422));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(outcome.ok).toBe(false);
    expect(createPull).not.toHaveBeenCalled();
    expect(outcome.steps[0]).toMatchObject({ label: 'Create the sync branch', state: 'failed' });
  });

  /**
   * Anything other than a 404 on the existence check is a real failure. Treating every error as
   * "not there" would try to create a branch over a permissions problem and report the wrong cause.
   */
  it('does not mistake a server error for a missing branch', async () => {
    ghGet.mockRejectedValue(new GitHubApiError('Server Error', 500));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(outcome.ok).toBe(false);
    expect(ghWriteJson).not.toHaveBeenCalled();
    expect(createPull).not.toHaveBeenCalled();
  });

  it('enables auto-merge when GitHub cannot merge it yet', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(enableAutoMerge).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }), 'MERGE');
    expect(mergePull).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.steps.map((s) => s.label)).toContain('Enabled auto-merge');
  });

  /**
   * Squashing the default branch into a feature branch replaces shared history with a
   * commit that exists nowhere else, and every later merge between the two then conflicts.
   */
  it('always enables with a merge commit, whatever is configured elsewhere', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));
    await syncIntoFeatureBranch(SYNC);
    expect(enableAutoMerge).toHaveBeenCalledWith(expect.anything(), 'MERGE');
  });

  /**
   * The branch turning out not to be protected. GitHub declines to queue a pull request it
   * could merge already, and the honest answer is to say so — merging on the user's behalf
   * would go around the rule that made this app arm rather than merge in the first place.
   */
  it('reports a refusal rather than merging when the branch is unprotected', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'clean' }));
    enableAutoMerge.mockRejectedValue(new Error('Pull request Pull request is in clean status'));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(mergePull).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('clean status');
    // And the pull request it opened is still reported, so a second click can adopt it.
    expect(outcome.pr?.number).toBe(7);
  });

  it('reports an unmergeable pull request without trying to merge it', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: false, mergeable_state: 'dirty' }));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(mergePull).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('conflicts');
    // The pull request exists, and the caller has to be able to tell.
    expect(outcome.pr?.number).toBe(7);
  });

  /** Two identical branches are the state this action exists to reach, not a failure. */
  it('treats "no commits between" as already up to date', async () => {
    createPull.mockRejectedValue(
      new GitHubApiError('No commits between main and feature/x', 422, false, 'other'),
    );

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('already has everything');
  });

  /**
   * The shape this recognition actually has to survive.
   *
   * GitHub sends the sentence inside the 422's `errors` array, under the constant heading
   * "Validation Failed". While githubClient read only `message`, the error reaching here
   * said "Validation Failed" and nothing matched — so an ordinary "nothing to merge" was
   * reported to the user as a failed pull request with no reason given. This asserts the
   * text that composition now produces, so the two cannot drift apart again.
   */
  it('recognises it from the text a 422 errors array produces', async () => {
    createPull.mockRejectedValue(
      new GitHubApiError(
        'No commits between master and feature/java/test_sync',
        422,
        false,
        'other',
      ),
    );

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(outcome.ok).toBe(true);
    expect(outcome.steps[0].detail).toBe('already up to date');
  });

  /** And the bare heading, which says nothing, must still be a failure. */
  it('does not mistake a bare "Validation Failed" for nothing to merge', async () => {
    createPull.mockRejectedValue(new GitHubApiError('Validation Failed', 422, false, 'other'));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(outcome.ok).toBe(false);
  });

  it('says nothing happened when the pull request could not be opened', async () => {
    createPull.mockRejectedValue(new GitHubApiError('Validation failed', 422, false, 'other'));

    const outcome = await syncIntoFeatureBranch(SYNC);

    expect(outcome.ok).toBe(false);
    expect(outcome.pr).toBeUndefined();
    expect(outcome.steps[0].state).toBe('failed');
  });
});

describe('proposeToFeatureBranch', () => {
  /**
   * The shape that makes this the third leg of the loop: **the same branch name on both
   * sides**, in two different repositories. Head is the fork's copy, base is the upstream's,
   * and the default branch appears nowhere — getting the feature branch into `main` is not
   * this tab's business.
   */
  it('offers the fork’s branch into the upstream’s branch of the same name', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));

    await proposeToFeatureBranch(OFFER);

    expect(createPull).toHaveBeenCalledWith('o', 'r', {
      headOwner: 'me',
      head: 'feature/x',
      base: 'feature/x',
      title: 'Add retries',
      body: 'Because flakes.',
    });
  });

  /** The description is the whole point of composing one; arming must not delete it. */
  it('never clears the description', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));
    await proposeToFeatureBranch(OFFER);
    expect(clearPrDescription).not.toHaveBeenCalled();
  });

  it('enables with the configured strategy', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));
    await proposeToFeatureBranch(OFFER);
    expect(enableAutoMerge).toHaveBeenCalledWith(expect.anything(), 'SQUASH');
  });

  /** Arming is all it does; GitHub does the merging, when the checks say so. */
  it('enables auto-merge rather than merging, even when already mergeable', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'clean' }));

    const outcome = await proposeToFeatureBranch(OFFER);

    expect(mergePull).not.toHaveBeenCalled();
    expect(enableAutoMerge).toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  it('leaves an adopted pull request’s text alone, and says so', async () => {
    createPull.mockResolvedValue({ pr: pr(), existing: true });
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));

    const outcome = await proposeToFeatureBranch(OFFER);

    expect(outcome.steps[0].detail).toContain('left as they are');
  });

  it('reports a failure to enable it without pretending the pull request is gone', async () => {
    awaitMergeability.mockResolvedValue(pr({ mergeable: true, mergeable_state: 'blocked' }));
    enableAutoMerge.mockRejectedValue(new Error('Auto merge is not allowed for this repository'));

    const outcome = await proposeToFeatureBranch(OFFER);

    expect(outcome.ok).toBe(false);
    expect(outcome.pr?.number).toBe(7);
    expect(outcome.message).toContain('not allowed');
  });
});

describe('pullIntoFork', () => {
  it('reports an already-current branch as a success', async () => {
    syncForkBranch.mockResolvedValue({ mergeType: 'none', baseBranch: 'feature/x', message: 'ok' });

    const outcome = await pullIntoFork('me', 'r', 'feature/x');

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('already level');
  });

  /** A diverged branch is merged rather than refused, and this app cannot undo that. */
  it('says when a merge commit was written into the fork', async () => {
    syncForkBranch.mockResolvedValue({ mergeType: 'merge', baseBranch: 'feature/x', message: 'ok' });

    const outcome = await pullIntoFork('me', 'r', 'feature/x');

    expect(outcome.message).toContain('merge commit');
  });

  it('explains a conflict rather than repeating GitHub’s 409', async () => {
    syncForkBranch.mockRejectedValue(new GitHubApiError('merge conflict', 409, false, 'conflict'));

    const outcome = await pullIntoFork('me', 'r', 'feature/x');

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('working copy');
  });
});

/**
 * The rule stated once, at the boundary. Every path above goes through `finishMerge`, so a
 * single assertion that nothing anywhere reached `mergePull` covers all of them — and it is
 * the assertion that would fail if someone reintroduced a "merge now".
 */
describe('nothing merges', () => {
  /**
   * The structural half, and the one that cannot go vacuous: neither module offers a merge
   * at all. The spy below only trips if someone re-imports one, so on its own it would pass
   * forever once the export was gone — this is what actually holds the rule.
   */
  it('exposes no way to merge a pull request', async () => {
    const pulls = await vi.importActual<Record<string, unknown>>('../api/pullRequests');
    const actions = await vi.importActual<Record<string, unknown>>('../api/featureBranchActions');
    expect(Object.keys(pulls)).not.toContain('mergePull');
    expect(Object.keys(actions)).not.toContain('mergeNow');
    expect(Object.keys(actions).filter((k) => /^merge/i.test(k))).toEqual([]);
  });

  it('never calls mergePull, whatever the state', async () => {
    for (const state of ['clean', 'blocked', 'behind', 'unstable', 'dirty', undefined]) {
      vi.clearAllMocks();
      createPull.mockResolvedValue({ pr: pr(), existing: false });
      enableAutoMerge.mockResolvedValue(undefined);
      awaitMergeability.mockResolvedValue(
        pr({ mergeable: state === 'dirty' ? false : true, mergeable_state: state }),
      );

      await syncIntoFeatureBranch(SYNC);
      await proposeToFeatureBranch(OFFER);

      expect(mergePull, `state=${state}`).not.toHaveBeenCalled();
    }
  });
});

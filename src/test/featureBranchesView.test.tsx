/**
 * The tab end to end against a stubbed GitHub: discovery, the two pull requests, the stage
 * strip, and the rules about which actions are offered.
 *
 * The point of covering it here rather than trusting the pieces: the tab's whole job is to
 * say *where a merge has stopped*, and that answer is assembled from three separate
 * responses (the branch refs, the pull request list, and the single-PR detail that carries
 * `mergeable_state`). Any of those going missing degrades quietly into a display that
 * looks fine and says the wrong thing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { FeatureBranchesView } from '../components/FeatureBranchesView';
import { ConfigProvider } from '../context/ConfigContext';
import { FeatureBranchesProvider } from '../context/FeatureBranchesContext';
import { NavigationProvider } from '../context/NavigationContext';
import { clearEtagCache, setFetchImpl, setTokenProvider } from '../api/githubClient';
import { recordPushAccess, recordTokenScopes, resetTokenCapability } from '../api/tokenCapability';
import { DEFAULT_CONFIG } from '../storage/configStore';

// The hook polls only for an unlocked session. Standing one up for real would mean an
// encrypted token in IndexedDB and a passphrase, none of which this is about.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ status: 'unlocked' }),
}));

/**
 * The view asks the dashboard which pull requests its tab lists, so a jump there cannot be a
 * dead end. Mounting the real provider would start a second poll; this stands in for it, and
 * `dashboardPrs` lets a test say which numbers it holds.
 */
let dashboardPrs: number[] = [];
vi.mock('../context/DashboardContext', () => ({
  useDashboard: () => ({ prs: dashboardPrs.map((number) => ({ pr: { number } })) }),
}));

const CONFIG = {
  ...DEFAULT_CONFIG,
  upstream: { owner: 'up', repo: 'proj' },
  fork: { owner: 'me', repo: '', branch: null },
  featureBranches: { enabled: true, prefix: 'feature/' },
};

function ref(name: string, sha: string) {
  return { ref: `refs/heads/${name}`, object: { sha, type: 'commit' } };
}

function pull(overrides: Record<string, unknown>) {
  return {
    id: 1,
    node_id: 'PR_1',
    number: 7,
    title: 'Reporting v2',
    html_url: 'https://github.com/up/proj/pull/7',
    state: 'open',
    draft: false,
    user: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    auto_merge: null,
    merged_at: null,
    // The offer's shape: the fork's copy of the branch into the upstream's copy of the same
    // branch. The head *owner* is what distinguishes it, so it must be present.
    head: {
      sha: 'headsha',
      ref: 'feature/a',
      label: 'me:feature/a',
      user: { login: 'me', avatar_url: '', html_url: '' },
    },
    base: { ref: 'feature/a', repo: null },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' }),
  });
}

/** A GitHub stand-in whose per-route bodies each test can override. */
function stubGitHub(routes: {
  upstreamRefs?: unknown;
  forkRefs?: unknown;
  /** What the fork is offering: head `{fork}:{branch}`, base the same branch upstream. */
  pulls?: unknown;
  /** What is coming in from the default branch: head `{upstream}:{defaultBranch}`. */
  syncPulls?: unknown;
  detail?: unknown;
  repo?: Record<string, unknown>;
  /** A comparison body, or 'fail' to make the request 500. */
  compare?: Record<string, unknown> | 'fail';
}) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input);
    const path = url.pathname;

    if (/\/compare\//.test(path)) {
      if (routes.compare === 'fail') return jsonResponse({ message: 'boom' }, 500);
      // base = upstream, head = fork, so every number reads from the fork's point of view.
      return jsonResponse({
        commits: [],
        ...(routes.compare ?? { status: 'identical', ahead_by: 0, behind_by: 0 }),
      });
    }
    if (/\/git\/matching-refs\//.test(path)) {
      return jsonResponse(
        path.startsWith('/repos/up/') ? (routes.upstreamRefs ?? []) : (routes.forkRefs ?? []),
      );
    }
    if (/\/pulls\/\d+$/.test(path)) return jsonResponse(routes.detail ?? pull({}));
    if (/\/pulls$/.test(path)) {
      /**
       * Routed by the `head` filter, as GitHub does. The two queries the tab makes differ
       * only in it — `up:main` for what is coming *in* from the default branch, and
       * `me:feature/a` for what the fork is offering — and answering both with one list made
       * a single pull request match as both, which is not a state that can exist.
       */
      const head = url.searchParams.get('head') ?? '';
      if (head.startsWith('up:')) return jsonResponse(routes.syncPulls ?? []);
      return jsonResponse(routes.pulls ?? []);
    }
    if (/\/check-runs$/.test(path)) return jsonResponse({ total_count: 0, check_runs: [] });
    if (/\/status$/.test(path)) return jsonResponse({ state: 'pending', total_count: 0, statuses: [] });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      return jsonResponse({
        name: 'proj',
        full_name: path.slice('/repos/'.length),
        private: false,
        permissions: { admin: false, push: true, pull: true },
        default_branch: 'main',
        fork: true,
        parent: { full_name: 'up/proj' },
        allow_auto_merge: true,
        allow_merge_commit: true,
        ...(routes.repo ?? {}),
      });
    }
    return jsonResponse({ message: 'Not Found' }, 404);
  });
  setFetchImpl(fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderView(props: { onOpenPr?: (n: number) => void } = {}) {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <ConfigProvider>
          <NavigationProvider value={{ openPr: props.onOpenPr ?? (() => {}), openFailure: () => {} }}>
            <FeatureBranchesProvider>
              <FeatureBranchesView />
            </FeatureBranchesProvider>
          </NavigationProvider>
        </ConfigProvider>
      </BaseStyles>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  dashboardPrs = [];
  localStorage.clear();
  localStorage.setItem('job-monitor.config', JSON.stringify(CONFIG));
  clearEtagCache();
  resetTokenCapability();
  setTokenProvider(() => 'token');
  // The write gate: without both halves the actions hide themselves, which is its own test
  // below but would otherwise silently disable every other assertion here.
  recordTokenScopes(new Headers({ 'x-oauth-scopes': 'repo, workflow' }));
  recordPushAccess(true);
});

afterEach(() => {
  setFetchImpl(globalThis.fetch);
  resetTokenCapability();
  vi.restoreAllMocks();
});

describe('FeatureBranchesView', () => {
  it('shows only the branches both repositories have', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa'), ref('feature/upstream-only', 'bbb')],
      forkRefs: [ref('feature/a', 'aaa')],
    });

    renderView();

    expect(await screen.findByText('feature/a')).toBeInTheDocument();
    expect(screen.queryByText('feature/upstream-only')).not.toBeInTheDocument();
  });

  /**
   * GitHub answers 404 both for "no matching refs" and for "no such repository", so a
   * mistyped fork name lands in this same reassuring message. Naming both repositories is
   * the only thing that makes the mistake noticeable.
   */
  it('names both repositories when nothing is shared', async () => {
    stubGitHub({ upstreamRefs: [ref('feature/a', 'aaa')], forkRefs: [] });

    renderView();

    expect(await screen.findByText(/exists in both/i)).toBeInTheDocument();
    expect(screen.getByText('up/proj')).toBeInTheDocument();
    expect(screen.getByText('me/proj')).toBeInTheDocument();
    expect(screen.getByText(/Settings → Repository/)).toBeInTheDocument();
  });

  /**
   * "At a different commit" described being three commits behind and having diverged forty
   * commits ago identically — and those want opposite things, since only the second writes
   * a merge commit when you press sync. So the direction and the counts are the point.
   */
  it('says which way the fork stands and by how much', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'older')],
      // head is the fork, so `behind` and `behind_by` are the fork's own standing.
      compare: { status: 'behind', ahead_by: 0, behind_by: 3 },
    });

    renderView();

    expect(await screen.findByText('your fork is 3 commits behind')).toBeInTheDocument();
  });

  it('singularises one commit', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'older')],
      compare: { status: 'behind', ahead_by: 0, behind_by: 1 },
    });

    renderView();

    expect(await screen.findByText('your fork is 1 commit behind')).toBeInTheDocument();
  });

  it('reports both counts when the two have diverged', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'older')],
      compare: {
        status: 'diverged',
        ahead_by: 2,
        behind_by: 4,
        commits: [{ sha: 'a', parents: [{ sha: 'p' }] }, { sha: 'b', parents: [{ sha: 'p' }] }],
      },
    });

    renderView();

    expect(
      await screen.findByText('diverged — 4 commits behind, 2 commits of your own ahead'),
    ).toBeInTheDocument();
  });

  /**
   * Being ahead is unpushed work, not a problem to fix — and pulling could only report that
   * there was nothing to do, so the button is inert rather than offered. A control whose one
   * possible outcome is a shrug is worse than an absent one, and here it would spend a write
   * to find out.
   */
  it('disables pulling when the fork is only ahead, and says why', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'newer')],
      compare: {
        status: 'ahead',
        ahead_by: 5,
        behind_by: 0,
        commits: Array.from({ length: 5 }, (_, i) => ({ sha: `c${i}`, parents: [{ sha: 'p' }] })),
      },
    });

    renderView();

    const pull = await screen.findByRole('button', {
      name: /pull feature\/a into your fork/i,
    });
    await waitFor(() => expect(pull).toHaveAttribute('aria-disabled', 'true'));
    /**
     * The card states both halves: nothing to pull *and* something to offer. "5 commits
     * ahead" on its own read as a discrepancy — the wrong impression right after a sync,
     * where being ahead is the expected outcome.
     */
    expect(
      screen.getByText('your fork is up to date, plus 5 commits of your own'),
    ).toBeInTheDocument();
    // And offering, which is what you *can* do from here, stays available.
    expect(
      screen.getByRole('button', { name: /commit your feature\/a to the upstream/i }),
    ).not.toHaveAttribute('aria-disabled');
  });

  /**
   * The reported case, from real data: a fork three commits ahead of which one was the merge
   * commit *this app wrote* when it synced. Counting it made "3 commits of your own" out of
   * two commits and one press of a button.
   */
  it('does not count the merge commits it made itself as your work', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'newer')],
      compare: {
        status: 'ahead',
        ahead_by: 3,
        behind_by: 0,
        commits: [
          { sha: 'f7e0229b', parents: [{ sha: 'p1' }] },
          // Two parents: the merge left behind by "Pull into my fork".
          { sha: '8fca6aee', parents: [{ sha: 'p1' }, { sha: 'p2' }] },
          { sha: '149d4450', parents: [{ sha: 'p3' }] },
        ],
      },
    });

    renderView();

    expect(
      await screen.findByText('your fork is up to date, plus 2 commits of your own'),
    ).toBeInTheDocument();
  });

  /** All of it a merge means there is no authored work to name a number for. */
  it('says so when the only difference is a merge commit', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'newer')],
      compare: {
        status: 'ahead',
        ahead_by: 1,
        behind_by: 0,
        commits: [{ sha: 'm', parents: [{ sha: 'p1' }, { sha: 'p2' }] }],
      },
    });

    renderView();

    expect(
      await screen.findByText('your fork is up to date, plus a merge commit from syncing'),
    ).toBeInTheDocument();
  });

  /**
   * The reported case, and the one the commit counts get wrong on their own.
   *
   * A squash merge rewrites the contributed commits into one new commit upstream, so the
   * fork keeps the originals under different SHAs and git calls it a divergence. "2 commits
   * of your own ahead" then describes work that is *already merged*. The file count is what
   * settles it: no file differs, so there is nothing left to offer.
   */
  it('recognises a squash merge instead of calling it a divergence', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'squashed')],
      forkRefs: [ref('feature/a', 'originals')],
      compare: {
        status: 'diverged',
        ahead_by: 2,
        behind_by: 1,
        commits: [
          { sha: 'a1', parents: [{ sha: 'p' }] },
          { sha: 'a2', parents: [{ sha: 'p' }] },
        ],
        // The point: the histories differ, the content does not.
        files: [],
      },
    });

    renderView();

    expect(
      await screen.findByText('same content as the upstream — only the commits differ, from a squash merge'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /commit your feature\/a to the upstream/i }),
      ).toHaveAttribute('aria-disabled', 'true'),
    );
  });

  /** A real divergence still says how much actually differs, which the counts cannot. */
  it('names the file difference when one remains', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'bbb')],
      compare: {
        status: 'diverged',
        ahead_by: 3,
        behind_by: 1,
        commits: [
          { sha: 'a1', parents: [{ sha: 'p' }] },
          { sha: 'm', parents: [{ sha: 'p' }, { sha: 'q' }] },
          { sha: 'a2', parents: [{ sha: 'p' }] },
        ],
        files: [{ filename: 'Java/cs2j.config', additions: 1, deletions: 0, status: 'modified' }],
      },
    });

    renderView();

    expect(
      await screen.findByText(
        'diverged — 1 commit behind, 2 commits of your own ahead (1 file differs)',
      ),
    ).toBeInTheDocument();
  });

  /** The mirror image: behind means nothing of your own to offer. */
  it('disables offering when the fork is only behind', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'older')],
      compare: { status: 'behind', ahead_by: 0, behind_by: 3 },
    });

    renderView();

    const offer = await screen.findByRole('button', {
      name: /commit your feature\/a to the upstream/i,
    });
    await waitFor(() => expect(offer).toHaveAttribute('aria-disabled', 'true'));
    expect(
      screen.getByRole('button', { name: /pull feature\/a into your fork/i }),
    ).not.toHaveAttribute('aria-disabled');
  });

  it('disables both when the two copies are identical', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'aaa')],
    });

    renderView();

    await screen.findByText('your fork matches the upstream');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /pull feature\/a into your fork/i }),
      ).toHaveAttribute('aria-disabled', 'true'),
    );
    expect(
      screen.getByRole('button', { name: /commit your feature\/a to the upstream/i }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  /** Diverged is the one state where both directions have something to move. */
  it('leaves both enabled when the two have diverged', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'other')],
      compare: {
        status: 'diverged',
        ahead_by: 2,
        behind_by: 3,
        commits: [{ sha: 'a', parents: [{ sha: 'p' }] }, { sha: 'b', parents: [{ sha: 'p' }] }],
      },
    });

    renderView();

    await screen.findByText(/diverged/);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /pull feature\/a into your fork/i }),
      ).not.toHaveAttribute('aria-disabled'),
    );
    expect(
      screen.getByRole('button', { name: /commit your feature\/a to the upstream/i }),
    ).not.toHaveAttribute('aria-disabled');
  });

  /** A failed comparison is not proof there is nothing to do, so nothing is hidden. */
  it('leaves both enabled when the comparison could not be read', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'older')],
      compare: 'fail',
    });

    renderView();

    await screen.findByText('your fork is at a different commit');
    expect(
      screen.getByRole('button', { name: /pull feature\/a into your fork/i }),
    ).not.toHaveAttribute('aria-disabled');
    expect(
      screen.getByRole('button', { name: /commit your feature\/a to the upstream/i }),
    ).not.toHaveAttribute('aria-disabled');
  });

  /** A failed comparison must not blank the tab; the honest vague label is the fallback. */
  it('falls back to the vague label when the comparison cannot be read', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'older')],
      compare: 'fail',
    });

    renderView();

    expect(await screen.findByText('your fork is at a different commit')).toBeInTheDocument();
  });

  /** Equal tips need no request at all. */
  it('does not compare when the two tips are identical', async () => {
    const fetchMock = stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'aaa')],
    });

    renderView();

    expect(await screen.findByText('your fork matches the upstream')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('/compare/')),
    ).toHaveLength(0);
  });

  /** The tab's reason for existing: the answer to "why is this sitting there". */
  it('reads the reason a pull request is stuck out of mergeable_state', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'aaa')],
      pulls: [pull({})],
      detail: pull({ mergeable: false, mergeable_state: 'dirty' }),
    });

    renderView();

    expect(await screen.findByText(/Conflicts — this one needs a working copy/i)).toBeInTheDocument();
  });

  it('shows the armed badge for a queued pull request', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'aaa')],
      pulls: [pull({})],
      detail: pull({
        mergeable: true,
        mergeable_state: 'blocked',
        auto_merge: { enabled_by: null, merge_method: 'squash', commit_title: null, commit_message: null },
      }),
    });

    renderView();

    expect(await screen.findByText('auto-merge')).toBeInTheDocument();
  });

  /**
   * There is no "merge now", and there must not be: landing directly in a feature branch is
   * forbidden by the repository, so the tab only ever opens a pull request and arms
   * auto-merge. A merge button here would be a route around that rule.
   */
  it('never offers a way to merge, however mergeable GitHub says it is', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'aaa')],
      pulls: [pull({})],
      detail: pull({ mergeable: true, mergeable_state: 'clean' }),
    });

    renderView();

    await screen.findByText('feature/a');
    expect(screen.queryByRole('button', { name: /merge now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^merge/i })).not.toBeInTheDocument();
  });

  /**
   * Check runs settle; mergeability does not. It changes when a review lands or when the
   * base branch moves — often after the last check finished — so a refresh that only
   * re-read unsettled checks would leave the strip saying "waiting on required checks"
   * next to a row of ticks, for good.
   */
  it('keeps re-reading mergeability after the checks have settled', async () => {
    let state = 'blocked';
    const fetchMock = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (/\/git\/matching-refs\//.test(path)) return jsonResponse([ref('feature/a', 'aaa')]);
      if (/\/pulls\/\d+$/.test(path)) {
        return jsonResponse(pull({ mergeable: true, mergeable_state: state }));
      }
      // Routed by head, like stubGitHub: one list answering both queries would make the
      // same pull request match as the incoming backmerge *and* the fork's offer.
      if (/\/pulls$/.test(path)) {
        const head = new URL(input).searchParams.get('head') ?? '';
        return jsonResponse(head.startsWith('up:') ? [] : [pull({})]);
      }
      // Complete and green, so `needsChecks` is false from the first fetch onwards.
      if (/\/check-runs$/.test(path)) {
        return jsonResponse({
          total_count: 1,
          check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }],
        });
      }
      if (/\/status$/.test(path)) return jsonResponse({ state: 'success', total_count: 0, statuses: [] });
      return jsonResponse({
        name: 'proj',
        full_name: 'up/proj',
        private: false,
        permissions: { admin: false, push: true, pull: true },
        default_branch: 'main',
        fork: true,
        parent: { full_name: 'up/proj' },
      });
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    renderView();
    expect(await screen.findByText(/Waiting on required checks/i)).toBeInTheDocument();

    state = 'clean';
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(await screen.findByText(/Ready to merge/i)).toBeInTheDocument();
  });

  /**
   * merge-upstream syncs from the fork's *actual* parent and cannot be told otherwise, so
   * a fork of something else would succeed while pulling from the wrong repository.
   */
  it('disables the fork sync when the fork is not a fork of the configured upstream', async () => {
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'aaa')],
      repo: { fork: true, parent: { full_name: 'someone-else/proj' } },
    });

    renderView();

    expect(await screen.findByText(/was forked from someone-else\/proj/i)).toBeInTheDocument();
    /**
     * Inert rather than `disabled`: a disabled button reports nothing to a pointer, so its
     * tooltip would never appear — on exactly the control whose explanation matters most.
     * `aria-disabled` tells assistive technology, and the handler declines.
     */
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /pull feature\/a into your fork/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
  });

  describe('navigating away from a pull request', () => {
    const withOpenPr = () =>
      stubGitHub({
        upstreamRefs: [ref('feature/a', 'aaa')],
        forkRefs: [ref('feature/a', 'aaa')],
        pulls: [pull({})],
        detail: pull({ mergeable: true, mergeable_state: 'blocked' }),
      });

    it('opens the pull request on GitHub in a new tab', async () => {
      withOpenPr();
      const open = vi.spyOn(window, 'open').mockReturnValue(null);

      renderView();

      const button = await screen.findByRole('button', { name: /open #7 on github/i });
      fireEvent.click(button);

      expect(open).toHaveBeenCalledWith(
        'https://github.com/up/proj/pull/7',
        '_blank',
        'noopener,noreferrer',
      );
    });

    it('copies the link, and says so', async () => {
      withOpenPr();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      renderView();

      fireEvent.click(await screen.findByRole('button', { name: /copy the link to #7/i }));

      expect(writeText).toHaveBeenCalledWith('https://github.com/up/proj/pull/7');
      expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument();
    });

    /** Reporting a failure beats a button that claims to have copied and hasn't. */
    it('offers the link to copy by hand when the clipboard is unavailable', async () => {
      withOpenPr();
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

      renderView();

      fireEvent.click(await screen.findByRole('button', { name: /copy the link to #7/i }));

      expect(
        await screen.findByRole('button', { name: /could not copy/i }),
      ).toBeInTheDocument();
    });

    /**
     * The jump is offered only for a pull request the Pull requests tab actually lists — the
     * offer usually qualifies, the incoming backmerge never does. A button landing on a list
     * without it would be a dead end.
     */
    it('jumps to the Pull requests tab when that tab lists this one', async () => {
      dashboardPrs = [7];
      withOpenPr();
      const onOpenPr = vi.fn();

      renderView({ onOpenPr });

      fireEvent.click(await screen.findByRole('button', { name: /show #7 in pull requests/i }));

      expect(onOpenPr).toHaveBeenCalledWith(7);
    });

    it('offers no jump for a pull request that tab cannot show', async () => {
      dashboardPrs = [];
      withOpenPr();

      renderView({ onOpenPr: vi.fn() });

      await screen.findByRole('button', { name: /open #7 on github/i });
      expect(
        screen.queryByRole('button', { name: /show #7 in pull requests/i }),
      ).not.toBeInTheDocument();
    });

    /** Reading and sharing a link are not writes, so a read-only token keeps them. */
    it('keeps them with a token that cannot write', async () => {
      resetTokenCapability();
      withOpenPr();

      renderView();

      expect(await screen.findByRole('button', { name: /open #7 on github/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copy the link to #7/i })).toBeInTheDocument();
    });
  });

  /** A control that 403s is worse than no control; the progress display stays. */
  it('hides every action when the token cannot write, but still shows the branches', async () => {
    resetTokenCapability();
    stubGitHub({
      upstreamRefs: [ref('feature/a', 'aaa')],
      forkRefs: [ref('feature/a', 'aaa')],
    });

    renderView();

    expect(await screen.findByText('feature/a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync from/i })).not.toBeInTheDocument();
    expect(screen.getByText(/can't write to the repository/i)).toBeInTheDocument();
  });
});

/**
 * The data behind the Feature branches tab: which shared branches exist, the pull requests
 * moving work in and out of them, and how far along each of those has got.
 *
 * Structurally a smaller `useGitHubDashboard`, and deliberately so — it produces the same
 * `PrEntry` shape, which is what lets the existing check-polling logic, the status
 * summaries and the auto-rerun engine work on these pull requests without knowing they
 * came from somewhere new.
 *
 * Two things it does that the dashboard does not:
 *
 *  - It fetches each pull request **individually** as well as in a list, because
 *    `mergeable_state` — the field that answers "why is this stuck" — is only on the
 *    single-PR endpoint.
 *  - It stays inert unless the feature is switched on. The three actions write to a real
 *    repository, and a poll running for someone who never enabled the tab would be pure
 *    cost.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchFeatureBranches, type FeatureBranch } from '../api/featureBranches';
import { verifyForkParent, type ForkParentCheck } from '../api/forkSync';
import {
  checkRunsPath,
  combinedStatusPath,
  comparePath,
  pullPath,
  pullsPath,
  repoPath,
} from '../api/endpoints';
import { ghGet } from '../api/githubClient';
import type {
  CheckRunsResponse,
  CombinedStatus,
  Comparison,
  PullRequest,
  Repository,
} from '../api/types';
import { devWarn } from '../lib/devLog';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import { combineChecksAndStatus } from '../lib/status';
import { forkRepo, isConfigComplete } from '../storage/configStore';
import { needsChecks, type PrEntry } from './useGitHubDashboard';
import { usePolling } from './usePolling';
import { Operation } from '../lib/telemetry';
import { useVisibility } from './useVisibility';

/**
 * How many feature branches to track at once.
 *
 * Each one costs a request per poll for its outgoing pull request, plus up to three more
 * while that pull request is live. A repository with fifty feature branches would spend
 * its whole rate limit here, and nobody is watching fifty of them.
 */
const MAX_TRACKED_BRANCHES = 25;

/** Same watch window the dashboard uses after a re-run: keep polling through it. */
const RERUN_WATCH_MS = 2 * 60_000;

/**
 * How the fork's copy of a branch stands against the upstream's.
 *
 * Two SHAs being different is easy to see and nearly useless on its own: "your fork is at a
 * different commit" describes *being three commits behind* and *having diverged forty
 * commits ago* equally well, and those call for opposite actions — the first wants the sync
 * button, the second produces a merge commit if you press it. So the counts are fetched.
 */
export interface ForkStanding {
  /**
   * `behind` — the upstream has commits the fork lacks, and nothing the other way. This is
   * the ordinary case and the one the sync button is for.
   * `ahead` — the fork has commits the upstream lacks. Nothing to pull.
   * `diverged` — both, so syncing writes a merge commit.
   * `identical` — the same commit.
   * `unknown` — the comparison could not be read; the SHAs differ, and that is all we know.
   */
  state: 'identical' | 'behind' | 'ahead' | 'diverged' | 'unknown';
  /** Commits the upstream has that the fork does not. */
  behindBy: number;
  /** Commits the fork has that the upstream does not, merge commits included. */
  aheadBy: number;
  /**
   * How many of those the fork's owner actually wrote — `aheadBy` minus the merges.
   *
   * The two differ because **this app creates merge commits itself**: pulling a diverged
   * branch into the fork merges rather than fast-forwarding, and that merge is then a commit
   * the upstream does not have. Counting it as work made "3 commits of your own" out of two
   * commits and one artefact of pressing the sync button.
   */
  ownCommits: number;
  /**
   * How many files actually differ, or null when the comparison did not say.
   *
   * The counts alone mislead after a **squash merge**: squashing rewrites the work into one
   * new commit, so the branch that contributed it still holds the originals under different
   * SHAs and git reports a divergence — "2 commits of your own ahead" for work that is
   * already upstream. The file count is what separates history from content, and it costs
   * nothing: the same comparison already carries it.
   */
  filesDiffering: number | null;
}

export interface FeatureBranchRow {
  branch: FeatureBranch;
  /** The open pull request bringing the upstream's default branch *into* this branch. */
  sync: PrEntry | null;
  /** The open cross-fork pull request offering the fork's work *to* this branch. */
  offer: PrEntry | null;
  /** Where the fork's copy stands relative to the upstream's. */
  standing: ForkStanding;
  /** How far the shared branch has fallen behind the default branch. Null until compared. */
  mainStanding: MainStanding | null;
}

/**
 * Where the shared branch stands against the branch it will eventually merge into.
 *
 * Separate from {@link ForkStanding}, which answers a different question — that one is about your
 * copy versus the upstream's, this one is about the upstream's copy versus the default branch. A
 * branch can be perfectly in sync with the upstream and still be two hundred commits behind `main`,
 * and it is the second number that decides whether it is still mergeable in practice.
 *
 * Measured on the **upstream's** copy, because that is the shared branch and the one the sync action
 * writes to. Your fork's local drift is the other standing's business.
 */
export interface MainStanding {
  /** Commits the default branch has that this feature branch does not — how far behind it is. */
  behindBy: number;
  /** Commits this feature branch has that the default branch does not. */
  aheadBy: number;
  state: 'identical' | 'behind' | 'ahead' | 'diverged' | 'unknown';
}

/** What the repository itself permits, which decides whether an action is offerable. */
export interface RepoCapabilities {
  defaultBranch: string;
  allowAutoMerge: boolean;
  allowMergeCommit: boolean;
}

export interface FeatureBranchesState {
  rows: FeatureBranchRow[];
  /** Every pull request tracked here, flat — what the auto-rerun engine consumes. */
  prs: PrEntry[];
  repo: RepoCapabilities | null;
  /** Whether the fork really is a fork of the configured upstream. Null until checked. */
  forkParent: ForkParentCheck | null;
  /** True when the branch list was cut short by MAX_TRACKED_BRANCHES. */
  truncated: boolean;
  enabled: boolean;
  listError: Error | null;
  listUpdatedAt: number | null;
  isFetchingList: boolean;
  isFetchingChecks: boolean;
  refreshAll: () => void;
  invalidateChecks: (prNumber: number) => void;
}

function newEntry(pr: PullRequest): PrEntry {
  return {
    pr,
    overall: 'unknown',
    checkRuns: [],
    combined: null,
    checksUpdatedAt: null,
    checksError: null,
    watchUntil: null,
  };
}

/**
 * Fold a listed pull request into what is already known about it.
 *
 * The list endpoint omits `mergeable`, `mergeable_state` and `merged`, so taking its
 * payload wholesale would erase the detail fetched moments earlier and the progress
 * display would flicker back to "GitHub is still working it out" on every poll. Carrying
 * them forward is only safe while the head is unchanged — a new head invalidates the
 * mergeability answer as surely as it invalidates the checks.
 */
function foldPr(incoming: PullRequest, previous: PrEntry | undefined): PrEntry {
  if (!previous || previous.pr.head.sha !== incoming.head.sha) return newEntry(incoming);
  return {
    ...previous,
    pr: {
      ...incoming,
      mergeable: incoming.mergeable ?? previous.pr.mergeable,
      mergeable_state: incoming.mergeable_state ?? previous.pr.mergeable_state,
      merged: incoming.merged ?? previous.pr.merged,
    },
  };
}

export function useFeatureBranches(): FeatureBranchesState {
  const { config } = useConfig();
  const { status } = useAuth();
  const visible = useVisibility();

  const enabled =
    status === 'unlocked' && isConfigComplete(config) && config.featureBranches.enabled;

  const [branches, setBranches] = useState<FeatureBranch[]>([]);
  /** Fork-vs-upstream standing per branch name; absent until compared. */
  const [standings, setStandings] = useState<Map<string, ForkStanding>>(new Map());
  /** Branch-vs-default-branch standing, same keying. */
  const [mainStandings, setMainStandings] = useState<Map<string, MainStanding>>(new Map());
  const [truncated, setTruncated] = useState(false);
  const [repo, setRepo] = useState<RepoCapabilities | null>(null);
  const [forkParent, setForkParent] = useState<ForkParentCheck | null>(null);
  /** Keyed `${direction}:${branch}` so a branch's two pull requests never collide. */
  const [entries, setEntries] = useState<Map<string, PrEntry>>(new Map());

  const listIntervalMs =
    (visible ? config.polling.prListSeconds : config.polling.hiddenSeconds) * 1000;
  const checksIntervalMs =
    (visible ? config.polling.checksSeconds : config.polling.hiddenSeconds) * 1000;

  const upstreamOwner = config.upstream.owner;
  const upstreamRepo = config.upstream.repo;
  const forkOwner = config.fork.owner;
  const forkName = forkRepo(config);
  const prefix = config.featureBranches.prefix;

  // Reset when the watched coordinates change, so branches from another repository
  // don't linger under the new one's actions.
  const scopeKey = `${upstreamOwner}/${upstreamRepo}|${forkOwner}/${forkName}|${prefix}`;
  /**
   * The scope a fetch was started for.
   *
   * Settings renders inside the data providers, so the prefix or the fork name can change
   * while a fetch for the previous one is in the air. Without this the late answer lands
   * after the reset and repopulates the list with the *old* repository's branches — under a
   * config whose actions would then write to the new one.
   */
  const scopeRef = useRef(scopeKey);
  useEffect(() => {
    scopeRef.current = scopeKey;
    setBranches([]);
    setStandings(new Map());
    setEntries(new Map());
    setRepo(null);
    setForkParent(null);
    setTruncated(false);
  }, [scopeKey]);

  const fetchList = useCallback(async () => {
    const startedFor = scopeKey;
    /** True while the answer still describes what the app is looking at. */
    const current = () => scopeRef.current === startedFor;

    const { data: repoData } = await ghGet<Repository>(repoPath(upstreamOwner, upstreamRepo));
    if (!current()) return;
    const defaultBranch = repoData.default_branch ?? 'main';
    setRepo({
      defaultBranch,
      // Absent rather than false on a payload that didn't include them; assume permitted
      // and let GitHub be the authority, rather than hiding an action that would work.
      allowAutoMerge: repoData.allow_auto_merge !== false,
      allowMergeCommit: repoData.allow_merge_commit !== false,
    });

    const found = await fetchFeatureBranches(
      { owner: upstreamOwner, repo: upstreamRepo },
      { owner: forkOwner, repo: forkName },
      prefix,
    );
    if (!current()) return;
    setTruncated(found.length > MAX_TRACKED_BRANCHES);
    const tracked = found.slice(0, MAX_TRACKED_BRANCHES);
    setBranches(tracked);

    /**
     * Which way, and by how much.
     *
     * Only for branches whose tips actually differ — an identical pair needs no request —
     * and compared inside the **fork**, with the upstream's commit named as
     * `{owner}:{sha}`. Compared the other way round the fork's commit would have to be
     * reachable from the upstream, which for work that has never been pushed there it is
     * not; the fork can always see both, since a fork shares its parent's objects.
     *
     * Failures degrade to `unknown` rather than propagating: a vague label is a far better
     * outcome than a tab that shows nothing because one comparison would not load.
     */
    void Promise.all(
      tracked
        .filter((b) => b.forkSha !== b.upstreamSha)
        .map(async (b): Promise<[string, ForkStanding]> => {
          try {
            /**
             * Base is the upstream, head is the fork — so every number reads from the fork's
             * point of view and nothing has to be inverted.
             *
             * It used to be the other way round, which made `ahead_by` mean "how far behind"
             * and needed a comment saying the names read backwards. That is the kind of thing
             * that survives review and then quietly gets a sign wrong. This order also puts
             * the fork's own commits in `commits`, which is what separates work from the merge
             * commits this app creates when it syncs.
             */
            const { data } = await ghGet<Comparison>(
              comparePath(forkOwner, forkName, `${upstreamOwner}:${b.upstreamSha}`, b.forkSha),
            );
            const aheadBy = data.ahead_by ?? 0;
            // `files` is capped at 300 by GitHub, so a large diff undercounts — but the
            // distinction that matters here is zero versus more than zero.
            const filesDiffering = data.files ? data.files.length : null;
            // A merge has two parents. GitHub caps `commits` at 250, so on a longer-lived
            // branch this undercounts rather than overstating what is yours.
            const merges = (data.commits ?? []).filter((c) => (c.parents?.length ?? 1) > 1).length;
            return [
              b.name,
              {
                state:
                  data.status === 'ahead' ||
                  data.status === 'behind' ||
                  data.status === 'identical' ||
                  data.status === 'diverged'
                    ? data.status
                    : 'unknown',
                behindBy: data.behind_by ?? 0,
                aheadBy,
                ownCommits: Math.max(0, aheadBy - merges),
                filesDiffering,
              },
            ];
          } catch (e) {
            devWarn('api', `feature branches: could not compare ${b.name}`, e);
            return [
              b.name,
              { state: 'unknown', behindBy: 0, aheadBy: 0, ownCommits: 0, filesDiffering: null },
            ];
          }
        }),
    ).then((pairs) => {
      if (!current()) return;
      setStandings(new Map(pairs));
    });

    /**
     * And how far each shared branch has fallen behind the default branch.
     *
     * Base is the default branch, head is the feature branch, so `behind_by` means exactly what it
     * says — commits `main` has that this branch does not — and nothing has to be read backwards.
     * The other order would have made the number arrive as `ahead_by`, which is how a sign quietly
     * gets inverted six months later.
     *
     * Compared inside the **upstream** on its own tip: this is about the branch everyone shares,
     * not about your copy of it, and mixing the two would answer a question nobody asked.
     *
     * One more request per branch per list poll, ETag-cached like the rest, and only on the list
     * poll rather than the checks poll — this number moves when `main` moves, not when a check
     * finishes.
     */
    void Promise.all(
      tracked.map(async (b): Promise<[string, MainStanding]> => {
        try {
          const { data } = await ghGet<Comparison>(
            comparePath(upstreamOwner, upstreamRepo, defaultBranch, b.upstreamSha),
          );
          return [
            b.name,
            {
              behindBy: data.behind_by ?? 0,
              aheadBy: data.ahead_by ?? 0,
              state:
                data.status === 'ahead' ||
                data.status === 'behind' ||
                data.status === 'identical' ||
                data.status === 'diverged'
                  ? data.status
                  : 'unknown',
            },
          ];
        } catch (e) {
          devWarn('api', `feature branches: could not compare ${b.name} with ${defaultBranch}`, e);
          return [b.name, { behindBy: 0, aheadBy: 0, state: 'unknown' }];
        }
      }),
    ).then((pairs) => {
      if (!current()) return;
      setMainStandings(new Map(pairs));
    });
    if (tracked.length === 0) {
      setEntries((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }

    /**
     * Two lists, and both are narrowed server-side.
     *
     * Every incoming pull request has the same head — the upstream's default branch — so a
     * single request finds all of them. The offers *from the fork* each have their own head
     * (`{forkOwner}:{branch}`) and their own base (the same branch in the upstream), so they
     * need one request apiece.
     */
    const [syncList, ...offerLists] = await Promise.all([
      ghGet<PullRequest[]>(
        pullsPath(upstreamOwner, upstreamRepo, { head: `${upstreamOwner}:${defaultBranch}` }),
      ),
      ...tracked.map((b) =>
        ghGet<PullRequest[]>(
          pullsPath(upstreamOwner, upstreamRepo, {
            head: `${forkOwner}:${b.name}`,
            base: b.name,
          }),
        ),
      ),
    ]);

    if (!current()) return;
    setEntries((prev) => {
      const next = new Map<string, PrEntry>();
      tracked.forEach((b, i) => {
        const sync = syncList.data.find((pr) => pr.base.ref === b.name);
        if (sync) next.set(`sync:${b.name}`, foldPr(sync, prev.get(`sync:${b.name}`)));
        // Head *and* base are this branch, in different repositories — so the head owner is
        // what tells them apart, and a same-named branch in a third fork must not match.
        const offer = offerLists[i]?.data.find(
          (pr) =>
            pr.head.ref === b.name &&
            pr.base.ref === b.name &&
            (pr.head.user?.login ?? '').toLowerCase() === forkOwner.toLowerCase(),
        );
        if (offer) next.set(`offer:${b.name}`, foldPr(offer, prev.get(`offer:${b.name}`)));
      });
      return next;
    });
  }, [upstreamOwner, upstreamRepo, forkOwner, forkName, prefix]);

  /**
   * The fork's parentage. Checked once per scope rather than per poll: it is a property
   * of the repository, not of the work, and the sync action is blocked until it answers.
   */
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void verifyForkParent(
      { owner: forkOwner, repo: forkName },
      { owner: upstreamOwner, repo: upstreamRepo },
    ).then((result) => {
      if (!cancelled) setForkParent(result);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, forkOwner, forkName, upstreamOwner, upstreamRepo]);

  const fetchChecks = useCallback(async () => {
    /**
     * Two different questions, so two different conditions.
     *
     * Check runs settle: once they have all finished there is nothing left to poll, which
     * is what `needsChecks` is for. **Mergeability does not.** It changes when a review
     * lands, when the base branch moves, or when GitHub finishes its own background job —
     * often *after* the last check completed. Gating the detail fetch on `needsChecks` too
     * would freeze the verdict at whatever it read the moment the checks went green, so
     * the strip would say "waiting on required checks" beside a row of ticks.
     *
     * The extra cost is one conditional GET per open pull request, which is a 304 whenever
     * nothing changed. A closed or merged one is terminal and asked about once.
     */
    const targets = [...entries].filter(([, e]) => needsChecks(e) || e.pr.state === 'open');
    if (targets.length === 0) return;

    const updates = await Promise.all(
      targets.map(async ([key, e]) => {
        const sha = e.pr.head.sha;
        const wantChecks = needsChecks(e);
        const [detailRes, crRes, stRes] = await Promise.allSettled([
          ghGet<PullRequest>(pullPath(upstreamOwner, upstreamRepo, e.pr.number)),
          wantChecks
            ? ghGet<CheckRunsResponse>(checkRunsPath(upstreamOwner, upstreamRepo, sha))
            : Promise.reject(new Error('skipped')),
          wantChecks
            ? ghGet<CombinedStatus>(combinedStatusPath(upstreamOwner, upstreamRepo, sha))
            : Promise.reject(new Error('skipped')),
        ]);
        const checkRuns = crRes.status === 'fulfilled' ? crRes.value.data.check_runs : e.checkRuns;
        const combined = stRes.status === 'fulfilled' ? stRes.value.data : e.combined;
        const pr = detailRes.status === 'fulfilled' ? detailRes.value.data : e.pr;
        const err = !wantChecks
          ? e.checksError
          : crRes.status === 'rejected'
            ? crRes.reason
            : stRes.status === 'rejected'
              ? stRes.reason
              : null;
        return {
          key,
          // The head this whole batch describes. Checked again before anything is applied:
          // see the guard below.
          forSha: sha,
          pr,
          checkRuns,
          combined,
          // Only meaningful when the checks were actually re-read; otherwise keep what the
          // last real fetch concluded rather than re-deriving it from stale inputs.
          overall: wantChecks ? combineChecksAndStatus(checkRuns, combined) : e.overall,
          // Preserved so `needsChecks` doesn't see a null and start polling again.
          checksUpdatedAt: wantChecks ? Date.now() : e.checksUpdatedAt,
          error: err instanceof Error ? err.message : err ? String(err) : null,
        };
      }),
    );

    setEntries((prev) => {
      const next = new Map(prev);
      for (const u of updates) {
        const existing = next.get(u.key);
        if (!existing) continue;
        /**
         * Drop the whole update if the head moved while it was in flight.
         *
         * `refreshAll` runs both pollers at once, so after every action a list fetch and
         * this one race. If a commit landed in between, the list has already replaced the
         * entry with a fresh one for the new head — and writing this batch over it would
         * put back the *previous* commit's pull request and checks, together with a
         * non-null `checksUpdatedAt` that stops `needsChecks` asking again. The strip would
         * then show the old commit's results as current until the next list poll, and the
         * auto-rerun engine would be handed a stale head SHA to act on.
         */
        if (existing.pr.head.sha !== u.forSha) continue;

        /**
         * The other direction of the same race: the detail GET came back describing a
         * *newer* head than the checks were asked about. The pull request is the fresher
         * fact and is worth keeping, but its checks now belong to a commit nobody is
         * looking at — so they are dropped rather than shown against the new head, which
         * also makes `needsChecks` fetch the real ones.
         */
        if (u.pr.head.sha !== u.forSha) {
          next.set(u.key, {
            ...existing,
            pr: u.pr,
            checkRuns: [],
            combined: null,
            overall: 'unknown',
            checksUpdatedAt: null,
            checksError: null,
          });
          continue;
        }

        next.set(u.key, {
          ...existing,
          pr: u.pr,
          checkRuns: u.checkRuns,
          combined: u.combined,
          overall: u.overall,
          checksUpdatedAt: u.checksUpdatedAt,
          checksError: u.error,
        });
      }
      return next;
    });
  }, [entries, upstreamOwner, upstreamRepo]);

  const list = usePolling({
    fn: fetchList,
    intervalMs: listIntervalMs,
    enabled,
    op: Operation.GH_FEATURE_BRANCHES_POLL,
  });
  const checks = usePolling({
    fn: fetchChecks,
    intervalMs: checksIntervalMs,
    enabled,
    op: Operation.GH_CHECKS_POLL,
  });

  /**
   * Look again as soon as the coordinates change.
   *
   * The reset above empties the list, but nothing re-arms the poll: `usePolling` keeps a
   * stable runner and its timer depends only on the interval. So editing the prefix or the
   * fork name left the tab asserting "no branch exists in both repositories" — with
   * `lastUpdated` already set, so it read as a finished answer — for up to `prListSeconds`
   * without having looked once.
   */
  useEffect(() => {
    if (enabled) void list.refresh();
    // list.refresh is stable (usePolling returns the memoized runner).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, enabled]);

  // Fetch checks as soon as a pull request appears or its head moves, rather than waiting
  // out the interval — the same prompt-refresh the dashboard does, for the same reason.
  const targetSig = useMemo(
    () =>
      [...entries]
        .map(([key, e]) => `${key}:${e.pr.head.sha}:${e.watchUntil ?? ''}`)
        .join(','),
    [entries],
  );
  useEffect(() => {
    if (enabled && targetSig) void checks.refresh();
    // checks.refresh is stable (usePolling returns the memoized runner).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSig, enabled]);

  const refreshAll = useCallback(() => {
    void list.refresh();
    void checks.refresh();
  }, [list, checks]);

  const invalidateChecks = useCallback((prNumber: number) => {
    const until = Date.now() + RERUN_WATCH_MS;
    setEntries((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [key, e] of prev) {
        if (e.pr.number !== prNumber) continue;
        next.set(key, { ...e, watchUntil: until, checksError: null });
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const rows = useMemo<FeatureBranchRow[]>(
    () =>
      branches.map((branch) => ({
        branch,
        sync: entries.get(`sync:${branch.name}`) ?? null,
        offer: entries.get(`offer:${branch.name}`) ?? null,
        mainStanding: mainStandings.get(branch.name) ?? null,
        // Equal tips need no comparison; an unequal pair reads `unknown` until one arrives.
        standing:
          branch.forkSha === branch.upstreamSha
            ? { state: 'identical', behindBy: 0, aheadBy: 0, ownCommits: 0, filesDiffering: 0 }
            : (standings.get(branch.name) ?? {
                state: 'unknown',
                behindBy: 0,
                aheadBy: 0,
                ownCommits: 0,
                filesDiffering: null,
              }),
      })),
    [branches, entries, standings, mainStandings],
  );

  const prs = useMemo(() => [...entries.values()], [entries]);

  return {
    rows,
    prs,
    repo,
    forkParent,
    truncated,
    enabled,
    listError: list.lastError,
    listUpdatedAt: list.lastUpdated,
    isFetchingList: list.isFetching,
    isFetchingChecks: checks.isFetching,
    refreshAll,
    invalidateChecks,
  };
}

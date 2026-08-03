/**
 * Orchestrates the PR dashboard:
 *  1. Polls the open PR list (slow cadence) and filters to fork -> upstream PRs.
 *  2. Polls a bounded list of recently *merged* PRs in the same cycle, so their
 *     failures stay reviewable after the PR has left the open list.
 *  3. Polls check-runs + combined status for PRs that still need it (never fetched
 *     or still active) at the fast cadence; completed PRs are skipped.
 * Both cadences slow to `hiddenSeconds` when the tab is hidden.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ghGet } from '../api/githubClient';
import {
  checkRunsPath,
  combinedStatusPath,
  headFilter,
  pullsPath,
} from '../api/endpoints';
import type {
  CheckRun,
  CheckRunsResponse,
  CombinedStatus,
  OverallStatus,
  PullRequest,
} from '../api/types';
import {
  effectivePrAuthor,
  isConfigComplete,
  type MonitorConfig,
} from '../storage/configStore';
import { combineChecksAndStatus, isActiveStatus } from '../lib/status';
import { SCAN_WINDOW_MS } from '../lib/failures';
import { detectNewlyCompleted, prPhase } from '../lib/completion';
import { sendNotification } from '../lib/notifications';
import { useConfig } from '../context/ConfigContext';
import { useAuth } from '../context/AuthContext';
import { useVisibility } from './useVisibility';
import { usePolling } from './usePolling';

export interface PrEntry {
  pr: PullRequest;
  overall: OverallStatus;
  checkRuns: CheckRun[];
  combined: CombinedStatus | null;
  checksUpdatedAt: number | null;
  checksError: string | null;
  /**
   * Keep polling this PR's checks until this moment even if they look finished.
   * Set after a re-run is requested — see {@link DashboardState.invalidateChecks}.
   */
  watchUntil: number | null;
}

/**
 * How long to keep watching a PR after a re-run was requested.
 *
 * A window rather than a single forced poll: GitHub takes a few seconds to flip the
 * check-runs back to `queued`, so an immediate re-poll can legitimately still see
 * the old completed+failed payload. One shot would then mark the PR finished again
 * and freeze it on the stale failure — the exact thing this exists to prevent.
 */
const RERUN_WATCH_MS = 2 * 60_000;

/**
 * How long a PR with no checks at all stays interesting.
 *
 * Bounded because plenty of PRs never get checks — docs-only changes, `paths`
 * filters, checks aged out — and an unbounded "keep watching" would poll those two
 * requests per cycle forever. Merged PRs made this common enough to matter.
 */
const UNKNOWN_GRACE_MS = 10 * 60_000;

export interface DashboardState {
  prs: PrEntry[];
  /** Recently-merged PRs, newest first. Empty when `mergedPrs.count` is 0. */
  mergedPrs: PrEntry[];
  listError: Error | null;
  listUpdatedAt: number | null;
  isFetchingList: boolean;
  isFetchingChecks: boolean;
  enabled: boolean;
  refreshAll: () => void;
  /**
   * Watch a PR's checks again for a while, after asking GitHub to re-run them.
   *
   * Needed because `needsChecks` goes permanently false once every check-run has
   * completed, so otherwise nothing would ever look at that PR again and it would
   * show its old `failure` forever.
   */
  invalidateChecks: (prNumber: number) => void;
}

function matchesFork(pr: PullRequest, config: MonitorConfig): boolean {
  const headOwner = (pr.head.user?.login ?? '').toLowerCase();
  if (headOwner !== config.fork.owner.toLowerCase()) return false;
  if (config.fork.branch && pr.head.ref !== config.fork.branch) return false;
  const author = config.prAuthor.trim().toLowerCase();
  if (author && (pr.user?.login ?? '').toLowerCase() !== author) return false;
  return true;
}

/**
 * A PR needs a checks fetch if never fetched, no checks have appeared yet, or any
 * individual check-run / commit status is still running.
 *
 * Note: we must NOT key off the *aggregate* status — that reads `failure` as soon
 * as one check fails (failure has top precedence), which would stop polling while
 * other checks are still in progress and freeze them at their last-seen state.
 */
export function needsChecks(e: PrEntry, now: number = Date.now()): boolean {
  if (e.checksUpdatedAt === null) return true;
  // A re-run was just asked for; watch through the window regardless of how the
  // checks currently read.
  if (e.watchUntil !== null && now < e.watchUntil) return true;
  // No checks discovered yet — keep watching for a while, since CI may register
  // them shortly, but give up eventually (see UNKNOWN_GRACE_MS).
  if (e.overall === 'unknown' && now - e.checksUpdatedAt < UNKNOWN_GRACE_MS) return true;
  if (e.checkRuns.some((c) => isActiveStatus(c.status))) return true;
  if (e.combined && e.combined.total_count > 0 && e.combined.state === 'pending') return true;
  return false;
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
 * Fold a freshly-fetched PR list into existing entries, keeping already-fetched
 * checks only while the head SHA is unchanged (otherwise they describe old code).
 */
function mergeEntries(prev: PrEntry[], incoming: PullRequest[]): PrEntry[] {
  const byNum = new Map(prev.map((e) => [e.pr.number, e]));
  return incoming.map((pr) => {
    const existing = byNum.get(pr.number);
    if (existing && existing.pr.head.sha === pr.head.sha) {
      return { ...existing, pr };
    }
    return newEntry(pr);
  });
}

export function useGitHubDashboard(): DashboardState {
  const { config } = useConfig();
  const { status } = useAuth();
  const visible = useVisibility();
  const enabled = status === 'unlocked' && isConfigComplete(config);

  const [prs, setPrs] = useState<PrEntry[]>([]);
  const [mergedPrs, setMergedPrs] = useState<PrEntry[]>([]);

  const listIntervalMs =
    (visible ? config.polling.prListSeconds : config.polling.hiddenSeconds) * 1000;
  const checksIntervalMs =
    (visible ? config.polling.checksSeconds : config.polling.hiddenSeconds) * 1000;

  // Reset when the watched repo/fork changes so stale PRs don't linger.
  const scopeKey = `${config.upstream.owner}/${config.upstream.repo}|${config.fork.owner}|${config.fork.branch ?? ''}|${effectivePrAuthor(config)}`;
  useEffect(() => {
    setPrs([]);
    setMergedPrs([]);
  }, [scopeKey]);

  const fetchList = useCallback(async () => {
    const { upstream, fork } = config;
    const head = headFilter(fork.owner, fork.branch);
    const { data } = await ghGet<PullRequest[]>(
      pullsPath(upstream.owner, upstream.repo, { head }),
    );
    setPrs((prev) => mergeEntries(prev, data.filter((pr) => matchesFork(pr, config))));

    const count = config.mergedPrs.count;
    if (count === 0) {
      setMergedPrs((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    try {
      // `state=closed` also returns PRs closed without merging, so over-fetch a
      // little and keep the first `count` that actually merged.
      const { data: closed } = await ghGet<PullRequest[]>(
        pullsPath(upstream.owner, upstream.repo, {
          head,
          state: 'closed',
          perPage: Math.min(100, Math.max(count * 3, 30)),
        }),
      );
      // Bounded by age as well as by count: the Failures tab only looks back a week,
      // so an older merged PR would cost two check requests to display nothing.
      const cutoff = Date.now() - SCAN_WINDOW_MS;
      const merged = closed
        .filter(
          (pr) =>
            pr.merged_at !== null &&
            (Date.parse(pr.merged_at) || 0) >= cutoff &&
            matchesFork(pr, config),
        )
        .slice(0, count);
      setMergedPrs((prev) => mergeEntries(prev, merged));
    } catch {
      // Merged PRs are supplementary. Failing the whole poll here would also throw
      // away the open-PR update we just made, so keep whatever we had.
    }
  }, [config]);

  const fetchChecks = useCallback(async () => {
    // Merged PRs are terminal, so each is fetched once and then skipped forever.
    const targets = [...prs, ...mergedPrs].filter(needsChecks);
    if (targets.length === 0) return;
    const { owner, repo } = config.upstream;

    const updates = await Promise.all(
      targets.map(async (e) => {
        const sha = e.pr.head.sha;
        const [crRes, stRes] = await Promise.allSettled([
          ghGet<CheckRunsResponse>(checkRunsPath(owner, repo, sha)),
          ghGet<CombinedStatus>(combinedStatusPath(owner, repo, sha)),
        ]);
        const checkRuns =
          crRes.status === 'fulfilled' ? crRes.value.data.check_runs : e.checkRuns;
        const combined = stRes.status === 'fulfilled' ? stRes.value.data : e.combined;
        const err =
          crRes.status === 'rejected'
            ? crRes.reason
            : stRes.status === 'rejected'
              ? stRes.reason
              : null;
        return {
          number: e.pr.number,
          checkRuns,
          combined,
          overall: combineChecksAndStatus(checkRuns, combined),
          error: err instanceof Error ? err.message : err ? String(err) : null,
        };
      }),
    );

    const byNum = new Map(updates.map((u) => [u.number, u]));
    // Return the same array when this list had no targets, so an unchanged list
    // keeps its identity. Merged PRs are terminal, so without this they'd get a new
    // identity every cycle and re-trigger every downstream derivation forever.
    const applyUpdates = (list: PrEntry[]): PrEntry[] => {
      if (!list.some((e) => byNum.has(e.pr.number))) return list;
      return list.map((e) => {
        const u = byNum.get(e.pr.number);
        if (!u) return e;
        return {
          ...e,
          checkRuns: u.checkRuns,
          combined: u.combined,
          overall: u.overall,
          checksUpdatedAt: Date.now(),
          checksError: u.error,
        };
      });
    };
    // A PR number is in exactly one of the two lists (open vs closed), so these
    // can't fight over the same entry.
    setPrs(applyUpdates);
    setMergedPrs(applyUpdates);
  }, [prs, mergedPrs, config]);

  const list = usePolling({ fn: fetchList, intervalMs: listIntervalMs, enabled });
  const checks = usePolling({ fn: fetchChecks, intervalMs: checksIntervalMs, enabled });

  // Promptly fetch checks when the set of PRs (or their heads) changes, rather than
  // waiting for the next checks tick. `watchUntil` is part of the signature so that
  // arming it in invalidateChecks re-polls straight away with no separate plumbing;
  // merged PRs are included so a newly-merged one doesn't wait out a whole tick.
  const targetSig = useMemo(
    () =>
      [...prs, ...mergedPrs]
        .map((e) => `${e.pr.number}:${e.pr.head.sha}:${e.watchUntil ?? ''}`)
        .join(','),
    [prs, mergedPrs],
  );
  useEffect(() => {
    if (enabled && targetSig) void checks.refresh();
    // checks.refresh is stable (usePolling returns the memoized runner).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSig, enabled]);

  // Desktop notification when a PR's checks finish (opt-in via config).
  const prPhaseRef = useRef<Map<number, boolean>>(new Map());
  const notifyPr = config.notifications.pr;
  useEffect(() => {
    const { completed, next } = detectNewlyCompleted(
      prPhaseRef.current,
      prs,
      (e) => e.pr.number,
      (e) => prPhase(e.overall, e.checksUpdatedAt !== null),
    );
    prPhaseRef.current = next;
    if (!enabled || !notifyPr) return;
    for (const e of completed) {
      sendNotification({
        title: e.overall === 'success' ? 'PR checks passed' : 'PR checks failed',
        body: `#${e.pr.number} ${e.pr.title}`,
        tag: `pr-${e.pr.number}-${e.pr.head.sha}`,
        url: e.pr.html_url,
      });
    }
  }, [prs, enabled, notifyPr]);

  const refreshAll = useCallback(() => {
    void list.refresh();
    void checks.refresh();
  }, [list, checks]);

  // Arming `watchUntil` changes targetSig, so the prompt-refresh effect above
  // already re-polls — no separate plumbing, and no need to evict the ETags either:
  // while the window is open a 304 honestly means "GitHub hasn't changed anything
  // yet" and polling simply continues.
  const invalidateChecks = useCallback((prNumber: number) => {
    const until = Date.now() + RERUN_WATCH_MS;
    const arm = (prev: PrEntry[]): PrEntry[] =>
      prev.map((e) =>
        e.pr.number === prNumber ? { ...e, watchUntil: until, checksError: null } : e,
      );
    setPrs(arm);
    setMergedPrs(arm);
  }, []);

  return {
    prs,
    mergedPrs,
    listError: list.lastError,
    listUpdatedAt: list.lastUpdated,
    isFetchingList: list.isFetching,
    isFetchingChecks: checks.isFetching,
    enabled,
    refreshAll,
    invalidateChecks,
  };
}

/**
 * Orchestrates the PR dashboard:
 *  1. Polls the open PR list (slow cadence) and filters to fork -> upstream PRs.
 *  2. Polls check-runs + combined status for PRs that still need it (never fetched
 *     or still active) at the fast cadence; completed PRs are skipped.
 * Both cadences slow to `hiddenSeconds` when the tab is hidden.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { combineChecksAndStatus } from '../lib/status';
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
}

export interface DashboardState {
  prs: PrEntry[];
  listError: Error | null;
  listUpdatedAt: number | null;
  isFetchingList: boolean;
  isFetchingChecks: boolean;
  enabled: boolean;
  refreshAll: () => void;
}

function matchesFork(pr: PullRequest, config: MonitorConfig): boolean {
  const headOwner = (pr.head.user?.login ?? '').toLowerCase();
  if (headOwner !== config.fork.owner.toLowerCase()) return false;
  if (config.fork.branch && pr.head.ref !== config.fork.branch) return false;
  const author = config.prAuthor.trim().toLowerCase();
  if (author && (pr.user?.login ?? '').toLowerCase() !== author) return false;
  return true;
}

/** A PR needs a checks fetch if never fetched, or if its aggregate is still active. */
function needsChecks(e: PrEntry): boolean {
  if (e.checksUpdatedAt === null) return true;
  return e.overall === 'pending' || e.overall === 'in_progress' || e.overall === 'unknown';
}

function newEntry(pr: PullRequest): PrEntry {
  return {
    pr,
    overall: 'unknown',
    checkRuns: [],
    combined: null,
    checksUpdatedAt: null,
    checksError: null,
  };
}

export function useGitHubDashboard(): DashboardState {
  const { config } = useConfig();
  const { status } = useAuth();
  const visible = useVisibility();
  const enabled = status === 'unlocked' && isConfigComplete(config);

  const [prs, setPrs] = useState<PrEntry[]>([]);

  const listIntervalMs =
    (visible ? config.polling.prListSeconds : config.polling.hiddenSeconds) * 1000;
  const checksIntervalMs =
    (visible ? config.polling.checksSeconds : config.polling.hiddenSeconds) * 1000;

  // Reset when the watched repo/fork changes so stale PRs don't linger.
  const scopeKey = `${config.upstream.owner}/${config.upstream.repo}|${config.fork.owner}|${config.fork.branch ?? ''}|${effectivePrAuthor(config)}`;
  useEffect(() => {
    setPrs([]);
  }, [scopeKey]);

  const fetchList = useCallback(async () => {
    const { upstream, fork } = config;
    const head = headFilter(fork.owner, fork.branch);
    const { data } = await ghGet<PullRequest[]>(
      pullsPath(upstream.owner, upstream.repo, { head }),
    );
    const filtered = data.filter((pr) => matchesFork(pr, config));
    setPrs((prev) => {
      const byNum = new Map(prev.map((e) => [e.pr.number, e]));
      return filtered.map((pr) => {
        const existing = byNum.get(pr.number);
        // Keep checks only if the head SHA is unchanged; otherwise it's stale.
        if (existing && existing.pr.head.sha === pr.head.sha) {
          return { ...existing, pr };
        }
        return newEntry(pr);
      });
    });
  }, [config]);

  const fetchChecks = useCallback(async () => {
    const targets = prs.filter(needsChecks);
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
    setPrs((prev) =>
      prev.map((e) => {
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
      }),
    );
  }, [prs, config]);

  const list = usePolling({ fn: fetchList, intervalMs: listIntervalMs, enabled });
  const checks = usePolling({ fn: fetchChecks, intervalMs: checksIntervalMs, enabled });

  // Promptly fetch checks when the set of PRs (or their heads) changes,
  // rather than waiting for the next checks tick.
  const targetSig = useMemo(
    () => prs.map((e) => `${e.pr.number}:${e.pr.head.sha}`).join(','),
    [prs],
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

  return {
    prs,
    listError: list.lastError,
    listUpdatedAt: list.lastUpdated,
    isFetchingList: list.isFetching,
    isFetchingChecks: checks.isFetching,
    enabled,
    refreshAll,
  };
}

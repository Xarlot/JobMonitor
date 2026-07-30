/**
 * Turns the configured flows into the flows the app actually shows: a regex
 * (pattern) flow is replaced by one flow per matching workflow of its repo.
 *
 * Fetching the workflow list is the only extra I/O — one ETag-cached request per
 * distinct repo referenced by a pattern flow, re-polled rarely (workflows are
 * added far less often than runs happen). Everything downstream (the runtime,
 * groups, drag & drop, filters) works on the resolved list and needs no idea that
 * patterns exist.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchWorkflows } from '../api/workflows';
import type { Workflow } from '../api/types';
import {
  compileFlowPattern,
  expandFlows,
  flowRepoRef,
  isPatternFlow,
  matchWorkflows,
  repoKey,
  type ResolvedFlow,
} from '../lib/flowPatterns';
import { isConfigComplete } from '../storage/configStore';
import { useAuth } from './AuthContext';
import { useConfig } from './ConfigContext';
import { usePolling } from '../hooks/usePolling';

const WORKFLOWS_POLL_MS = 15 * 60_000;

export interface PatternStatus {
  /** The repo's workflow list hasn't arrived yet. */
  loading: boolean;
  /** Bad regex, or the workflow list failed to load. */
  error: string | null;
  /** How many workflows the pattern matches now; null until resolved. */
  matches: number | null;
}

interface ResolvedFlowsValue {
  /** `config.flows` with every pattern flow replaced by its matches. */
  flows: ResolvedFlow[];
  /** Status per pattern flow id (configured pattern flows only). */
  patterns: Map<string, PatternStatus>;
  /** True while at least one pattern is still waiting for its workflow list. */
  resolving: boolean;
  /** Re-read the workflow lists (picks up newly added workflows). */
  refresh: () => void;
}

const ResolvedFlowsContext = createContext<ResolvedFlowsValue | null>(null);

export function ResolvedFlowsProvider({ children }: { children: ReactNode }) {
  const { config } = useConfig();
  const { status } = useAuth();
  const enabled = status === 'unlocked' && isConfigComplete(config);

  // Distinct repos the pattern flows point at (a plain flow needs no list).
  const repos = useMemo(() => {
    const out = new Map<string, { owner: string; repo: string }>();
    for (const flow of config.flows) {
      if (!isPatternFlow(flow)) continue;
      const ref = flowRepoRef(flow, config.upstream);
      if (ref.owner && ref.repo) out.set(repoKey(ref.owner, ref.repo), ref);
    }
    return out;
  }, [config.flows, config.upstream]);
  const reposKey = [...repos.keys()].sort().join(',');

  const [lists, setLists] = useState<Record<string, Workflow[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const results = await Promise.all(
      [...repos.values()].map(async (ref) => {
        const key = repoKey(ref.owner, ref.repo);
        try {
          return { key, workflows: await fetchWorkflows(ref.owner, ref.repo), error: null };
        } catch (e) {
          return { key, workflows: null, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    setLists((prev) => {
      const next = { ...prev };
      for (const r of results) if (r.workflows) next[r.key] = r.workflows;
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      for (const r of results) {
        if (r.error) next[r.key] = r.error;
        else delete next[r.key];
      }
      return next;
    });
    // A repo that fails keeps its previous list (a stale board beats an empty one).
  }, [repos]);

  const poll = usePolling({
    fn: load,
    intervalMs: WORKFLOWS_POLL_MS,
    enabled: enabled && repos.size > 0,
  });

  // Fetch right away when a new repo enters the set (a pattern flow was added or
  // re-pointed); editing the pattern itself only re-filters the cached list.
  useEffect(() => {
    if (enabled && reposKey) poll.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reposKey]);

  const flows = useMemo(
    () =>
      expandFlows(config.flows, (flow) => {
        const ref = flowRepoRef(flow, config.upstream);
        return lists[repoKey(ref.owner, ref.repo)];
      }),
    [config.flows, config.upstream, lists],
  );

  const patterns = useMemo(() => {
    const map = new Map<string, PatternStatus>();
    for (const flow of config.flows) {
      if (!isPatternFlow(flow)) continue;
      const ref = flowRepoRef(flow, config.upstream);
      const key = repoKey(ref.owner, ref.repo);
      const list = lists[key];
      const patternError = compileFlowPattern(flow.match).error;
      const error = patternError ?? errors[key] ?? null;
      map.set(flow.id, {
        loading: !list && !error,
        error,
        matches: list ? matchWorkflows(list, flow.match).length : null,
      });
    }
    return map;
  }, [config.flows, config.upstream, lists, errors]);

  const value = useMemo<ResolvedFlowsValue>(
    () => ({
      flows,
      patterns,
      resolving: [...patterns.values()].some((p) => p.loading),
      refresh: poll.refresh,
    }),
    [flows, patterns, poll.refresh],
  );

  return <ResolvedFlowsContext.Provider value={value}>{children}</ResolvedFlowsContext.Provider>;
}

export function useResolvedFlows(): ResolvedFlowsValue {
  const ctx = useContext(ResolvedFlowsContext);
  if (!ctx) throw new Error('useResolvedFlows must be used within ResolvedFlowsProvider');
  return ctx;
}

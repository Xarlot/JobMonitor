/**
 * Drives a single configured flow: polls its workflow runs (master rows) across
 * the configured branch x event matrix, lazily loads jobs (detail rows) on
 * expand, refreshes jobs for active/expanded runs, and reconciles expand state
 * so re-runs / new commits collapse + invalidate stale detail.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ghGet, evictFromCache } from '../api/githubClient';
import { runArtifactsPath, runJobsPath, workflowRunsPath, workflowsPath } from '../api/endpoints';
import { fetchAllRunJobs } from '../api/jobs';
import type {
  ArtifactsResponse,
  Job,
  OverallStatus,
  WorkflowRun,
  WorkflowRunsResponse,
  WorkflowsResponse,
} from '../api/types';
import { emptyFilterNeedsArtifacts, emptyFilterNeedsLatestJobs } from '../lib/flowEmptiness';
import { detectNewlyCompleted, runConclusionLabel, runPhase } from '../lib/completion';
import { sendNotification } from '../lib/notifications';
import { aggregateStatuses, isActiveStatus, statusToOverall } from '../lib/status';
import { hasYamlExt, isNumericId, matchWorkflow, workflowBasename } from '../lib/workflow';
import { isConfigComplete, type Flow } from '../storage/configStore';
import { useConfig } from '../context/ConfigContext';
import { useAuth } from '../context/AuthContext';
import { isJobFilterActive, useFlowsFilter } from '../context/FlowsFilterContext';
import { loadFlowRuns, saveFlowRuns } from '../storage/flowRunsCache';
import { useVisibility } from './useVisibility';
import { usePolling } from './usePolling';
import { useExpandState } from './useExpandState';

export interface JobsCacheEntry {
  jobs: Job[];
  /** `${run_attempt}:${head_sha}:${status}` at the time jobs were fetched. */
  fetchedFp: string;
  loading: boolean;
  error: string | null;
}

export interface FlowState {
  /** Effective owner/repo (flow override or upstream default). */
  owner: string;
  repo: string;
  runs: WorkflowRun[];
  overall: OverallStatus;
  jobsByRun: Record<number, JobsCacheEntry>;
  isExpanded: (runId: number) => boolean;
  onToggleRun: (run: WorkflowRun) => void;
  isFetchingRuns: boolean;
  runsError: Error | null;
  runsUpdatedAt: number | null;
  refresh: () => void;
  /** Total non-expired artifact bytes of the latest run; null if unknown/not fetched. */
  latestArtifactBytes: number | null;
}

function jobFingerprint(run: WorkflowRun): string {
  return `${run.run_attempt}:${run.head_sha}:${run.status}`;
}

export function useFlow(flow: Flow): FlowState {
  const { config } = useConfig();
  const { status } = useAuth();
  const visible = useVisibility();
  const enabled = status === 'unlocked' && isConfigComplete(config);

  const { filter } = useFlowsFilter();
  const jobFilterActive = isJobFilterActive(filter);
  const needLatestJobs = emptyFilterNeedsLatestJobs(flow.emptyFilter);

  const owner = flow.owner || config.upstream.owner;
  const repo = flow.repo || config.upstream.repo;

  // Hydrate from the persisted cache so the grid shows immediately on reload.
  const [runs, setRuns] = useState<WorkflowRun[]>(() => loadFlowRuns(flow.id) ?? []);
  const [jobsByRun, setJobsByRun] = useState<Record<number, JobsCacheEntry>>({});
  const expand = useExpandState(flow.id);

  const runsIntervalMs =
    (visible ? config.polling.flowRunsSeconds : config.polling.hiddenSeconds) * 1000;
  const jobsIntervalMs =
    (visible ? config.polling.checksSeconds : config.polling.hiddenSeconds) * 1000;

  // Branch x event query matrix (empty events => one query per branch, any event).
  const queries = useMemo(() => {
    const out: { branch: string; event?: string }[] = [];
    for (const branch of flow.branches) {
      if (flow.events.length === 0) out.push({ branch });
      else for (const event of flow.events) out.push({ branch, event });
    }
    return out;
  }, [flow.branches, flow.events]);

  // Signature of the current run set (id + attempt + head) for reconcile/refresh effects.
  const runsSig = useMemo(
    () => runs.map((r) => `${r.id}:${r.run_attempt}:${r.head_sha}`).join(','),
    [runs],
  );

  // Cache the resolved workflow id/file so we don't re-resolve every poll.
  const resolvedRef = useRef<{ key: string; ref: string } | null>(null);

  const resolveWorkflowRef = useCallback(async (): Promise<string> => {
    const raw = flow.workflowFile.trim();
    if (isNumericId(raw)) return raw;

    const key = `${owner}/${repo}/${raw}`;
    if (resolvedRef.current?.key === key) return resolvedRef.current.ref;

    let workflows: WorkflowsResponse['workflows'] | null = null;
    try {
      const { data } = await ghGet<WorkflowsResponse>(workflowsPath(owner, repo));
      workflows = data.workflows;
    } catch {
      workflows = null; // Actions list unavailable; fall back below.
    }

    if (workflows) {
      const match = matchWorkflow(workflows, raw);
      if (match) {
        const ref = String(match.id);
        resolvedRef.current = { key, ref };
        return ref;
      }
    }
    // Trust an explicit "*.yml" file even if we couldn't list workflows.
    if (hasYamlExt(raw)) return raw;
    const available = workflows?.map((w) => workflowBasename(w.path)).join(', ');
    throw new Error(
      available
        ? `Workflow "${raw}" not found. Available: ${available}`
        : `Workflow "${raw}" not found — use the file name (e.g. ci.yml) or its numeric id.`,
    );
  }, [flow.workflowFile, owner, repo]);

  const fetchRuns = useCallback(async () => {
    const workflowRef = await resolveWorkflowRef();
    const results = await Promise.allSettled(
      queries.map((q) =>
        ghGet<WorkflowRunsResponse>(
          workflowRunsPath(owner, repo, workflowRef, {
            branch: q.branch,
            event: q.event,
            perPage: flow.maxRuns,
          }),
        ),
      ),
    );
    // On a total failure keep the cached/previous runs rather than blanking them.
    if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
      throw (results[0] as PromiseRejectedResult).reason;
    }
    // Keep up to maxRuns *per (branch × event) query*, then merge. A global slice
    // would let a high-frequency event (e.g. push) crowd out rarer events like
    // workflow_dispatch, hiding their runs entirely.
    const merged = new Map<number, WorkflowRun>();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const run of r.value.data.workflow_runs.slice(0, flow.maxRuns)) {
        merged.set(run.id, run);
      }
    }
    const sorted = [...merged.values()].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
    setRuns(sorted);
    saveFlowRuns(flow.id, sorted);
  }, [queries, owner, repo, flow.id, flow.maxRuns, resolveWorkflowRef]);

  const runsPoll = usePolling({ fn: fetchRuns, intervalMs: runsIntervalMs, enabled });

  const loadJobs = useCallback(
    async (run: WorkflowRun) => {
      setJobsByRun((prev) => ({
        ...prev,
        [run.id]: {
          jobs: prev[run.id]?.jobs ?? [],
          fetchedFp: prev[run.id]?.fetchedFp ?? '',
          loading: !prev[run.id],
          error: null,
        },
      }));
      try {
        const jobs = await fetchAllRunJobs(owner, repo, run.id);
        setJobsByRun((prev) => ({
          ...prev,
          [run.id]: { jobs, fetchedFp: jobFingerprint(run), loading: false, error: null },
        }));
      } catch (e) {
        setJobsByRun((prev) => ({
          ...prev,
          [run.id]: {
            jobs: prev[run.id]?.jobs ?? [],
            fetchedFp: prev[run.id]?.fetchedFp ?? '',
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [owner, repo],
  );

  // Refresh jobs for runs we need: expanded runs always; every run when the
  // interactive job filter is active; and the latest run when the per-flow empty
  // filter evaluates a job condition.
  const pollJobs = useCallback(async () => {
    const expanded = new Set(expand.expandedRunIds);
    const latestId = runs[0]?.id;
    const targets = runs.filter((r) => {
      const wanted =
        jobFilterActive || expanded.has(r.id) || (needLatestJobs && r.id === latestId);
      if (!wanted) return false;
      const cache = jobsByRun[r.id];
      if (!cache || cache.fetchedFp !== jobFingerprint(r)) return true;
      return isActiveStatus(r.status);
    });
    await Promise.all(targets.map(loadJobs));
  }, [runs, jobsByRun, expand.expandedRunIds, loadJobs, jobFilterActive, needLatestJobs]);

  const jobsPoll = usePolling({ fn: pollJobs, intervalMs: jobsIntervalMs, enabled });

  // Fetch jobs promptly when a job-based filter turns on or the run set changes.
  useEffect(() => {
    if (enabled && (jobFilterActive || needLatestJobs)) void jobsPoll.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, jobFilterActive, needLatestJobs, runsSig]);

  // Reconcile persisted expand state when the run set changes; drop invalidated caches.
  useEffect(() => {
    if (runs.length === 0) return;
    const invalidated = expand.reconcile(
      runs.map((r) => ({ id: r.id, run_attempt: r.run_attempt, head_sha: r.head_sha })),
    );
    if (invalidated.length > 0) {
      setJobsByRun((prev) => {
        const next = { ...prev };
        for (const id of invalidated) {
          delete next[id];
          evictFromCache(runJobsPath(owner, repo, id));
        }
        return next;
      });
    }
    // expand.reconcile is stable for a given flow id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsSig, owner, repo]);

  const onToggleRun = useCallback(
    (run: WorkflowRun) => {
      const willExpand = !expand.expandedRunIds.includes(run.id);
      expand.toggle(run.id);
      if (willExpand && !jobsByRun[run.id]) void loadJobs(run);
    },
    [expand, jobsByRun, loadJobs],
  );

  const overall = useMemo(
    () => aggregateStatuses(runs.map((r) => statusToOverall(r.status, r.conclusion))),
    [runs],
  );

  // Desktop notification when a run in this flow finishes (opt-in via config).
  const runPhaseRef = useRef<Map<number, boolean>>(new Map());
  const notifyFlow = config.notifications.flow;
  useEffect(() => {
    const { completed, next } = detectNewlyCompleted(
      runPhaseRef.current,
      runs,
      (r) => r.id,
      (r) => runPhase(r.status),
    );
    runPhaseRef.current = next;
    if (!enabled || !notifyFlow) return;
    for (const run of completed) {
      sendNotification({
        title: `${flow.name}: run ${runConclusionLabel(run.conclusion)}`,
        body: run.display_title || run.name || `Run #${run.run_number}`,
        tag: `flow-${flow.id}-run-${run.id}-${run.run_attempt}`,
        url: run.html_url,
      });
    }
  }, [runs, enabled, notifyFlow, flow.name, flow.id]);

  // Fetch the latest completed run's total artifact size, but only when the
  // empty-flow filter is set to evaluate by artifacts (one cached request/flow).
  const [latestArtifactBytes, setLatestArtifactBytes] = useState<number | null>(null);
  const latest = runs[0];
  const needArtifacts = emptyFilterNeedsArtifacts(flow.emptyFilter);
  const artifactRunId =
    needArtifacts && latest && latest.status === 'completed' ? latest.id : null;
  useEffect(() => {
    if (!enabled || artifactRunId == null) {
      setLatestArtifactBytes(null);
      return;
    }
    let active = true;
    ghGet<ArtifactsResponse>(runArtifactsPath(owner, repo, artifactRunId))
      .then(({ data }) => {
        if (!active) return;
        const bytes = data.artifacts
          .filter((a) => !a.expired)
          .reduce((n, a) => n + a.size_in_bytes, 0);
        setLatestArtifactBytes(bytes);
      })
      .catch(() => {
        if (active) setLatestArtifactBytes(null);
      });
    return () => {
      active = false;
    };
  }, [enabled, artifactRunId, owner, repo]);

  return {
    owner,
    repo,
    runs,
    overall,
    jobsByRun,
    isExpanded: expand.isExpanded,
    onToggleRun,
    isFetchingRuns: runsPoll.isFetching,
    runsError: runsPoll.lastError,
    runsUpdatedAt: runsPoll.lastUpdated,
    refresh: runsPoll.refresh,
    latestArtifactBytes,
  };
}

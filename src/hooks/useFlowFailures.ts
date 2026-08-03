/**
 * Failing jobs of the flows on the board, for the Failures tab.
 *
 * Flows differ from pull requests in two ways that shape this:
 *
 *  - A flow's jobs are **lazily loaded** — `useFlow` only fetches them for expanded
 *    runs, an active job filter, or the per-flow empty filter. So the jobs of a
 *    failing run generally aren't in memory, and this hook fetches them itself.
 *  - A flow tracks several recent runs, but only its **latest** run says whether it
 *    needs attention right now (that is what the Overview shows). Listing failures
 *    from older runs would bury today's break under last week's, so only the latest
 *    run is considered.
 *
 * Cost is therefore one request per flow whose latest run failed, keyed so a run is
 * fetched once per attempt, and capped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchAllRunJobs } from '../api/jobs';
import type { Job } from '../api/types';
import {
  isFailingJob,
  isFailingRun,
  withinScanWindow,
  type FlowFailureSource,
} from '../lib/failures';
import { flowRunJobsCache, flowRunJobsKey } from '../storage/failureCaches';
import { useFlowStates } from '../context/FlowsRuntimeContext';
import { useResolvedFlows } from '../context/ResolvedFlowsContext';

/** Ceiling on concurrent job fetches, so a board of red flows stays polite. */
const MAX_FLOW_JOB_FETCH = 8;

interface RunJobs {
  jobs: Job[];
  /** `${runId}:${run_attempt}` the jobs were fetched for. */
  fetchedFor: string;
}

/** What we need about a flow whose latest run failed, before its jobs are known. */
interface Candidate {
  flowId: string;
  flowName: string;
  owner: string;
  repo: string;
  run: FlowFailureSource['run'];
  /** Identity of the run attempt, so a re-run refetches. */
  attemptKey: string;
}

export function useFlowFailures(): FlowFailureSource[] {
  const { flows } = useResolvedFlows();
  const states = useFlowStates();
  /**
   * Seeded from the week-long cache: a finished run's job list never changes, and the
   * cache is keyed by run *attempt*, so a re-run misses rather than being served the
   * previous attempt. This is what makes returning to the Failures tab free.
   */
  const [jobsByRun, setJobsByRun] = useState<Record<number, RunJobs>>(() => {
    const seeded: Record<number, RunJobs> = {};
    for (const [key, jobs] of flowRunJobsCache.entries()) {
      const runId = Number(key.split(':')[0]);
      if (Number.isFinite(runId)) seeded[runId] = { jobs, fetchedFor: key };
    }
    return seeded;
  });

  const nameById = useMemo(
    () => new Map(flows.map((f) => [f.id, f.name])),
    [flows],
  );

  /** Flows whose latest run failed — the only ones worth spending a request on. */
  const candidates = useMemo(() => {
    const now = Date.now();
    const out: Candidate[] = [];
    for (const [flowId, state] of states) {
      const run = state.runs[0];
      if (!run || !isFailingRun(run)) continue;
      // Outside the scan window the failure wouldn't be listed anyway, so don't
      // spend a job-list request discovering that. A nightly that has been red for
      // a month otherwise costs a request per poll forever.
      if (!withinScanWindow(Date.parse(run.updated_at) || 0, now)) continue;
      out.push({
        flowId,
        flowName: nameById.get(flowId) ?? flowId,
        owner: state.owner,
        repo: state.repo,
        run,
        attemptKey: flowRunJobsKey(run.id, run.run_attempt),
      });
    }
    return out;
  }, [states, nameById]);

  // Keyed by attempt so a re-run refetches, and so a poll that changes nothing
  // doesn't. Signature over the candidate set drives the effect.
  const candidateSig = candidates.map((c) => `${c.flowId}@${c.attemptKey}`).join(',');

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (pending: Candidate[]) => {
    const results = await Promise.all(
      pending.map(async (c) => {
        try {
          return { runId: c.run.id, jobs: await fetchAllRunJobs(c.owner, c.repo, c.run.id), key: c.attemptKey };
        } catch {
          // A run whose jobs can't be read simply contributes nothing.
          return { runId: c.run.id, jobs: [] as Job[], key: c.attemptKey };
        }
      }),
    );
    if (!mounted.current) return;
    // Only remember runs that actually yielded jobs; an empty list is a failed read,
    // not a fact about the run.
    flowRunJobsCache.setMany(
      results.filter((r) => r.jobs.length > 0).map((r) => [r.key, r.jobs] as [string, Job[]]),
    );
    setJobsByRun((prev) => {
      const next = { ...prev };
      for (const r of results) next[r.runId] = { jobs: r.jobs, fetchedFor: r.key };
      return next;
    });
  }, []);

  useEffect(() => {
    const pending = candidates
      .filter((c) => jobsByRun[c.run.id]?.fetchedFor !== c.attemptKey)
      .slice(0, MAX_FLOW_JOB_FETCH);
    if (pending.length > 0) void load(pending);
    // Keyed by candidateSig; `jobsByRun` is read to skip what's already fetched,
    // and including it as a dep would loop on its own update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateSig, load]);

  // Forget runs that are no longer any flow's failing latest run.
  useEffect(() => {
    const live = new Set(candidates.map((c) => c.run.id));
    setJobsByRun((prev) => {
      const keys = Object.keys(prev).map(Number);
      if (keys.every((k) => live.has(k))) return prev;
      const next: Record<number, RunJobs> = {};
      for (const k of keys) if (live.has(k)) next[k] = prev[k];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateSig]);

  return useMemo(
    () =>
      candidates
        .map((c) => ({
          flowId: c.flowId,
          flowName: c.flowName,
          owner: c.owner,
          repo: c.repo,
          run: c.run,
          jobs: jobsByRun[c.run.id]?.jobs ?? [],
        }))
        // A run that failed with no failing job of its own (e.g. a startup failure)
        // has nothing to report per-worker, so it drops out rather than showing an
        // empty group.
        .filter((s) => s.jobs.some(isFailingJob)),
    [candidates, jobsByRun],
  );
}

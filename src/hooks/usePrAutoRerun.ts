/**
 * The auto-rerun engine: the only thing in the app that writes to GitHub.
 *
 * Per tick it walks the open PRs that have auto-merge armed, finds their workflow
 * runs for the configured workflow files, and asks GitHub to re-run the failed jobs
 * of any run that has finished badly — subject to the policy in lib/autoRerun.ts.
 *
 * Cost discipline matters, because this runs on the checks cadence forever:
 *  - a PR without auto-merge costs nothing (no request at all);
 *  - the runs lookup is one ETag-cached request per candidate PR, so the steady
 *    state is a free 304;
 *  - jobs and annotations are only fetched for a run that has actually failed and
 *    is otherwise eligible.
 *
 * Safety is layered rather than trusted to the UI: the engine re-checks token
 * capability itself, because `prAutoRerun.enabled` is persisted and a user can
 * swap a writable token for a read-only one at any time.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ghGet, GitHubApiError } from '../api/githubClient';
import { repoRunsPath } from '../api/endpoints';
import { fetchJobAnnotations } from '../api/annotations';
import { fetchAllRunJobs } from '../api/jobs';
import { rerunFailedJobs } from '../api/workflows';
import { getRateLimit, isThrottled } from '../api/rateLimit';
import type { Job, WorkflowRun, WorkflowRunsResponse } from '../api/types';
import {
  decideRerun,
  matchesWorkflowFile,
  RETRYABLE_CONCLUSIONS,
  SKIP_REASON_LABEL,
} from '../lib/autoRerun';
import {
  failureFingerprint,
  mergeSignatures,
  signatureFromAnnotations,
} from '../lib/failureReport';
import { failedStepName } from '../lib/failures';
import { workflowBasename } from '../lib/workflow';
import { sendNotification } from '../lib/notifications';
import { loadRerunRecords, recordRerun } from '../storage/rerunStore';
import { useConfig } from '../context/ConfigContext';
import { useTokenCapability } from './useTokenCapability';
import { useVisibility } from './useVisibility';
import { usePolling } from './usePolling';
import type { PrEntry } from './useGitHubDashboard';

/** One thing the engine did, for the activity log in the UI. */
export interface RerunEvent {
  id: string;
  at: number;
  prNumber: number;
  prTitle: string;
  runId: number;
  runUrl: string | null;
  workflowFile: string | null;
  attempt: number;
  outcome: 'requested' | 'failed';
  /** Failure detail when `outcome` is 'failed'. */
  detail?: string;
}

export interface AutoRerunState {
  /** Most recent actions first, capped. */
  events: RerunEvent[];
  /** Why the engine is idle, when it is — for the UI hint. */
  idleReason: 'off' | 'no-workflows' | 'no-permission' | 'throttled' | 'armed';
}

/** Don't let one tick fire an unbounded burst of writes. */
const MAX_RERUNS_PER_TICK = 3;
/** Runs to consider per PR head. A commit rarely has more than a handful. */
const RUNS_PER_PR = 50;
/** Cap annotation lookups when building a fingerprint for a badly-broken run. */
const MAX_FINGERPRINT_JOBS = 10;
const MAX_EVENTS = 50;

function isFailedJob(job: Job): boolean {
  return job.status === 'completed' && RETRYABLE_CONCLUSIONS.has(job.conclusion);
}

/**
 * Fingerprint of what failed in a run, from its failed jobs' annotations.
 *
 * Annotations rather than raw logs: they *are* the failure content (test name plus
 * message) with far less noise, and pulling logs for every failed job on every poll
 * would be far too heavy here. Returns null when nothing could be gathered, which
 * decideRerun reads as "unknown" rather than "same as last time".
 */
async function fingerprintRun(
  owner: string,
  repo: string,
  runId: number,
): Promise<string | null> {
  let jobs: Job[];
  try {
    jobs = await fetchAllRunJobs(owner, repo, runId);
  } catch {
    return null;
  }
  const failed = jobs.filter(isFailedJob).slice(0, MAX_FINGERPRINT_JOBS);
  if (failed.length === 0) return null;

  const parts = await Promise.all(
    failed.map(async (job) =>
      // No annotations is fine: job + step names still fingerprint, if coarsely.
      signatureFromAnnotations(
        job.name,
        failedStepName(job),
        await fetchJobAnnotations(owner, repo, job),
      ),
    ),
  );

  return failureFingerprint(mergeSignatures(parts));
}

export function usePrAutoRerun(
  prs: readonly PrEntry[],
  invalidateChecks: (prNumber: number) => void,
): AutoRerunState {
  const { config } = useConfig();
  const capability = useTokenCapability();
  const visible = useVisibility();
  const [events, setEvents] = useState<RerunEvent[]>([]);

  const settings = config.prAutoRerun;
  const notify = config.notifications.autoRerun;
  const { owner, repo } = config.upstream;

  const canWrite = capability.canRerun;

  /**
   * Why the engine is sitting idle, if it is. `armed` is derived from this rather
   * than restating the same three conditions: being throttled must not disarm the
   * poll, since the tick itself is what waits out the limit.
   */
  const idleReason: AutoRerunState['idleReason'] = !settings.enabled
    ? 'off'
    : !canWrite
      ? 'no-permission'
      : settings.workflowFiles.length === 0
        ? 'no-workflows'
        : isThrottled(getRateLimit())
          ? 'throttled'
          : 'armed';
  const armed = idleReason === 'armed' || idleReason === 'throttled';

  const addEvent = useCallback((event: RerunEvent) => {
    setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  const tick = useCallback(async () => {
    if (!armed) return;
    // Writes are the likeliest trigger for GitHub's secondary limits, and nothing
    // else in the app gates on throttling — so this engine must.
    if (isThrottled(getRateLimit())) return;

    const candidates = prs.filter((e) => e.pr.auto_merge != null);
    if (candidates.length === 0) return;

    const records = loadRerunRecords();
    let fired = 0;

    for (const entry of candidates) {
      if (fired >= MAX_RERUNS_PER_TICK) break;

      let runs: WorkflowRun[];
      try {
        const { data } = await ghGet<WorkflowRunsResponse>(
          repoRunsPath(owner, repo, { headSha: entry.pr.head.sha, perPage: RUNS_PER_PR }),
        );
        runs = data.workflow_runs;
      } catch {
        continue; // transient; the next tick tries again
      }

      // Cheap filters first, so a run we'd never touch costs no further requests.
      const eligible = runs.filter(
        (run) =>
          matchesWorkflowFile(run, settings.workflowFiles) &&
          run.status === 'completed' &&
          RETRYABLE_CONCLUSIONS.has(run.conclusion),
      );

      for (const run of eligible) {
        if (fired >= MAX_RERUNS_PER_TICK) break;

        // Re-check the parts that don't need I/O before paying for a fingerprint.
        const preflight = decideRerun({
          run,
          pr: entry.pr,
          settings,
          record: records.get(run.id),
          fingerprint: null,
          now: Date.now(),
        });
        // Fingerprint-dependent rules can't fire on a pre-pass that has no
        // fingerprint, so any refusal here is final.
        if (!preflight.rerun) continue;

        const fingerprint = settings.stopOnIdenticalFailure
          ? await fingerprintRun(owner, repo, run.id)
          : null;

        const decision = decideRerun({
          run,
          pr: entry.pr,
          settings,
          record: records.get(run.id),
          fingerprint,
          now: Date.now(),
        });
        if (!decision.rerun) {
          // Remember a terminal verdict so we don't re-derive it (and re-fetch
          // annotations for it) on every tick from now on.
          if (decision.reason === 'identical_failure') {
            recordRerun(run.id, {
              attempt: run.run_attempt,
              fingerprint,
              at: Date.now(),
              ok: false,
              error: SKIP_REASON_LABEL[decision.reason],
            });
          }
          continue;
        }

        fired += 1;
        await requestRerun({
          entry, run, fingerprint, owner, repo,
          notify,
          addEvent,
          invalidateChecks,
        });
      }
    }
    // `prs` and `notify` are read directly rather than through refs: usePolling
    // keeps the latest fn in a ref and its timer deps don't include it, so a new
    // `tick` identity never re-arms the interval.
  }, [armed, owner, repo, settings, prs, notify, addEvent, invalidateChecks]);

  const intervalMs =
    (visible ? config.polling.checksSeconds : config.polling.hiddenSeconds) * 1000;
  const { refresh } = usePolling({ fn: tick, intervalMs, enabled: armed });

  /**
   * React as soon as a candidate PR appears or its checks change, rather than
   * waiting out the interval. Without this the first tick runs before the PR list
   * has even loaded, and a failure sitting there would go untouched for a full
   * `checksSeconds`. Mirrors the `targetSig` prompt-refresh in useGitHubDashboard.
   *
   * The signature covers `overall` so the re-check happens when a run *finishes*,
   * not merely when the PR is first seen.
   */
  const candidateSig = useMemo(
    () =>
      prs
        .filter((e) => e.pr.auto_merge != null)
        .map((e) => `${e.pr.number}:${e.pr.head.sha}:${e.overall}`)
        .join(','),
    [prs],
  );
  useEffect(() => {
    if (armed && candidateSig) void refresh();
    // refresh is stable (usePolling returns the memoized runner).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateSig, armed]);

  return { events, idleReason };
}

/** Issue the write and record what happened, whichever way it goes. */
async function requestRerun(args: {
  entry: PrEntry;
  run: WorkflowRun;
  fingerprint: string | null;
  owner: string;
  repo: string;
  notify: boolean;
  addEvent: (e: RerunEvent) => void;
  invalidateChecks: (prNumber: number) => void;
}): Promise<void> {
  const { entry, run, fingerprint, owner, repo, notify, addEvent, invalidateChecks } = args;
  const workflowFile = run.path ? workflowBasename(run.path) : null;
  const at = Date.now();
  const base = {
    id: `${run.id}-${run.run_attempt}-${at}`,
    at,
    prNumber: entry.pr.number,
    prTitle: entry.pr.title,
    runId: run.id,
    runUrl: run.html_url,
    workflowFile,
    attempt: run.run_attempt,
  };

  try {
    await rerunFailedJobs(owner, repo, run.id);
    recordRerun(run.id, { attempt: run.run_attempt, fingerprint, at, ok: true });
    addEvent({ ...base, outcome: 'requested' });
    // The PR's checks are complete as far as the dashboard knows, so without this
    // it would never look at them again and would show the old failure forever.
    invalidateChecks(entry.pr.number);
    if (notify) {
      sendNotification({
        title: 'Re-running failed jobs',
        body:
          `#${entry.pr.number} ${entry.pr.title}` +
          `${workflowFile ? ` · ${workflowFile}` : ''} · attempt ${run.run_attempt + 1}`,
        tag: `rerun-${run.id}-${run.run_attempt}`,
        url: run.html_url,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const refusal = err instanceof GitHubApiError ? err.refusal : undefined;

    // A rate limit is the one failure worth retrying, so don't burn the attempt on
    // it — every other refusal is recorded so it isn't hammered each tick.
    if (refusal !== 'rate-limit') {
      recordRerun(run.id, {
        attempt: run.run_attempt,
        fingerprint,
        at,
        ok: false,
        error: detail,
      });
      addEvent({ ...base, outcome: 'failed', detail });
    }

    // A `permission` refusal has already latched capability off inside
    // rerunFailedJobs, so the feature disappears on its own from here.
    if (notify && refusal !== 'rate-limit') {
      sendNotification({
        title: "Couldn't re-run failed jobs",
        body: `#${entry.pr.number} ${entry.pr.title} · ${detail}`,
        tag: `rerun-failed-${run.id}-${run.run_attempt}`,
        url: run.html_url,
      });
    }
  }
}

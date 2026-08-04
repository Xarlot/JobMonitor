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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ghGet, GitHubApiError } from '../api/githubClient';
import { repoRunsPath } from '../api/endpoints';
import { fetchJobAnnotations } from '../api/annotations';
import { fetchAllRunJobs } from '../api/jobs';
import { rerunFailedJobs } from '../api/workflows';
import { getRateLimit, isThrottled } from '../api/rateLimit';
import type { Job, WorkflowRun, WorkflowRunsResponse } from '../api/types';
import {
  decideRerun,
  GITHUB_RERUN_LIMIT_HOURS,
  identicalFailuresLimited,
  identicalStreak,
  matchesWorkflowFile,
  RETRYABLE_CONCLUSIONS,
  runAgeBasis,
  SKIP_REASON_LABEL,
  type RerunSkipReason,
} from '../lib/autoRerun';
import { createVerdictLog, devLog, devWarn } from '../lib/devLog';
import {
  failureFingerprint,
  mergeSignatures,
  signatureFromAnnotations,
} from '../lib/failureReport';
import { failedStepName } from '../lib/failures';
import { workflowBasename } from '../lib/workflow';
import { sendNotification } from '../lib/notifications';
import {
  loadRerunRecords,
  recordDecline,
  recordRerun,
  rerunRequestCount,
  type RerunRecord,
} from '../storage/rerunStore';
import type { PrAutoRerunConfig } from '../storage/configStore';
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
  /**
   * `requested` — GitHub was asked to re-run. `failed` — it was asked and refused.
   * `held` — it was *not* asked, because the failure could not be checked against the
   * previous one and re-running blind would let the identical-failure limit lapse.
   */
  outcome: 'requested' | 'failed' | 'held';
  /** Why, when `outcome` is 'failed' or 'held'. */
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

/** Why the engine is idle, in log prose. Mirrors IDLE_LABEL in FailuresView. */
const IDLE_REASON_LOG: Record<AutoRerunState['idleReason'], string> = {
  off: 'auto-rerun is switched off',
  'no-workflows': 'no workflow files are configured',
  'no-permission': 'the token cannot re-run jobs',
  throttled: 'the GitHub rate limit is nearly exhausted',
  armed: 'armed',
};

/** A verdict log per engine instance, so a steady state logs once, not once a minute. */
type VerdictLog = ReturnType<typeof createVerdictLog>;

/**
 * The facts behind one skip, for the log's `detail`.
 *
 * The reason on its own is rarely enough to act on: "older than the configured
 * window" invites "by how much?", `not_matched` is only meaningful next to the list
 * it failed to match, and `already_requested` is the shape every *earlier* verdict
 * takes on later ticks — so it has to carry the record that latched it.
 */
function skipDetail(args: {
  reason: RerunSkipReason;
  run: WorkflowRun;
  settings: PrAutoRerunConfig;
  record: RerunRecord | undefined;
  fingerprint: string | null;
  fingerprintProblem?: string | null;
  now: number;
}): Record<string, unknown> {
  const { reason, run, settings, record, fingerprint, fingerprintProblem, now } = args;
  const base: Record<string, unknown> = {
    runId: run.id,
    attempt: run.run_attempt,
    workflowFile: run.path ? workflowBasename(run.path) : null,
    conclusion: run.conclusion,
    url: run.html_url,
  };
  switch (reason) {
    case 'not_matched':
      return { ...base, runPath: run.path, configured: settings.workflowFiles };
    case 'too_old':
      return {
        ...base,
        // Both stamps, because the gap between them is the whole subtlety: `createdAt`
        // is when the run first ran and never moves, `startedAt` is this attempt.
        startedAt: runAgeBasis(run),
        createdAt: run.created_at,
        ageHours: Number(((now - Date.parse(runAgeBasis(run))) / 3600_000).toFixed(1)),
        windowHours: settings.maxRunAgeHours,
      };
    case 'rerun_window_closed':
      return {
        ...base,
        createdAt: run.created_at,
        ageHours: Number(((now - Date.parse(run.created_at)) / 3600_000).toFixed(1)),
        limitHours: GITHUB_RERUN_LIMIT_HOURS,
      };
    case 'attempts_exhausted':
      return { ...base, maxAttempts: settings.maxAttempts };
    case 'identical_failure':
      // `latched` present means this is a stored verdict being replayed rather than one
      // just reached — so no annotations were fetched for it this tick.
      return {
        ...base,
        fingerprint,
        // The streak against the limit: "5 of 5" is the sentence someone wants here.
        identicalFailures: fingerprint
          ? identicalStreak(record, run.run_attempt, fingerprint)
          : null,
        allowed: settings.maxIdenticalFailures,
        rerunsRequested: rerunRequestCount(record),
        latched: record?.declined,
      };
    case 'already_requested':
      return {
        ...base,
        rerunsRequested: rerunRequestCount(record),
        requested: record?.attempts,
      };
    case 'fingerprint_unavailable':
      return {
        ...base,
        problem: fingerprintProblem,
        // What the refusal is protecting: without a fingerprint the streak can't be
        // extended, so re-running would let the allowance lapse rather than count.
        allowed: settings.maxIdenticalFailures,
        lastKnownFingerprint: record?.attempts[record.attempts.length - 1]?.fingerprint ?? null,
      };
    default:
      return base;
  }
}

/** One run in a log summary: enough to recognise it without opening GitHub. */
function describeRun(run: WorkflowRun): string {
  const file = run.path ? workflowBasename(run.path) : (run.name ?? String(run.id));
  return `${file} attempt ${run.run_attempt} ${run.conclusion ?? run.status}`;
}

/** Record why one run was passed over, once per verdict. */
function logSkip(
  log: VerdictLog,
  entry: PrEntry,
  run: WorkflowRun,
  reason: RerunSkipReason,
  settings: PrAutoRerunConfig,
  record: RerunRecord | undefined,
  fingerprint: string | null,
  fingerprintProblem: string | null = null,
): boolean {
  // Covered in aggregate by the per-PR matched/ignored line, and a repo with many
  // workflows would otherwise spend most of the log saying so run by run.
  if (reason === 'not_matched') return false;
  // The cause goes in the sentence, not only the detail: this one is a malfunction, and
  // reading "could not be checked" without reading what went wrong helps nobody.
  const because = reason === 'fingerprint_unavailable' && fingerprintProblem
    ? `: ${fingerprintProblem}`
    : '';
  return log(
    `run:${run.id}:${run.run_attempt}`,
    // The problem is part of the verdict, so a *different* failure to check gets its own
    // line rather than being swallowed as a repeat of the last one.
    `${reason}${because}`,
    `#${entry.pr.number} ${describeRun(run)} not re-run — ${SKIP_REASON_LABEL[reason]}${because}`,
    skipDetail({ reason, run, settings, record, fingerprint, fingerprintProblem, now: Date.now() }),
  );
}

/** Record an "wanted to, couldn't check" on the PR's activity. */
function addHeldEvent(
  addEvent: (e: RerunEvent) => void,
  entry: PrEntry,
  run: WorkflowRun,
  problem: string | null,
): void {
  const at = Date.now();
  addEvent({
    id: `${run.id}-${run.run_attempt}-held-${at}`,
    at,
    prNumber: entry.pr.number,
    prTitle: entry.pr.title,
    runId: run.id,
    runUrl: run.html_url,
    workflowFile: run.path ? workflowBasename(run.path) : null,
    attempt: run.run_attempt,
    outcome: 'held',
    detail: problem ?? SKIP_REASON_LABEL.fingerprint_unavailable,
  });
}

/**
 * The outcome of trying to fingerprint a failure.
 *
 * A plain `string | null` was not enough: "there is no fingerprint" has to carry *why*,
 * because the engine now refuses to re-run when it cannot check, and a refusal with no
 * stated cause is the kind of silence this whole engine has already been fixed for once.
 */
type FingerprintResult = { ok: true; fingerprint: string } | { ok: false; problem: string };

/**
 * Fingerprint of what failed in a run, from its failed jobs' annotations.
 *
 * Annotations rather than raw logs: they *are* the failure content (test name plus
 * message) with far less noise, and pulling logs for every failed job on every poll
 * would be far too heavy here.
 *
 * Missing annotations are not a problem — job and step names still fingerprint, if
 * coarsely, and `fetchJobAnnotations` answers with an empty list rather than throwing. Only
 * two things stop this cold, and they are worth telling apart in the log: the jobs list
 * couldn't be fetched, or the run claims a failure with no failed job in it.
 */
async function fingerprintRun(
  owner: string,
  repo: string,
  runId: number,
): Promise<FingerprintResult> {
  let jobs: Job[];
  try {
    jobs = await fetchAllRunJobs(owner, repo, runId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, problem: `the run’s jobs could not be listed — ${detail}` };
  }
  const failed = jobs.filter(isFailedJob).slice(0, MAX_FINGERPRINT_JOBS);
  if (failed.length === 0) {
    // Nothing to fingerprint — and nothing for `rerun-failed-jobs` to act on either, so
    // refusing here is not merely cautious. Usually GitHub's jobs list lagging a run that
    // has only just finished, in which case the next tick sees them.
    return {
      ok: false,
      problem: `the run is marked failed but none of its ${jobs.length} job(s) are`,
    };
  }

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

  const fingerprint = failureFingerprint(mergeSignatures(parts));
  // Empty of both job names and messages — nothing distinguishing to hash, so there is
  // nothing to compare against the previous attempt either.
  if (!fingerprint) {
    return { ok: false, problem: 'the failure had nothing identifying to compare' };
  }
  return { ok: true, fingerprint };
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

  const logRef = useRef<VerdictLog | null>(null);
  if (!logRef.current) logRef.current = createVerdictLog('auto-rerun');

  /**
   * The engine's own state, whenever it changes.
   *
   * Logged from an effect rather than from the tick because the interesting states
   * are exactly the ones in which no tick ever runs: `off`, `no-permission` and
   * `no-workflows` disarm the poll entirely, so a tick-side log would be silent
   * precisely when someone is asking why nothing happened. The settings ride along
   * because every later line has to be read against them.
   */
  useEffect(() => {
    devLog(
      'auto-rerun',
      idleReason === 'armed'
        ? 'armed'
        : `idle — ${IDLE_REASON_LOG[idleReason]}`,
      {
        repo: `${owner}/${repo}`,
        canWrite,
        workflowFiles: settings.workflowFiles,
        maxAttempts: settings.maxAttempts,
        maxRunAgeHours: settings.maxRunAgeHours,
        maxIdenticalFailures: settings.maxIdenticalFailures,
      },
    );
  }, [idleReason, owner, repo, canWrite, settings]);

  const tick = useCallback(async () => {
    if (!armed) return;
    const log = logRef.current!;
    // Writes are the likeliest trigger for GitHub's secondary limits, and nothing
    // else in the app gates on throttling — so this engine must.
    if (isThrottled(getRateLimit())) {
      log('tick', 'throttled', 'tick skipped — rate limit nearly exhausted');
      return;
    }

    const candidates = prs.filter((e) => e.pr.auto_merge != null);
    if (candidates.length === 0) {
      log(
        'tick',
        `no-candidates:${prs.length}`,
        `nothing to consider — none of the ${prs.length} tracked PR(s) have auto-merge enabled`,
      );
      return;
    }
    log(
      'tick',
      `candidates:${candidates.map((e) => e.pr.number).join(',')}`,
      `considering ${candidates.length} PR(s) with auto-merge`,
      { prs: candidates.map((e) => e.pr.number) },
    );

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
      } catch (err) {
        // Logged rather than swallowed: a PR whose runs never load looks exactly
        // like a PR with nothing to do, and the two want different fixes.
        devWarn('auto-rerun', `#${entry.pr.number}: could not list runs for the head commit`, err);
        continue; // transient; the next tick tries again
      }

      // The matched/ignored split, aggregated: it is the answer to "why was *that*
      // red workflow left alone", and one line per PR beats one per ignored run.
      const matched = runs.filter((run) => matchesWorkflowFile(run, settings.workflowFiles));
      log(
        `pr:${entry.pr.number}`,
        `${entry.pr.head.sha}:${runs.length}:${matched.length}`,
        `#${entry.pr.number}: ${matched.length} of ${runs.length} run(s) on ` +
          `${entry.pr.head.sha.slice(0, 7)} match the configured workflows`,
        {
          matched: matched.map(describeRun),
          ignored: runs.filter((run) => !matched.includes(run)).map(describeRun),
          configured: settings.workflowFiles,
        },
      );

      for (const run of runs) {
        if (fired >= MAX_RERUNS_PER_TICK) break;

        // The whole policy, minus the rules that need a fingerprint. It is pure, so
        // running it over every run costs nothing and keeps one source of truth for
        // *why* a run was passed over — which is what the log needs to say.
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
        if (!preflight.rerun) {
          logSkip(log, entry, run, preflight.reason, settings, records.get(run.id), null);
          continue;
        }

        // Only worth its annotation fetches while the brake can actually fire. The
        // fingerprint is also what gets stored, so it has to be computed for a run we are
        // about to re-run, not just for one we might refuse.
        let fingerprint: string | null = null;
        let fingerprintProblem: string | null = null;
        if (identicalFailuresLimited(settings)) {
          const result = await fingerprintRun(owner, repo, run.id);
          if (result.ok) fingerprint = result.fingerprint;
          else fingerprintProblem = result.problem;
        }

        const decision = decideRerun({
          run,
          pr: entry.pr,
          settings,
          record: records.get(run.id),
          fingerprint,
          fingerprintProblem,
          now: Date.now(),
        });
        if (!decision.rerun) {
          const logged = logSkip(
            log,
            entry,
            run,
            decision.reason,
            settings,
            records.get(run.id),
            fingerprint,
            fingerprintProblem,
          );
          // Surfaced on the PR as well as in the log: this is the engine wanting to act and
          // being unable to, which is the one refusal a person may need to do something
          // about. Gated on `logged` so a per-tick refusal doesn't fill the activity list
          // with the same line.
          if (decision.reason === 'fingerprint_unavailable' && logged) {
            addHeldEvent(addEvent, entry, run, fingerprintProblem);
          }
          // Remember a terminal verdict so we don't re-derive it (and re-fetch
          // annotations for it) on every tick from now on. Recorded as a decline, not as
          // an attempt: nothing was asked of GitHub, and filing it among the requests
          // would both inflate the re-run count and mislabel this run from now on.
          if (decision.reason === 'identical_failure') {
            recordDecline(run.id, {
              attempt: run.run_attempt,
              reason: decision.reason,
              fingerprint,
              at: Date.now(),
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
    // The in-memory event list is gone on restart, and this is the one thing the app
    // *changed* on GitHub — it belongs somewhere durable.
    devLog(
      'auto-rerun',
      `#${entry.pr.number} ${workflowFile ?? 'workflow'} run ${run.id}: re-ran failed jobs ` +
        `(attempt ${run.run_attempt} → ${run.run_attempt + 1})`,
      { runId: run.id, attempt: run.run_attempt, fingerprint, url: run.html_url },
    );
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

    devWarn(
      'auto-rerun',
      `#${entry.pr.number} ${workflowFile ?? 'workflow'} run ${run.id}: re-run request failed — ${detail}`,
      { runId: run.id, attempt: run.run_attempt, refusal, retrying: refusal === 'rate-limit' },
    );

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

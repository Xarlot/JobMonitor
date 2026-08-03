/**
 * Loads the detail a failure report needs, at two different eagernesses.
 *
 * Annotations are **prefetched** for every failing job as it appears (bounded, and
 * switchable off), because the whole point of the Failures list is to see *which
 * test broke* without clicking into anything. One request per failing job, and
 * they're ETag-cached, so a poll that changes nothing costs nothing.
 *
 * The log tail is much heavier, so it is fetched only for the failure actually
 * being read — and needs the job's steps first, to attribute lines to the step
 * that broke rather than dumping the end of the whole job.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ghGet } from '../api/githubClient';
import { checkRunAnnotationsPath, singleJobPath, singleRunPath } from '../api/endpoints';
import { fetchJobLog, logTtlMs } from '../api/logCache';
import type { Annotation, Job, WorkflowRun } from '../api/types';
import { parseLogLines, splitLogBySteps } from '../lib/logs';
import { workflowBasename } from '../lib/workflow';
import { failedStepName, type FailedJobRef } from '../lib/failures';
import { failureDetailCache, type CachedFailureDetail } from '../storage/failureCaches';

export interface FailureDetail {
  /** null until loaded; [] means "loaded, none reported". */
  annotations: Annotation[] | null;
  /** The step that failed, once the job has been fetched. */
  failedStep: string | null;
  /** Workflow file the run belongs to — a check-run doesn't carry it. */
  workflowFile: string | null;
  runNumber: number | null;
  runAttempt: number | null;
  /** Trailing lines of the failing step's log; null until loaded. */
  logTail: string[] | null;
  loadingLog: boolean;
  error: string | null;
}

export const EMPTY_FAILURE_DETAIL: FailureDetail = {
  annotations: null,
  failedStep: null,
  workflowFile: null,
  runNumber: null,
  runAttempt: null,
  logTail: null,
  loadingLog: false,
  error: null,
};

/** Ceiling on background annotation fetches per pass, to stay polite. */
const MAX_PREFETCH = 12;

export function useFailureDetails(
  /** Every failure, for lookups by key. */
  failures: readonly FailedJobRef[],
  /** The subset on screen — only these are worth prefetching for. */
  visible: readonly FailedJobRef[],
  focusKey: string | null,
  options: { prefetchAnnotations: boolean; logTailLines: number },
): {
  details: Record<string, FailureDetail>;
  /** Force a (re)load of the focused failure's log. */
  reloadLog: (key: string) => void;
} {
  const { prefetchAnnotations, logTailLines } = options;

  // Keys already attempted, so a failed fetch isn't retried on every render and a
  // successful one isn't duplicated. Survives re-renders, resets with the hook.
  const annotationsTried = useRef<Set<string>>(new Set());
  const logsTried = useRef<Set<string>>(new Set());

  const [details, setDetails] = useState<Record<string, FailureDetail>>({});

  /**
   * Whether the component is still alive. Used *instead* of the usual per-effect
   * `active` flag: a key is marked tried before its request starts, so tearing an
   * in-flight fetch down on every dependency change would strand that key as
   * "attempted but never applied" and it would never be retried. The list churns
   * on each poll, so that race is the normal case, not a corner one.
   */
  const mounted = useRef(true);
  useEffect(() => {
    // Re-arm on mount: StrictMode mounts, unmounts and mounts again, so a
    // cleanup-only effect would leave this false for the rest of the session and
    // silently drop every result.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Remember the durable half of a detail; loading/error flags aren't cached. */
  const remember = (key: string, detail: FailureDetail): [string, CachedFailureDetail] => [
    key,
    {
      annotations: detail.annotations,
      failedStep: detail.failedStep,
      workflowFile: detail.workflowFile,
      runNumber: detail.runNumber,
      runAttempt: detail.runAttempt,
      logTail: detail.logTail,
    },
  ];

  const patch = useCallback((key: string, next: Partial<FailureDetail>) => {
    if (!mounted.current) return;
    setDetails((prev) => {
      const merged = { ...(prev[key] ?? EMPTY_FAILURE_DETAIL), ...next };
      // Don't cache a half-loaded entry — wait until the request settles.
      if (!merged.loadingLog) failureDetailCache.setMany([remember(key, merged)]);
      return { ...prev, [key]: merged };
    });
  }, []);

  /** Apply several patches in one state update, so a fan-out costs one render. */
  const patchMany = useCallback(
    (entries: readonly { key: string; patch: Partial<FailureDetail> }[]) => {
      if (!mounted.current || entries.length === 0) return;
      setDetails((prev) => {
        const next = { ...prev };
        const toCache: [string, CachedFailureDetail][] = [];
        for (const { key, patch: p } of entries) {
          next[key] = { ...(next[key] ?? EMPTY_FAILURE_DETAIL), ...p };
          if (!next[key].loadingLog) toCache.push(remember(key, next[key]));
        }
        failureDetailCache.setMany(toCache);
        return next;
      });
    },
    [],
  );

  // --- annotations: prefetched for the list ---------------------------------
  // The focused failure is always fetched, even with prefetch off, because a
  // report without its test list is the one thing this feature must not produce.
  const wanted = useMemo(() => {
    // `visible` rather than every failure: groups start collapsed, and fetching test
    // names for rows nobody can see would be pure waste.
    const list = prefetchAnnotations ? visible.slice(0, MAX_PREFETCH) : [];
    const focused = focusKey ? failures.find((f) => f.key === focusKey) : undefined;
    return focused && !list.includes(focused) ? [...list, focused] : list;
  }, [visible, failures, focusKey, prefetchAnnotations]);
  const wantedSig = wanted.map((f) => f.key).join(',');
  const liveSig = failures.map((f) => f.key).join(',');

  /**
   * Adopt whatever the week-long cache already knows about the failures now on the
   * board. Everything in it describes finished work, so it is as good as a fresh
   * fetch — and marking those keys as "tried" is what turns a revisit to this tab
   * into zero requests.
   *
   * Keyed on the live list rather than done once at mount, because on the first
   * render the PR and flow data hasn't arrived and there is nothing to match yet.
   */
  useEffect(() => {
    const hydrated: { key: string; patch: Partial<FailureDetail> }[] = [];
    for (const f of failures) {
      if (annotationsTried.current.has(f.key)) continue;
      const cached = failureDetailCache.get(f.key);
      if (!cached) continue;
      if (cached.annotations !== null) annotationsTried.current.add(f.key);
      // Only skip a future log fetch if a tail was actually stored: an entry may
      // predate the report ever having been opened.
      if (cached.logTail !== null) logsTried.current.add(f.key);
      hydrated.push({ key: f.key, patch: cached });
    }
    if (hydrated.length > 0) patchMany(hydrated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSig, patchMany]);

  /**
   * Forget failures that no longer exist. A re-run mints a new check-run id, so
   * without this every attempt leaves behind its annotations and log tail — and the
   * Failures tab is exactly the one left open all day.
   */
  useEffect(() => {
    const live = new Set(liveSig ? liveSig.split(',') : []);
    for (const set of [annotationsTried.current, logsTried.current]) {
      for (const key of set) if (!live.has(key)) set.delete(key);
    }
    setDetails((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((k) => live.has(k))) return prev;
      const next: Record<string, FailureDetail> = {};
      for (const k of keys) if (live.has(k)) next[k] = prev[k];
      return next;
    });
  }, [liveSig]);

  useEffect(() => {
    // A failure with no check-run has no annotations to fetch.
    const pending = wanted.filter(
      (f) => f.checkRunId != null && !annotationsTried.current.has(f.key),
    );
    if (pending.length === 0) return;
    for (const f of pending) annotationsTried.current.add(f.key);

    // Fan out rather than awaiting each in turn: this is up to a dozen requests and
    // it gates the test names appearing in the list, which is the whole point of
    // prefetching them. Results are applied in one state update.
    void Promise.all(
      pending.map(async (failure) => {
        try {
          const { data } = await ghGet<Annotation[]>(
            checkRunAnnotationsPath(failure.owner, failure.repo, failure.checkRunId as number),
          );
          return { key: failure.key, patch: { annotations: data } as Partial<FailureDetail> };
        } catch (e) {
          // A missing annotation list is not an error worth shouting about — the
          // report falls back to the log tail.
          return {
            key: failure.key,
            patch: {
              annotations: [] as Annotation[],
              error: e instanceof Error ? e.message : String(e),
            } as Partial<FailureDetail>,
          };
        }
      }),
    ).then((results) => patchMany(results));
    // `wanted` is keyed by wantedSig; depending on it directly would re-run on
    // every poll that returns an identically-keyed list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedSig, patchMany]);

  // --- log tail: only for what's being read ---------------------------------
  const loadLog = useCallback(
    async (key: string, force: boolean) => {
      const failure = failures.find((f) => f.key === key);
      if (!failure || failure.jobId == null) return;
      if (!force && logsTried.current.has(key)) return;
      if (logTailLines === 0) return;
      logsTried.current.add(key);

      patch(key, { loadingLog: true });
      try {
        // The job (for its steps) and the run (for the workflow file + attempt,
        // which a check-run doesn't carry) are independent — fetch them together.
        const { owner, repo } = failure;
        // A flow failure already carries its run identity, so only a PR failure —
        // whose check-run says nothing about the workflow — needs the run read.
        const needsRun = failure.workflowFile === null && failure.runId != null;
        const [jobRes, runRes] = await Promise.all([
          ghGet<Job>(singleJobPath(owner, repo, failure.jobId)),
          needsRun
            ? ghGet<WorkflowRun>(singleRunPath(owner, repo, failure.runId as number)).catch(
                () => null,
              )
            : Promise.resolve(null),
        ]);
        const job = jobRes.data;
        const run = runRes?.data ?? null;
        const step = failedStepName(job);
        const text = await fetchJobLog(owner, repo, failure.jobId, logTtlMs(true));
        const byStep = splitLogBySteps(text, job.steps);
        // Prefer the failing step's own output, but fall back to the whole log when
        // the step boundaries couldn't be resolved *or* produced nothing — note `??`
        // would not catch the empty-string case, which is the common one when step
        // timestamps don't line up with the log.
        const stepNumber = job.steps?.find((s) => s.name === step)?.number;
        const stepText = stepNumber != null ? byStep[stepNumber] : undefined;
        // splitLogBySteps has already stripped timestamps and ANSI codes from its
        // chunks; the raw-log fallback has not, so run it through the same parser.
        const lines = (
          stepText && stepText.trim() !== ''
            ? stepText.split('\n')
            : parseLogLines(text).map((l) => l.text)
        ).filter((l) => l.trim() !== '');
        patch(key, {
          failedStep: step,
          workflowFile: run?.path ? workflowBasename(run.path) : failure.workflowFile,
          runNumber: run?.run_number ?? failure.runNumber,
          runAttempt: run?.run_attempt ?? failure.runAttempt,
          logTail: lines.slice(-logTailLines),
          loadingLog: false,
        });
      } catch (e) {
        patch(key, {
          loadingLog: false,
          logTail: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [failures, logTailLines, patch],
  );

  useEffect(() => {
    if (!focusKey) return;
    void loadLog(focusKey, false);
    // loadLog changes with `failures`; keying on focusKey avoids refetch churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, logTailLines]);

  const reloadLog = useCallback(
    (key: string) => {
      void loadLog(key, true);
    },
    [loadLog],
  );

  return { details, reloadLog };
}


/**
 * Runs the local `claude` CLI over a failed job and tracks its progress.
 *
 * Desktop-only, and only on an explicit click: the analysis sends log text to the
 * user's own Claude CLI, which is the one place this app moves data anywhere other
 * than api.github.com. Nothing here happens on a poll or in the background.
 *
 * Progress is *reported*, not guessed: the main process emits a phase when it starts
 * fetching the log, when it hands the log to the model, and forwards the reply as it
 * is written. An operation that can take a minute or two deserves better than a
 * spinner that says nothing about where the time went.
 *
 * Results are kept per failure key **and depth** — the two depths are two different
 * answers to the same question, so a quick read must not overwrite a deep one — and
 * persisted for a week through `claudeAnalysisCache`, so a slow and billable call isn't
 * spent twice on the same attempt.
 *
 * Persisting a *suggestion* is only defensible because the key contains the job id and
 * re-running failed jobs mints new ones: a new attempt misses rather than being served
 * the previous attempt's verdict. Without that property this would be a cache of
 * confident, stale opinions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfig } from '../context/ConfigContext';
import {
  analyzeWithClaude,
  cancelClaudeAnalysis,
  claudeBridgeAvailable,
  claudeToolsReady,
  NO_CLAUDE_TOOLS,
  onClaudeProgress,
  probeClaudeTools,
  type ClaudeLogSource,
  type ClaudePhase,
  type ClaudeToolStatus,
} from '../storage/desktopClaude';
import { fetchJobLog, hasCachedLog, logTtlMs } from '../api/logCache';
import { devLog, devWarn } from '../lib/devLog';

/**
 * How long to wait for the app's own copy of the job log before giving up on it.
 * Generous, because a large log legitimately takes a while — but finite, because the
 * quick pass promises about a minute and cannot spend it waiting.
 */
const LOG_FETCH_TIMEOUT_MS = 20 * 60_000;
/**
 * …except for the quick read, which promises about a minute. It cannot spend twenty
 * waiting for a log; if the download is that slow, the honest outcome is to say so and let
 * the deep pass — which has the time — go and get it.
 */
const QUICK_LOG_FETCH_TIMEOUT_MS = 45_000;

/** "45 seconds" / "20 minutes" — whichever reads naturally at that scale. */
function describeDuration(ms: number): string {
  return ms < 90_000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60_000)} minutes`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
import {
  buildClaudePrompt,
  CLAUDE_RESUME_PROMPT,
  parseClaudeAnalysis,
  trimLog,
  type ClaudeAnalysis,
  type ClaudeDepth,
} from '../lib/claudePrompt';
import { analysisKey, claudeAnalysisCache } from '../storage/failureCaches';
import type { Annotation } from '../api/types';
import type { FailedJobRef } from '../lib/failures';
import { ErrorCategory, Feature, Operation, Telemetry } from '../lib/telemetry';

export interface TriageState {
  analysis: ClaudeAnalysis | null;
  running: boolean;
  error: string | null;
  /** Null until a run starts. */
  phase: ClaudePhase | null;
  /** Log bytes fetched so far, or the final size once handed over. */
  logBytes: number;
  logTruncated: boolean;
  /** Whether a log-fetch retry is in progress. */
  retrying: boolean;
  /** The installed CLI couldn't be given tools, so the analysis is log-only. */
  toolsUnavailable: boolean;
  /** Which log was read, once known. */
  logSource: ClaudeLogSource | null;
  /** Whether the app already had the job's log when the run started. */
  logCached: boolean;
  /** Set when the answer is real but was cut short — see ClaudeAnalyzeResult. */
  incompleteReason: string | null;
  /** Present when the unfinished run can be continued rather than restarted. */
  sessionId: string | null;
  /** Whether this result is carried into the bug report. */
  inReport: boolean;
  /**
   * A whole-document answer, for the tasks that return one rather than the two marked
   * sections: the rewritten log, and the blame report.
   */
  document: string | null;
  /** The reply as it streams in — shown live while `running`. */
  partial: string;
  /** What Claude has been doing: most recent tool calls, newest last. */
  activity: string[];
  startedAt: number | null;
  /** The in-flight request, for cancellation. */
  requestId: string | null;
}

export const IDLE_TRIAGE: TriageState = {
  analysis: null,
  running: false,
  error: null,
  phase: null,
  logBytes: 0,
  logTruncated: false,
  retrying: false,
  toolsUnavailable: false,
  logSource: null,
  logCached: false,
  incompleteReason: null,
  sessionId: null,
  inReport: false,
  document: null,
  partial: '',
  activity: [],
  startedAt: null,
  requestId: null,
};

export interface TriageInput {
  failedStep: string | null;
  workflowFile: string | null;
  annotations: readonly Annotation[];
}

export interface ClaudeTriage {
  tools: ClaudeToolStatus;
  /** Whether to offer the action at all. */
  available: boolean;
  /** State for one failure at one depth. */
  stateFor: (key: string, depth: ClaudeDepth) => TriageState;
  /**
   * Start an analysis. `resume` continues the unfinished run in `stateFor(...).sessionId`
   * rather than beginning again — everything it had already established is still in that
   * conversation.
   */
  run: (
    failure: FailedJobRef,
    input: TriageInput,
    depth: ClaudeDepth,
    options?: { resume?: boolean },
  ) => void;
  cancel: (key: string, depth: ClaudeDepth) => void;
  /**
   * Carry a finished result into the bug report, or take it back out.
   *
   * Written through to the week-long cache with the analysis it belongs to: the choice
   * should survive closing the dialog and restarting the app, and should expire when the
   * analysis does — a verdict about an attempt means nothing once that attempt has aged out.
   */
  setInReport: (key: string, depth: ClaudeDepth, inReport: boolean) => void;
}

/** How many recent tool calls to keep for the activity feed. */
const MAX_ACTIVITY = 40;

/** Which feature id each analysis depth records. */
const AI_FEATURE: Partial<Record<ClaudeDepth, Feature>> = {
  quick: Feature.AI_TRIAGE_QUICK,
  deep: Feature.AI_TRIAGE_DEEP,
  log: Feature.AI_LOG_FETCH,
  blame: Feature.AI_BLAME,
};

/** And which operation times it. Separate from the feature: one says who asked, one says how long. */
const AI_OPERATION: Partial<Record<ClaudeDepth, Operation>> = {
  quick: Operation.CLAUDE_QUICK,
  deep: Operation.CLAUDE_DEEP,
  log: Operation.CLAUDE_LOG_FETCH,
  blame: Operation.CLAUDE_BLAME,
};

/**
 * The bridge reports failures as a string, so there is no error object to classify.
 *
 * Only the timeout is worth naming: it is the difference between "Claude answered badly" and
 * "Claude never answered", and it is the one this feature is actually prone to. Everything else
 * stays UNKNOWN rather than being guessed at from message text, which would turn a wording change
 * in the CLI into a silent shift in the numbers.
 */
function categorizeClaudeError(message: string): ErrorCategory {
  return /timed out|timeout/i.test(message) ? ErrorCategory.TIMEOUT : ErrorCategory.UNKNOWN;
}

/** In-flight/finished state is keyed per failure *and* depth. */
function slotKey(key: string, depth: ClaudeDepth): string {
  return `${key}|${depth}`;
}

/**
 * Correlates progress events and cancellation with one call.
 *
 * `randomUUID` is absent outside a secure context, hence the fallback — which has to stay
 * within `/^[A-Za-z0-9-]{1,64}$/`, since the main process re-checks the shape before
 * letting it near anything.
 */
export function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useClaudeTriage(): ClaudeTriage {
  const { config } = useConfig();
  const ai = config.ai;
  const [tools, setTools] = useState<ClaudeToolStatus>(NO_CLAUDE_TOOLS);
  const [byKey, setByKey] = useState<Record<string, TriageState>>({});
  /**
   * The same state, readable without subscribing to it. `run` needs the previous session id
   * to resume, but taking `byKey` as a dependency would rebuild the callback on every
   * streamed chunk.
   */
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;
  /** requestId -> failure key, so a progress event can find its row. */
  const keyByRequest = useRef<Map<string, string>>(new Map());

  // Probe once per mount. Cheap (two `--version` calls plus `gh auth status`), and
  // someone installing the CLI mid-session gets the button on their next visit.
  useEffect(() => {
    if (!claudeBridgeAvailable()) return;
    let active = true;
    void Telemetry.measure(Operation.CLAUDE_PROBE, () => probeClaudeTools()).then((status) => {
      if (active) setTools(status);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return onClaudeProgress((progress) => {
      const key = keyByRequest.current.get(progress.requestId);
      if (!key) return;
      setByKey((prev) => {
        const current = prev[key];
        // Ignore events for a request that has already been replaced or cancelled.
        if (!current || current.requestId !== progress.requestId) return prev;
        return {
          ...prev,
          [key]: {
            ...current,
            phase: progress.phase,
            logBytes: progress.logBytes ?? progress.bytes ?? current.logBytes,
            logTruncated: progress.logTruncated ?? current.logTruncated,
            retrying: progress.retrying ?? false,
            toolsUnavailable: progress.toolsUnavailable ?? current.toolsUnavailable,
            logSource: progress.logSource ?? current.logSource,
            partial: progress.chunk ? current.partial + progress.chunk : current.partial,
            // Capped: a long investigation would otherwise grow this without bound.
            activity: progress.activity
              ? [...current.activity, progress.activity].slice(-MAX_ACTIVITY)
              : current.activity,
          },
        };
      });
    });
  }, []);

  /**
   * Adopt a stored analysis for this failure, so re-opening one you looked at earlier in
   * the week is instant and costs nothing. Keyed per depth, so a quick read doesn't
   * masquerade as a deep one.
   */
  const stateFor = useCallback(
    (key: string, depth: ClaudeDepth): TriageState => {
      const slot = slotKey(key, depth);
      const live = byKey[slot];
      if (live) return live;
      const cached = claudeAnalysisCache.get(analysisKey(key, depth));
      if (!cached) return IDLE_TRIAGE;
      return {
        ...IDLE_TRIAGE,
        analysis:
          cached.problem || cached.solution
            ? { problem: cached.problem, solution: cached.solution }
            : null,
        // `rewrittenLog` is the old name; entries written under it are still in the
        // week-long cache and should keep working until they expire.
        document: cached.document ?? cached.rewrittenLog ?? null,
        // Restored too, so a reopened analysis still shows what produced it and how far
        // that evidence reached — and can still be continued if it never finished.
        activity: cached.activity ?? [],
        incompleteReason: cached.incompleteReason ?? null,
        sessionId: cached.sessionId ?? null,
        inReport: cached.inReport ?? false,
        partial: cached.narration ?? '',
        logSource: cached.logSource ?? null,
        logTruncated: cached.logTruncated ?? false,
        phase: 'done',
      };
    },
    [byKey],
  );

  const run = useCallback<ClaudeTriage['run']>((failure, input, depth, options) => {
    if (failure.runId == null || !ai.enabled) return;
    // One entry point covers all four depths, so the split between them is recorded here rather
    // than at four call sites. The depths are genuinely different products — a quick read costs a
    // minute, a deep analysis goes and investigates — and which one people reach for is the
    // question worth answering.
    const feature = AI_FEATURE[depth];
    if (feature) Telemetry.featureUsed(feature);
    // Measured from here rather than from the bridge call: the wait a person experiences includes
    // the log download and prompt assembly below, and those are exactly the parts that make a
    // "quick" read stop feeling quick.
    const startedAtMs = performance.now();
    const task = ai[depth];
    const slot = slotKey(failure.key, depth);
    const requestId = newRequestId();
    // Read before the state is reset below, since resetting clears it.
    const resumeSessionId = options?.resume
      ? (byKeyRef.current[slot]?.sessionId ??
        claudeAnalysisCache.get(analysisKey(failure.key, depth))?.sessionId ??
        undefined)
      : undefined;
    keyByRequest.current.set(requestId, slot);
    // Whether the app's own log is already in hand decides what the first phase can
    // honestly claim: the quick pass advertises reading a log we already have, and it
    // must not say that while it is downloading one.
    const logCached =
      failure.jobId != null && hasCachedLog(failure.owner, failure.repo, failure.jobId, logTtlMs(true));

    setByKey((prev) => ({
      ...prev,
      [slot]: {
        ...IDLE_TRIAGE,
        running: true,
        phase: 'fetching-log',
        startedAt: Date.now(),
        requestId,
        logCached,
      },
    }));

    void (async () => {
      // The log the app can produce itself, in case `gh` can't. Already in logCache
      // for a failure whose report has been opened, so this is usually free.
      let fallbackLog = '';
      // Why there is no log, when there isn't one. Swallowing this left the failure
      // message unable to say anything useful about a case the user can't see into.
      let logProblem: string | null = null;
      if (failure.jobId == null) {
        logProblem =
          'this check run has no Actions job log (its details link doesn’t point at a job)';
        devWarn('claude', `no job id for "${failure.jobName}" — no job log exists to fetch`, {
          key: failure.key,
          url: failure.url,
          checkRunId: failure.checkRunId,
        });
      } else {
        try {
          // Bounded: this is the quick pass's only log source, so a stalled download
          // would sit on the phase indefinitely with nothing to report — the bridge
          // hasn't been called yet, so none of its progress events exist. The deep pass
          // can still get a log from `gh`, so it loses nothing by giving up here.
          fallbackLog = trimLog(
            await withTimeout(
              fetchJobLog(failure.owner, failure.repo, failure.jobId, logTtlMs(true)),
              depth === 'quick' ? QUICK_LOG_FETCH_TIMEOUT_MS : LOG_FETCH_TIMEOUT_MS,
            ),
          );
        } catch (err) {
          logProblem =
            err instanceof Error && err.message === 'timed out'
              ? `the log took longer than ${describeDuration(
                  depth === 'quick' ? QUICK_LOG_FETCH_TIMEOUT_MS : LOG_FETCH_TIMEOUT_MS,
                )} to download`
              : `the log couldn’t be downloaded (${err instanceof Error ? err.message : 'unknown error'})`;
          devWarn('claude', `log fetch failed for job ${failure.jobId}: ${logProblem}`, err);
        }
      }

      // Annotations name the failing tests with file, line and message, so the prompt is
      // worth sending even with no log at all — which is the only option for a check run
      // that has no job log to fetch.
      const evidenceInPrompt = input.annotations.length > 0;
      devLog('claude', `${depth} analysis of "${failure.jobName}"`, {
        runId: failure.runId,
        jobId: failure.jobId,
        logChars: fallbackLog.length,
        logProblem,
        annotations: input.annotations.length,
        annotationMessages: input.annotations.map((a) => `${a.path}:${a.start_line} ${a.message}`),
        failedStep: input.failedStep,
        workflowFile: input.workflowFile ?? failure.workflowFile,
      });
      if (!fallbackLog && !evidenceInPrompt && depth === 'quick') {
        return {
          ok: false as const,
          error: `Nothing to summarise: ${logProblem}, and this failure has no annotations either. Try Deep analysis, which fetches the log itself.`,
        };
      }

      // A resumed run already has all of this in its conversation; sending it again would
      // cost context and invite it to start the investigation over.
      // A resumed run already has all of this in its conversation; sending it again would
      // cost context and invite it to start the investigation over.
      const prompt = resumeSessionId
        ? CLAUDE_RESUME_PROMPT
        : buildClaudePrompt({
            owner: failure.owner,
            repo: failure.repo,
            runId: failure.runId,
            origin: failure.origin,
            jobName: failure.jobName,
            failedStep: input.failedStep,
            workflowFile: input.workflowFile ?? failure.workflowFile,
            headRef: failure.headRef,
            headSha: failure.headSha,
            annotations: input.annotations,
            log: '',
            // For the deep pass the bridge runs the CLI with a read-only tool allowlist, so
            // brief it to go and find the evidence rather than reason over the annotation.
            canInvestigate: true,
            depth,
            // The deep pass can still get a log from `gh` after this point; the quick pass
            // cannot, so an empty fallback there means there will be no log at all.
            hasLog: depth === 'deep' || fallbackLog.length > 0,
            promptOverride: task.prompt,
            extraInstructions: ai.extraInstructions,
          });

      return analyzeWithClaude({
        owner: failure.owner,
        repo: failure.repo,
        runId: failure.runId as number,
        prompt,
        requestId,
        fallbackLog,
        evidenceInPrompt,
        depth,
        model: task.model,
        effort: task.effort,
        resumeSessionId,
      });
    })().then((result) => {
      keyByRequest.current.delete(requestId);

      /*
       * Recorded before the staleness check below, deliberately.
       *
       * A superseded run still spent that time and still shelled out to the CLI; dropping its
       * measurement because a newer run replaced it would quietly bias the numbers towards the
       * fast cases, since the runs people give up on and retry are the slow ones.
       *
       * A cancellation is not a failure. It is its own signal — and the more interesting one,
       * because "started an analysis and abandoned it" is how being too slow actually shows up.
       */
      const operation = AI_OPERATION[depth];
      if (operation) {
        if (result.ok) {
          Telemetry.operationCompleted(operation, performance.now() - startedAtMs);
        } else if (result.cancelled) {
          Telemetry.featureUsed(Feature.AI_CANCELLED);
        } else {
          Telemetry.operationFailed(operation, categorizeClaudeError(result.error));
        }
      }

      setByKey((prev) => {
        const current = prev[slot];
        // A newer run (or a cancel) superseded this one; its result is stale.
        if (!current || current.requestId !== requestId) return prev;

        if (!result.ok) {
          return {
            ...prev,
            [slot]: result.cancelled
              ? { ...IDLE_TRIAGE }
              : { ...current, running: false, phase: null, requestId: null, error: result.error },
          };
        }
        // The log and blame tasks return a whole Markdown document rather than the two
        // marked sections, so their reply is taken verbatim — running it through the
        // marker parser would reject every one.
        const returnsDocument = depth === 'log' || depth === 'blame';
        const rewritten = returnsDocument ? result.reply.trim() : null;
        const analysis = returnsDocument ? null : parseClaudeAnalysis(result.reply);

        // The trail goes in with the result — see CachedAnalysis.activity.
        if (analysis || rewritten) {
          claudeAnalysisCache.set(analysisKey(failure.key, depth), {
            problem: analysis?.problem ?? '',
            solution: analysis?.solution ?? '',
            document: rewritten ?? undefined,
            activity: current.activity,
            narration: current.partial,
            incompleteReason: result.incompleteReason,
            sessionId: result.sessionId,
            logSource: result.logSource,
            logTruncated: result.logTruncated,
          });
        }
        return {
          ...prev,
          [slot]: {
            ...current,
            running: false,
            phase: 'done',
            requestId: null,
            analysis,
            document: rewritten,
            incompleteReason: result.incompleteReason ?? null,
            sessionId: result.sessionId ?? null,
            logTruncated: result.logTruncated,
            logSource: result.logSource,
            retrying: false,
            // Only the two-section tasks can fail this way. A document task has no
            // markers to miss, so applying the check there flags every successful run.
            error:
              returnsDocument || analysis
                ? null
                : "Claude's reply didn't contain the expected sections.",
          },
        };
      });
    });
    // `ai` is a real dependency: without it the callback would keep the settings as they
    // were at mount, so changing the model or the prompt would take effect only after a
    // remount — which looks exactly like the setting being ignored.
  }, [ai]);

  const cancel = useCallback((key: string, depth: ClaudeDepth) => {
    const slot = slotKey(key, depth);
    setByKey((prev) => {
      const current = prev[slot];
      if (!current?.requestId) return prev;
      void cancelClaudeAnalysis(current.requestId);
      keyByRequest.current.delete(current.requestId);
      // Reset immediately rather than waiting for the kill to land: the user asked
      // for it to stop, so it should read as stopped at once.
      return { ...prev, [slot]: { ...IDLE_TRIAGE } };
    });
  }, []);

  // The master switch gates availability, so every AI control disappears with one
  // setting rather than each caller remembering to check.
  const setInReport = useCallback((key: string, depth: ClaudeDepth, inReport: boolean) => {
    const cacheKey = analysisKey(key, depth);
    const cached = claudeAnalysisCache.get(cacheKey);
    // Re-setting refreshes the entry's timestamp, which is right: choosing to use a result
    // is exactly the signal that it is still wanted.
    if (cached) claudeAnalysisCache.set(cacheKey, { ...cached, inReport });

    const slot = slotKey(key, depth);
    setByKey((prev) => {
      const current = prev[slot];
      if (!current) return prev;
      return { ...prev, [slot]: { ...current, inReport } };
    });
  }, []);

  return {
    tools,
    available: ai.enabled && claudeToolsReady(tools),
    stateFor,
    run,
    cancel,
    setInReport,
  };
}

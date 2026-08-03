/**
 * Bridge to the desktop shell's local `gh` + `claude` CLIs
 * (`window.desktop.claude`, implemented in electron/claudeBridge.cjs).
 *
 * Absent in a plain browser, so `probeClaudeTools()` reports nothing available and
 * the UI simply doesn't offer the feature.
 */

export interface ClaudeToolStatus {
  gh: boolean;
  ghVersion: string | null;
  ghAuthenticated: boolean;
  claude: boolean;
  claudeVersion: string | null;
}

export const NO_CLAUDE_TOOLS: ClaudeToolStatus = {
  gh: false,
  ghVersion: null,
  ghAuthenticated: false,
  claude: false,
  claudeVersion: null,
};

export interface ClaudeAnalyzeRequest {
  owner: string;
  repo: string;
  runId: number;
  /** Full prompt; the main process appends the fetched log to it. */
  prompt: string;
  /** Correlates progress events and cancellation with this call. */
  requestId: string;
  /**
   * Log the app already fetched through the GitHub API, used when `gh` can't produce
   * one. `gh` gives the whole run's failed steps and is preferred, but it is not worth
   * failing over — see the HTTP/2 note in electron/claudeBridge.cjs.
   */
  fallbackLog?: string;
  /**
   * Whether the prompt already carries failure evidence of its own — the check-run
   * annotations, which name the failing tests with file, line and message.
   *
   * Without this the main process treats an empty log as "nothing to analyse" and
   * refuses. That is wrong whenever annotations exist: they *are* the failure content,
   * and a check run that isn't a plain Actions job has no job log to fetch at all
   * (`jobId` is parsed out of `details_url`, which only Actions jobs carry). Summarising
   * the annotations is precisely what a quick read is for.
   */
  evidenceInPrompt?: boolean;
  /** Which job to do; the main process enforces the per-task budget. */
  depth: 'quick' | 'deep' | 'log' | 'blame';
  /**
   * Model alias and reasoning effort from settings. Re-checked against a closed list in
   * the main process — these become `--model` and `--effort` arguments, and nothing the
   * renderer supplies is trusted there.
   */
  model?: string;
  effort?: string;
  /** Continue a previous, unfinished run rather than starting a new one. */
  resumeSessionId?: string;
}

/** Which log the analysis actually read. `none` means it worked from annotations alone. */
export type ClaudeLogSource = 'gh' | 'app' | 'none';

export type ClaudeAnalyzeResult =
  | {
      ok: true;
      reply: string;
      logTruncated: boolean;
      logSource: ClaudeLogSource;
      /**
       * Set when the run ended early but had already written something usable — hitting the
       * turn limit, most often. The answer is real as far as it goes, and saying so is
       * better than either discarding it or presenting it as finished.
       */
      incompleteReason?: string;
      /**
       * The CLI session this run left behind, when it stopped with more to do. Handing it
       * back as `resumeSessionId` continues that conversation instead of starting over —
       * which on a run that spent twenty minutes establishing context is the difference
       * between finishing and paying for it all again.
       */
      sessionId?: string;
    }
  | { ok: false; error: string; cancelled?: boolean };

/** Where the time is going, reported by the main process as it happens. */
export type ClaudePhase = 'fetching-log' | 'analysing' | 'done';

export interface ClaudeProgress {
  requestId: string;
  phase: ClaudePhase;
  /** Log bytes fetched so far (`fetching-log`). */
  bytes?: number;
  /** Final log size handed to the model (`analysing`). */
  logBytes?: number;
  logTruncated?: boolean;
  /** A piece of the reply as it is written (`analysing`). */
  chunk?: string;
  /** True while re-attempting a log fetch that failed. */
  retrying?: boolean;
  /** The CLI rejected the tool flags, so this run can't investigate. */
  toolsUnavailable?: boolean;
  /** A one-line description of a tool call Claude just made. */
  activity?: string;
  logSource?: ClaudeLogSource;
}

/** A main-process diagnostic line, for the DevTools console. */
export interface ClaudeLogEvent {
  requestId: string;
  message: string;
  detail?: unknown;
}

/** The whole run's failed steps, fetched with `gh` — see runLog in claudeBridge.cjs. */
export type ClaudeRunLogResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

interface ClaudeApi {
  probe: () => Promise<ClaudeToolStatus>;
  runLog?: (payload: {
    owner: string;
    repo: string;
    runId: number;
  }) => Promise<ClaudeRunLogResult>;
  analyze: (payload: ClaudeAnalyzeRequest) => Promise<ClaudeAnalyzeResult>;
  cancel: (requestId: string) => Promise<boolean>;
  onProgress: (callback: (progress: ClaudeProgress) => void) => () => void;
  onLog?: (callback: (event: ClaudeLogEvent) => void) => () => void;
}

function api(): ClaudeApi | undefined {
  return (globalThis as unknown as { desktop?: { claude?: ClaudeApi } }).desktop?.claude;
}

/** True when the desktop shell exposes the bridge at all. */
export function claudeBridgeAvailable(): boolean {
  return api() !== undefined;
}

/**
 * `claude` is the only hard requirement. `gh` is preferred — it yields the whole run's
 * failed-step log — but the app can hand over a per-job log it already fetched, so a
 * missing or unauthenticated `gh` degrades the analysis rather than blocking it.
 */
export function claudeToolsReady(status: ClaudeToolStatus): boolean {
  return status.claude;
}

/** True when `gh` can supply the richer whole-run log. */
export function ghLogAvailable(status: ClaudeToolStatus): boolean {
  return status.gh && status.ghAuthenticated;
}

export async function probeClaudeTools(): Promise<ClaudeToolStatus> {
  const c = api();
  if (!c) return NO_CLAUDE_TOOLS;
  try {
    return await c.probe();
  } catch {
    return NO_CLAUDE_TOOLS;
  }
}

export async function analyzeWithClaude(
  request: ClaudeAnalyzeRequest,
): Promise<ClaudeAnalyzeResult> {
  const c = api();
  if (!c) return { ok: false, error: 'Not running in the desktop app.' };
  try {
    return await c.analyze(request);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Stop an in-flight analysis, killing the local processes behind it. */
export async function cancelClaudeAnalysis(requestId: string): Promise<void> {
  const c = api();
  if (!c?.cancel) return;
  try {
    await c.cancel(requestId);
  } catch {
    /* nothing left to stop */
  }
}

/**
 * Pipe the main process's diagnostics into the renderer console, so what `gh` and
 * `claude` actually did is visible in DevTools rather than only in the launching
 * terminal. Optional on the bridge, so an older preload doesn't break the app.
 */
export function forwardClaudeLogsToConsole(
  sink: (message: string, detail?: unknown) => void,
): () => void {
  const c = api();
  if (!c?.onLog) return () => {};
  try {
    return c.onLog((event) => sink(event.message, event.detail));
  } catch {
    return () => {};
  }
}

/**
 * Fetch the whole run's failed-step log through the local `gh`.
 *
 * Distinct from the app's own per-job log: this one covers every failed step of the run,
 * which is the only way to see an upstream job's output when the failure you clicked is an
 * aggregator. Desktop only, and optional on the bridge so an older preload degrades to
 * offering just the fast log.
 */
export async function fetchRunLogViaGh(
  owner: string,
  repo: string,
  runId: number,
): Promise<ClaudeRunLogResult> {
  const c = api();
  if (!c?.runLog) return { ok: false, error: 'The desktop app’s gh bridge is not available.' };
  try {
    return await c.runLog({ owner, repo, runId });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Where the desktop app writes its diagnostics, so it can be found without guessing at
 * platform-specific paths. Null in a browser, which has no such file.
 */
export async function diagnosticsLogPath(): Promise<{ file: string; dir: string } | null> {
  const logs = (globalThis as unknown as {
    desktop?: { logs?: { path?: () => Promise<{ file: string; dir: string }> } };
  }).desktop?.logs;
  if (!logs?.path) return null;
  try {
    return await logs.path();
  } catch {
    return null;
  }
}

/** Open the log folder in the OS file manager. */
export async function revealDiagnosticsLog(): Promise<void> {
  const logs = (globalThis as unknown as { desktop?: { logs?: { reveal?: () => Promise<unknown> } } })
    .desktop?.logs;
  try {
    await logs?.reveal?.();
  } catch {
    /* nothing to open */
  }
}

/** Subscribe to progress events; returns an unsubscribe. No-op off desktop. */
export function onClaudeProgress(callback: (progress: ClaudeProgress) => void): () => void {
  const c = api();
  if (!c?.onProgress) return () => {};
  try {
    return c.onProgress(callback);
  } catch {
    return () => {};
  }
}

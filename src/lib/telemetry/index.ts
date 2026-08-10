/**
 * The telemetry facade — the entire surface the app is allowed to touch.
 *
 * **There is no `track(name, attributes)` and there never will be.** A generic event API is how
 * telemetry systems end up shipping repository names, branch names and file paths: not through
 * malice, but because someone needed one more dimension at 5pm and a string parameter was right
 * there. Every dimension here is a number from a fixed registry, and the main process rejects any
 * id it does not recognise — so even a fully compromised renderer cannot introduce a new one.
 *
 * Notice there is no string parameter anywhere in this file's exported types.
 *
 * **StrictMode.** `src/main.tsx` wraps the tree in `React.StrictMode`, which double-invokes effects
 * in development. Call `featureUsed` from event handlers only — never from render, and never from
 * an effect body without a ref guard — or development counts will be double what production sees,
 * which is worse than not measuring at all because it looks like data.
 *
 * **Cost when there is no bridge.** One `Map` lookup and an early return. The hosted build arms no
 * timer, allocates no buffer, and sends nothing.
 */

import { IPC_FLUSH_MS } from '@jobmonitor/telemetry-schema/limits';
import type { ErrorCategory, Feature, Operation } from '@jobmonitor/telemetry-schema/registry';

import { isTelemetryAvailable, sendCrash, sendDelta, type TelemetryDelta } from './bridge.js';
import { categorizeError } from './errorCategory.js';

/** Mirrors CrashSource in the wire schema. */
export const CrashSource = {
  REACT_BOUNDARY: 4,
  WINDOW_ERROR: 5,
  RENDERER_REJECTION: 6,
} as const;

const features = new Map<number, number>();
const operations = new Map<number, number[]>();
const failures: [number, number][] = [];

let timer: ReturnType<typeof setInterval> | undefined;
/** Resolved once per call rather than cached, so a late preload still works. */
let enabled: boolean | undefined;

function active(): boolean {
  if (enabled === undefined) enabled = isTelemetryAvailable();
  return enabled;
}

/**
 * Arm the flush timer on first use.
 *
 * Lazily, so a browser tab with no bridge never creates an interval at all — a timer that fires
 * every 15 seconds forever to flush nothing is exactly the kind of thing that shows up in someone's
 * battery report and is impossible to explain.
 */
function arm(): void {
  if (timer !== undefined || typeof window === 'undefined') return;
  timer = setInterval(flush, IPC_FLUSH_MS);
  // Flush on the way out too. A tab closed 14 seconds after an action would otherwise lose it.
  window.addEventListener('pagehide', flush);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/** Hand everything accumulated to the main process and start fresh. */
export function flush(): void {
  if (features.size === 0 && operations.size === 0 && failures.length === 0) return;

  const delta: TelemetryDelta = {
    features: [...features.entries()],
    operations: [...operations.entries()],
    failures: [...failures],
  };
  features.clear();
  operations.clear();
  failures.length = 0;

  sendDelta(delta);
}

export const Telemetry = {
  /** The hot path: one Map read, one Map write, no allocation in the steady state. */
  featureUsed(feature: Feature): void {
    if (!active()) return;
    features.set(feature, (features.get(feature) ?? 0) + 1);
    arm();
  },

  operationCompleted(operation: Operation, elapsedMs: number): void {
    if (!active()) return;
    const samples = operations.get(operation);
    if (samples) samples.push(elapsedMs);
    else operations.set(operation, [elapsedMs]);
    arm();
  },

  operationFailed(operation: Operation, category: ErrorCategory): void {
    if (!active()) return;
    failures.push([operation, category]);
    arm();
  },

  /**
   * Time an async operation, recording a completion or a categorized failure.
   *
   * Always rethrows. Telemetry that swallows an error to record it is a bug factory — the caller's
   * error handling must see exactly what it would have seen without instrumentation.
   */
  async measure<T>(operation: Operation, fn: () => Promise<T>): Promise<T> {
    if (!active()) return fn();
    const started = performance.now();
    try {
      const result = await fn();
      Telemetry.operationCompleted(operation, performance.now() - started);
      return result;
    } catch (error) {
      Telemetry.operationFailed(operation, categorizeError(error));
      throw error;
    }
  },

  /**
   * Report a crash.
   *
   * Takes an error's *name* and stack, never its message — a message is the likeliest place for a
   * path or a token to reach a crash report, and a field that does not exist needs no sanitizer.
   * Sanitization of the stack happens in the main process, at the moment of persistence, so the
   * renderer structurally cannot write an unsanitized trace anywhere.
   */
  reportCrash(input: {
    name: string;
    stack?: string;
    componentStack?: string;
    source?: number;
  }): void {
    if (!active()) return;
    // Flush counters first: what the user was doing immediately before a crash is often the whole
    // explanation, and it would otherwise sit in memory that is about to disappear.
    flush();
    sendCrash({
      name: input.name,
      stack: dropMessageLine(input.stack),
      componentStack: input.componentStack,
      source: input.source ?? CrashSource.REACT_BOUNDARY,
    });
  },
};

/**
 * Remove the message line from a V8 stack before it crosses the IPC boundary.
 *
 * `error.stack` begins with `TypeError: <message>`, so a stack *contains* the message that this
 * API deliberately does not accept as a parameter. The main process drops that line again during
 * sanitization, and would catch it either way — but the message is the single likeliest place for
 * a file path or a token to appear in a crash report, and the cheapest place to remove it is
 * before it is handed to anything at all.
 */
function dropMessageLine(stack: string | undefined): string | undefined {
  if (!stack) return stack;
  const newline = stack.indexOf('\n');
  if (newline === -1) return /^\s*at\s/.test(stack) ? stack : '';
  // Only drop it if it is genuinely a header rather than a frame — some environments produce a
  // stack that begins directly with `at`.
  return /^\s*at\s/.test(stack) ? stack : stack.slice(newline + 1);
}

/** Tests only: drop the cached bridge probe and any pending counters. */
export function __resetTelemetry(): void {
  enabled = undefined;
  features.clear();
  operations.clear();
  failures.length = 0;
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

export { Feature, Operation, ErrorCategory } from '@jobmonitor/telemetry-schema/registry';
export { categorizeError } from './errorCategory.js';

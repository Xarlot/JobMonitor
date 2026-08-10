import { useCallback, useEffect, useRef, useState } from 'react';
import { Telemetry, categorizeError, type Operation } from '../lib/telemetry';

export interface UsePollingOptions {
  /** The async work to run on each tick and on manual refresh. */
  fn: () => Promise<void> | void;
  intervalMs: number;
  enabled?: boolean;
  /** Run once immediately when first enabled. */
  runOnMount?: boolean;
  /**
   * Record this poll's duration and failures as a telemetry operation.
   *
   * Instrumented here rather than at each call site because this hook already owns exactly the two
   * facts telemetry wants — how long the work took, and whether it threw — for every poller in the
   * app. One optional field covers the PR list, checks, flow runs and feature branches.
   */
  op?: Operation;
}

export interface UsePollingResult {
  refresh: () => void;
  isFetching: boolean;
  lastError: Error | null;
  lastUpdated: number | null;
}

/**
 * Generic interval poller. The latest `fn` is always used (no interval reset on
 * fn identity change), overlapping runs are suppressed, and changing `intervalMs`
 * (e.g. on tab visibility change) re-arms the timer without forcing an extra fetch.
 */
export function usePolling({
  fn,
  intervalMs,
  enabled = true,
  runOnMount = true,
  op,
}: UsePollingOptions): UsePollingResult {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const opRef = useRef(op);
  opRef.current = op;

  const [isFetching, setIsFetching] = useState(false);
  const [lastError, setLastError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsFetching(true);
    // Not Date.now(): a poll straddling an NTP correction would otherwise report a negative or
    // wildly inflated duration, and this hook runs on a timer for the whole life of the app.
    const started = performance.now();
    try {
      await fnRef.current();
      setLastError(null);
      setLastUpdated(Date.now());
      if (opRef.current) Telemetry.operationCompleted(opRef.current, performance.now() - started);
    } catch (e) {
      setLastError(e instanceof Error ? e : new Error(String(e)));
      if (opRef.current) Telemetry.operationFailed(opRef.current, categorizeError(e));
    } finally {
      inFlight.current = false;
      setIsFetching(false);
    }
  }, []);

  // Interval timer: re-armed when enabled/interval change, no immediate fetch.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => void run(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, run]);

  // Initial fetch when (re)enabled.
  useEffect(() => {
    if (enabled && runOnMount) void run();
  }, [enabled, runOnMount, run]);

  return { refresh: run, isFetching, lastError, lastUpdated };
}

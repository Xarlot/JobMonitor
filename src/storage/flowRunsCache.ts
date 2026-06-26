/**
 * Persists the last fetched workflow runs per flow so the master-detail grid can
 * render immediately from cache on reload, before the background poll returns.
 * Entries carry a timestamp and are dropped past a TTL so stale flow caches don't
 * linger. (Jobs remain lazy; the persistent ETag cache keeps the refresh cheap.)
 */

import type { WorkflowRun } from '../api/types';

const PREFIX = 'job-monitor.flowruns.';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface Stored {
  runs: WorkflowRun[];
  ts: number;
}

export function loadFlowRuns(flowId: string): WorkflowRun[] | null {
  try {
    const raw = localStorage.getItem(PREFIX + flowId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored | WorkflowRun[];
    // Backward-compat: older entries were a bare array.
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || !Array.isArray(parsed.runs)) return null;
    if (typeof parsed.ts === 'number' && Date.now() - parsed.ts > TTL_MS) {
      localStorage.removeItem(PREFIX + flowId);
      return null;
    }
    return parsed.runs;
  } catch {
    return null;
  }
}

export function saveFlowRuns(flowId: string, runs: WorkflowRun[]): void {
  try {
    const payload: Stored = { runs, ts: Date.now() };
    localStorage.setItem(PREFIX + flowId, JSON.stringify(payload));
  } catch {
    /* quota issues are non-fatal */
  }
}

export function clearFlowRuns(flowId: string): void {
  try {
    localStorage.removeItem(PREFIX + flowId);
  } catch {
    /* ignore */
  }
}

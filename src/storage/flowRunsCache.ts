/**
 * Persists the last fetched workflow runs per flow so the master-detail grid can
 * render immediately from cache on reload, before the background poll returns.
 * (Jobs remain lazy; the persistent ETag cache keeps the refresh cheap.)
 */

import type { WorkflowRun } from '../api/types';

const PREFIX = 'job-monitor.flowruns.';

export function loadFlowRuns(flowId: string): WorkflowRun[] | null {
  try {
    const raw = localStorage.getItem(PREFIX + flowId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkflowRun[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveFlowRuns(flowId: string, runs: WorkflowRun[]): void {
  try {
    localStorage.setItem(PREFIX + flowId, JSON.stringify(runs));
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

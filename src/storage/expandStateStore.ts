/**
 * Persisted master-detail expand/collapse state for the Flows grid, per flow.
 *
 * Requirement: remember which workflow runs the user expanded, but DROP that
 * state on a "critical change" so stale detail is never shown. A critical change
 * is a re-run or a new head commit for the same run id — captured by the
 * collapse key `${run_attempt}:${head_sha}`. A mere status transition
 * (in_progress -> completed) is NOT critical: the row stays expanded and its
 * jobs are simply refetched.
 */

export interface RunIdentity {
  id: number;
  run_attempt: number;
  head_sha: string;
}

export interface FlowExpandState {
  expandedRunIds: number[];
  /** runId (as string) -> collapse key last seen while reconciling. */
  collapseKeys: Record<string, string>;
}

export interface ReconcileResult {
  state: FlowExpandState;
  /** Expanded runs whose detail (jobs) cache must be discarded. */
  invalidatedRunIds: number[];
}

export const EMPTY_EXPAND_STATE: FlowExpandState = {
  expandedRunIds: [],
  collapseKeys: {},
};

export function collapseKey(run: RunIdentity): string {
  return `${run.run_attempt}:${run.head_sha}`;
}

/**
 * Reconcile persisted expand state against the freshly-fetched run list.
 * Removes expanded runs that vanished, and collapses (+ flags for cache
 * invalidation) runs whose collapse key changed.
 */
export function reconcileExpandState(
  prev: FlowExpandState,
  runs: RunIdentity[],
): ReconcileResult {
  const currentKeys = new Map<number, string>();
  for (const r of runs) currentKeys.set(r.id, collapseKey(r));

  const invalidatedRunIds: number[] = [];
  const expandedRunIds = prev.expandedRunIds.filter((id) => {
    const cur = currentKeys.get(id);
    if (cur === undefined) return false; // run no longer present -> drop silently
    const previous = prev.collapseKeys[String(id)];
    if (previous !== undefined && previous !== cur) {
      invalidatedRunIds.push(id); // re-run / new commit -> collapse + invalidate
      return false;
    }
    return true;
  });

  const collapseKeys: Record<string, string> = {};
  for (const [id, key] of currentKeys) collapseKeys[String(id)] = key;

  return { state: { expandedRunIds, collapseKeys }, invalidatedRunIds };
}

const KEY_PREFIX = 'job-monitor.expand.';

export function loadExpandState(flowId: string): FlowExpandState {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + flowId);
    if (!raw) return EMPTY_EXPAND_STATE;
    const parsed = JSON.parse(raw) as Partial<FlowExpandState>;
    return {
      expandedRunIds: Array.isArray(parsed.expandedRunIds) ? parsed.expandedRunIds : [],
      collapseKeys:
        parsed.collapseKeys && typeof parsed.collapseKeys === 'object'
          ? parsed.collapseKeys
          : {},
    };
  } catch {
    return EMPTY_EXPAND_STATE;
  }
}

export function saveExpandState(flowId: string, state: FlowExpandState): void {
  try {
    localStorage.setItem(KEY_PREFIX + flowId, JSON.stringify(state));
  } catch {
    /* storage full/unavailable — non-fatal */
  }
}

export function clearExpandState(flowId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + flowId);
  } catch {
    /* ignore */
  }
}

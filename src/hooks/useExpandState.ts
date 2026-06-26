/**
 * Per-flow expand/collapse state for the master-detail grid, persisted across
 * reloads and reconciled against fresh data so that a re-run / new commit
 * (a "critical change") collapses the affected row and invalidates its jobs cache.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadExpandState,
  reconcileExpandState,
  saveExpandState,
  type FlowExpandState,
  type RunIdentity,
} from '../storage/expandStateStore';

function sameState(a: FlowExpandState, b: FlowExpandState): boolean {
  if (a.expandedRunIds.length !== b.expandedRunIds.length) return false;
  for (let i = 0; i < a.expandedRunIds.length; i++) {
    if (a.expandedRunIds[i] !== b.expandedRunIds[i]) return false;
  }
  const ak = Object.keys(a.collapseKeys);
  const bk = Object.keys(b.collapseKeys);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a.collapseKeys[k] === b.collapseKeys[k]);
}

export interface ExpandStateApi {
  expandedRunIds: number[];
  isExpanded: (runId: number) => boolean;
  toggle: (runId: number) => void;
  /** Returns expanded run ids whose jobs cache must be discarded. */
  reconcile: (runs: RunIdentity[]) => number[];
}

export function useExpandState(flowId: string): ExpandStateApi {
  const [state, setState] = useState<FlowExpandState>(() => loadExpandState(flowId));
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const loaded = loadExpandState(flowId);
    setState(loaded);
    stateRef.current = loaded;
  }, [flowId]);

  const toggle = useCallback(
    (runId: number) => {
      setState((prev) => {
        const isOpen = prev.expandedRunIds.includes(runId);
        const expandedRunIds = isOpen
          ? prev.expandedRunIds.filter((id) => id !== runId)
          : [...prev.expandedRunIds, runId];
        const next = { expandedRunIds, collapseKeys: prev.collapseKeys };
        saveExpandState(flowId, next);
        return next;
      });
    },
    [flowId],
  );

  const reconcile = useCallback(
    (runs: RunIdentity[]): number[] => {
      const result = reconcileExpandState(stateRef.current, runs);
      if (!sameState(stateRef.current, result.state)) {
        stateRef.current = result.state;
        saveExpandState(flowId, result.state);
        setState(result.state);
      }
      return result.invalidatedRunIds;
    },
    [flowId],
  );

  const isExpanded = useCallback(
    (runId: number) => state.expandedRunIds.includes(runId),
    [state],
  );

  return { expandedRunIds: state.expandedRunIds, isExpanded, toggle, reconcile };
}

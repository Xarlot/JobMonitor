/**
 * Mounts the auto-rerun engine once and shares its activity log.
 *
 * Sits inside DashboardProvider (so it reads the same PR state without a second
 * poll) but outside the tab switch, so it keeps working whichever tab is open —
 * including while Settings is up, and while the desktop app is hidden in the tray
 * (at the slower `hiddenSeconds` cadence).
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { usePrAutoRerun, type AutoRerunState } from '../hooks/usePrAutoRerun';
import { useDashboard } from './DashboardContext';
import { useFeatureBranchesState } from './FeatureBranchesContext';

const AutoRerunContext = createContext<AutoRerunState | null>(null);

export function AutoRerunProvider({ children }: { children: ReactNode }) {
  const { prs, invalidateChecks } = useDashboard();
  const featureBranches = useFeatureBranchesState();

  /**
   * Both sources, because the engine's candidate rule is "auto-merge is armed" and the
   * feature-branch tab arms it on pull requests the dashboard cannot see: theirs live
   * wholly inside the upstream, where the dashboard's fork-head filter excludes them. An
   * armed PR nobody re-runs is worse than an unarmed one — it waits forever on a flake.
   *
   * Deduped by number even though the two lists cannot currently overlap, since which of
   * two entries for one PR the engine acted on would otherwise be a coin toss.
   */
  const candidates = useMemo(() => {
    const byNumber = new Map(prs.map((e) => [e.pr.number, e]));
    for (const entry of featureBranches.prs) {
      if (!byNumber.has(entry.pr.number)) byNumber.set(entry.pr.number, entry);
    }
    return [...byNumber.values()];
  }, [prs, featureBranches.prs]);

  // A PR number belongs to one source or the other, so telling both to watch it is
  // harmless and saves the caller having to know which list it came from.
  const featureInvalidate = featureBranches.invalidateChecks;
  const invalidateBoth = useCallback(
    (prNumber: number) => {
      invalidateChecks(prNumber);
      featureInvalidate(prNumber);
    },
    [invalidateChecks, featureInvalidate],
  );

  const state = usePrAutoRerun(candidates, invalidateBoth);
  return <AutoRerunContext.Provider value={state}>{children}</AutoRerunContext.Provider>;
}

export function useAutoRerun(): AutoRerunState {
  const ctx = useContext(AutoRerunContext);
  if (!ctx) throw new Error('useAutoRerun must be used within AutoRerunProvider');
  return ctx;
}

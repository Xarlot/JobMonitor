/**
 * Mounts the feature-branch poll once and shares it.
 *
 * Sits **above** AutoRerunProvider on purpose: the pull requests this produces live
 * entirely inside the upstream repository, so the dashboard's fork-head filter never sees
 * them, and without being handed to the auto-rerun engine a single flaky check would park
 * an armed auto-merge indefinitely — which is precisely the failure this tab exists to
 * make visible.
 *
 * Inert unless the feature is switched on; see `useFeatureBranches`.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useFeatureBranches, type FeatureBranchesState } from '../hooks/useFeatureBranches';

const FeatureBranchesContext = createContext<FeatureBranchesState | null>(null);

export function FeatureBranchesProvider({ children }: { children: ReactNode }) {
  const state = useFeatureBranches();
  return (
    <FeatureBranchesContext.Provider value={state}>{children}</FeatureBranchesContext.Provider>
  );
}

export function useFeatureBranchesState(): FeatureBranchesState {
  const ctx = useContext(FeatureBranchesContext);
  if (!ctx) throw new Error('useFeatureBranchesState must be used within FeatureBranchesProvider');
  return ctx;
}

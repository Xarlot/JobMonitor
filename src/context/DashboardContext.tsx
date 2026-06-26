/**
 * Runs the PR dashboard polling once and shares it, so both the Pull requests
 * tab and the Overview read the same live state without double-polling.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useGitHubDashboard, type DashboardState } from '../hooks/useGitHubDashboard';

const DashboardContext = createContext<DashboardState | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const state = useGitHubDashboard();
  return <DashboardContext.Provider value={state}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardState {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}

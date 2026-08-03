/**
 * Mounts the auto-rerun engine once and shares its activity log.
 *
 * Sits inside DashboardProvider (so it reads the same PR state without a second
 * poll) but outside the tab switch, so it keeps working whichever tab is open —
 * including while Settings is up, and while the desktop app is hidden in the tray
 * (at the slower `hiddenSeconds` cadence).
 */

import { createContext, useContext, type ReactNode } from 'react';
import { usePrAutoRerun, type AutoRerunState } from '../hooks/usePrAutoRerun';
import { useDashboard } from './DashboardContext';

const AutoRerunContext = createContext<AutoRerunState | null>(null);

export function AutoRerunProvider({ children }: { children: ReactNode }) {
  const { prs, invalidateChecks } = useDashboard();
  const state = usePrAutoRerun(prs, invalidateChecks);
  return <AutoRerunContext.Provider value={state}>{children}</AutoRerunContext.Provider>;
}

export function useAutoRerun(): AutoRerunState {
  const ctx = useContext(AutoRerunContext);
  if (!ctx) throw new Error('useAutoRerun must be used within AutoRerunProvider');
  return ctx;
}

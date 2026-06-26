/**
 * Shared "compact" view preference (persisted). When compact, inner job/check
 * lists hide quiet items (success + skipped/neutral) and show only what needs
 * attention (failures, in-progress, pending). Used by both the Flows view and
 * the PR list. The hook tolerates being used without a provider (defaults to
 * non-compact) so leaf tables never crash.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { OverallStatus } from '../api/types';

const STORAGE_KEY = 'job-monitor.compact';

interface ViewModeValue {
  compact: boolean;
  setCompact: (next: boolean) => void;
}

const ViewModeContext = createContext<ViewModeValue | null>(null);

/** In compact mode these statuses are hidden (quiet / nothing to act on). */
export function isQuietStatus(status: OverallStatus): boolean {
  return status === 'success' || status === 'neutral';
}

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const [compact, setCompactState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setCompact = useCallback((next: boolean) => {
    setCompactState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ compact, setCompact }), [compact, setCompact]);
  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
}

export function useViewMode(): ViewModeValue {
  return useContext(ViewModeContext) ?? { compact: false, setCompact: () => {} };
}

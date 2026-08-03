/**
 * The failure list, derived once and shared.
 *
 * Two consumers need it — the nav badge (always mounted, for the count) and the
 * Failures tab (for the list) — and collecting it is not free: it walks every
 * check-run of every tracked PR and fetches the jobs of failing flow runs. Deriving
 * it per consumer would double both the work and those requests, and could let the
 * badge and the list disagree.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  collectFailedJobs,
  groupFailures,
  type FailedJobRef,
  type FailureGroup,
} from '../lib/failures';
import { useFlowFailures } from '../hooks/useFlowFailures';
import { useConfig } from './ConfigContext';
import { useDashboard } from './DashboardContext';

interface FailuresValue {
  /** Every failing job: open PRs, then merged PRs, then flows. */
  failures: FailedJobRef[];
  /** The same failures grouped by the PR or flow they came from. */
  groups: FailureGroup[];
}

const FailuresContext = createContext<FailuresValue | null>(null);

export function FailuresProvider({ children }: { children: ReactNode }) {
  const { config } = useConfig();
  const { prs, mergedPrs } = useDashboard();
  const flowFailures = useFlowFailures();

  const failures = useMemo(
    () => collectFailedJobs(prs, mergedPrs, flowFailures, config.upstream),
    [prs, mergedPrs, flowFailures, config.upstream],
  );
  const groups = useMemo(() => groupFailures(failures), [failures]);
  const value = useMemo(() => ({ failures, groups }), [failures, groups]);

  return <FailuresContext.Provider value={value}>{children}</FailuresContext.Provider>;
}

export function useFailures(): FailuresValue {
  const ctx = useContext(FailuresContext);
  if (!ctx) throw new Error('useFailures must be used within FailuresProvider');
  return ctx;
}

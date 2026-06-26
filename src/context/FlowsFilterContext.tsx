/**
 * Shared, interactive filter for the Flows view. Lives in context (not config)
 * so the Flows toolbar can set it and each flow's runtime can read it — e.g. to
 * eagerly fetch jobs when a job-level filter is active.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type RunStatusFilter = 'all' | 'active' | 'failed' | 'success';
export type JobStateFilter = 'any' | 'success' | 'failure' | 'in_progress' | 'not_skipped';

export interface FlowsFilter {
  runStatus: RunStatusFilter;
  /** Substring match on job name; empty disables the job filter. */
  jobName: string;
  jobState: JobStateFilter;
}

export const DEFAULT_FLOWS_FILTER: FlowsFilter = {
  runStatus: 'all',
  jobName: '',
  jobState: 'any',
};

export function isJobFilterActive(filter: FlowsFilter): boolean {
  return filter.jobName.trim().length > 0;
}

interface FlowsFilterContextValue {
  filter: FlowsFilter;
  setFilter: (next: FlowsFilter) => void;
}

const FlowsFilterContext = createContext<FlowsFilterContextValue | null>(null);

export function FlowsFilterProvider({ children }: { children: ReactNode }) {
  const [filter, setFilter] = useState<FlowsFilter>(DEFAULT_FLOWS_FILTER);
  const value = useMemo(() => ({ filter, setFilter }), [filter]);
  return <FlowsFilterContext.Provider value={value}>{children}</FlowsFilterContext.Provider>;
}

export function useFlowsFilter(): FlowsFilterContextValue {
  const ctx = useContext(FlowsFilterContext);
  if (!ctx) throw new Error('useFlowsFilter must be used within FlowsFilterProvider');
  return ctx;
}

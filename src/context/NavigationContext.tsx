/**
 * Moving between tabs, for the things that live on one and are acted on from another.
 *
 * A context rather than props because the callers are deep and scattered — a check-run row
 * sits under PrList → PrRow → CheckRunsTable, a job row under FlowsView → FlowCard →
 * JobsTable — and threading a handler through each intermediate would put navigation in the
 * signature of components that have nothing to do with it.
 *
 * Every entry is a *request* to navigate, carrying an id and a counter. The counter is what
 * makes asking twice for the same thing work: without it, a second click after scrolling
 * away would change no state and read as a broken button.
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface NavigationRequest<T> {
  target: T | null;
  /** Bumped on every request, including a repeat of the same target. */
  nonce: number;
}

export interface Navigation {
  /** Open the Pull requests tab at one pull request. */
  openPr: (prNumber: number) => void;
  /** Open the Failures tab at one failure, by its `FailedJobRef.key`. */
  openFailure: (failureKey: string) => void;
}

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({
  value,
  children,
}: {
  value: Navigation;
  children: ReactNode;
}) {
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/**
 * Null outside the provider rather than throwing.
 *
 * These components render in places with no navigation to offer — a dialog opened from the
 * Overview, a table in a test — and a control that simply isn't there is the right answer,
 * not a crash.
 */
export function useNavigation(): Navigation | null {
  return useContext(NavigationContext);
}

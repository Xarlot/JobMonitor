/**
 * Seconds since a run started, ticking while it runs.
 *
 * Small, but shared: the progress strip and the analysis dialog both have to show that a
 * minute-long call is still moving, and two copies of a `setInterval` would be two chances to
 * leave one running. Stops when `running` goes false, so a finished run's number holds still.
 */

import { useEffect, useState } from 'react';

export function useElapsed(startedAt: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running, startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.round((now - startedAt) / 1000));
}

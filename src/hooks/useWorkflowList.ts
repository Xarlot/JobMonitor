/**
 * The repo's workflow list, with loading/error state, for settings fields that
 * need to show or filter it. The fetch itself is ETag-cached by the client, so
 * several consumers cost one request per repo.
 */

import { useEffect, useState } from 'react';
import { fetchWorkflows } from '../api/workflows';
import type { Workflow } from '../api/types';

export interface WorkflowListState {
  /** null until the first fetch resolves. */
  workflows: Workflow[] | null;
  loading: boolean;
  error: string | null;
}

export function useWorkflowList(owner: string, repo: string): WorkflowListState {
  const [state, setState] = useState<WorkflowListState>({
    workflows: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!owner || !repo) return;
    let active = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchWorkflows(owner, repo)
      .then((workflows) => {
        if (active) setState({ workflows, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (active) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          }));
        }
      });
    return () => {
      active = false;
    };
  }, [owner, repo]);

  return state;
}

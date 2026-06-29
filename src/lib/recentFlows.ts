/**
 * Pure helpers for the "browse recent workflow runs" picker: turn a repo-wide
 * list of runs into the distinct workflow × branch × event combinations a user
 * can pick to pre-fill a flow.
 */

import type { WorkflowRun } from '../api/types';
import { workflowBasename } from './workflow';

/** The flow fields a picked combination maps onto in the editor. */
export interface FlowPick {
  /** Workflow display name (run.name), used as a sensible default flow name. */
  name: string;
  /** Workflow file basename, e.g. "ci.yml". */
  workflowFile: string;
  /** Branch the runs were on (may be empty). */
  branch: string;
  /** Trigger event, e.g. "push" / "workflow_dispatch". */
  event: string;
}

/** A distinct combination plus the aggregate info shown in the picker. */
export interface RecentFlow extends FlowPick {
  key: string;
  count: number;
  /** Latest run for this combination (drives status + recency). */
  latest: WorkflowRun;
}

function runTime(r: WorkflowRun): number {
  return Date.parse(r.run_started_at ?? r.created_at);
}

/**
 * Collapse recent runs into distinct workflow × branch × event combinations,
 * sorted most-recent first. Does not assume input ordering: the latest run per
 * combination is chosen by timestamp.
 */
export function recentFlowsFromRuns(runs: WorkflowRun[]): RecentFlow[] {
  const byKey = new Map<string, RecentFlow>();
  for (const r of runs) {
    const file = r.path ? workflowBasename(r.path) : '';
    const branch = r.head_branch ?? '';
    const key = `${file || r.name || r.workflow_id || ''}::${branch}::${r.event}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (runTime(r) > runTime(existing.latest)) existing.latest = r;
    } else {
      byKey.set(key, {
        key,
        name: (r.name ?? '').trim() || file || 'workflow',
        workflowFile: file,
        branch,
        event: r.event,
        count: 1,
        latest: r,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => runTime(b.latest) - runTime(a.latest));
}

/**
 * Hour-truncated GitHub `created` filter for runs in the last `windowHours`.
 * Truncating to the hour keeps the request path (and its ETag cache key) stable
 * across reopens within the same hour.
 */
export function sinceCreated(windowHours: number, now: number = Date.now()): string {
  const d = new Date(now - windowHours * 3600_000);
  d.setMinutes(0, 0, 0);
  // GitHub's `created` filter wants ISO 8601 without milliseconds.
  return `>=${d.toISOString().slice(0, 19)}Z`;
}

import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../api/types';
import { recentFlowsFromRuns, sinceCreated } from '../lib/recentFlows';

function run(over: Partial<WorkflowRun> & { id: number }): WorkflowRun {
  return {
    name: 'CI',
    display_title: 'CI',
    head_branch: 'main',
    head_sha: 'sha',
    run_number: over.id,
    run_attempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/o/r/actions/runs/${over.id}`,
    created_at: '2026-06-29T00:00:00Z',
    updated_at: '2026-06-29T00:00:00Z',
    run_started_at: '2026-06-29T00:00:00Z',
    path: '.github/workflows/ci.yml',
    workflow_id: 1,
    ...over,
  };
}

describe('recentFlowsFromRuns', () => {
  it('groups by workflow file × branch × event and counts each', () => {
    const combos = recentFlowsFromRuns([
      run({ id: 1, event: 'push', head_branch: 'main', run_started_at: '2026-06-29T01:00:00Z' }),
      run({ id: 2, event: 'push', head_branch: 'main', run_started_at: '2026-06-29T03:00:00Z' }),
      run({ id: 3, event: 'pull_request', head_branch: 'feat', run_started_at: '2026-06-29T02:00:00Z' }),
    ]);
    expect(combos).toHaveLength(2);
    const push = combos.find((c) => c.event === 'push')!;
    expect(push.count).toBe(2);
    expect(push.workflowFile).toBe('ci.yml');
    expect(push.branch).toBe('main');
    // Latest run per combo is chosen by timestamp regardless of input order.
    expect(push.latest.id).toBe(2);
  });

  it('sorts combinations most-recent first', () => {
    const combos = recentFlowsFromRuns([
      run({ id: 1, event: 'push', run_started_at: '2026-06-29T01:00:00Z' }),
      run({ id: 2, event: 'schedule', run_started_at: '2026-06-29T05:00:00Z' }),
    ]);
    expect(combos.map((c) => c.event)).toEqual(['schedule', 'push']);
  });

  it('uses the file basename as a fallback name and tolerates a missing branch', () => {
    const [combo] = recentFlowsFromRuns([
      run({ id: 1, name: '', head_branch: null, path: '.github/workflows/release.yml' }),
    ]);
    expect(combo.name).toBe('release.yml');
    expect(combo.branch).toBe('');
  });
});

describe('sinceCreated', () => {
  it('builds an hour-truncated >= filter window', () => {
    const now = Date.parse('2026-06-29T10:37:42Z');
    expect(sinceCreated(24, now)).toBe('>=2026-06-28T10:00:00Z');
  });
});

import { describe, expect, it } from 'vitest';
import { mockFetch } from '../mocks/mockFetch';
import { repoRunsPath } from '../api/endpoints';
import { recentFlowsFromRuns, sinceCreated } from '../lib/recentFlows';
import type { WorkflowRunsResponse } from '../api/types';

const API = 'https://api.github.com';

async function fetchRuns(page = 1): Promise<WorkflowRunsResponse> {
  const url = API + repoRunsPath('o', 'r', { created: sinceCreated(24), perPage: 100, page });
  const res = await mockFetch(url);
  return (await res.json()) as WorkflowRunsResponse;
}

describe('mock repo runs over the last day', () => {
  it('returns runs across the whole 24h window and excludes older ones', async () => {
    const { workflow_runs } = await fetchRuns();
    const now = Date.now();

    // Every returned run is within the last day (allow the hour-truncated edge).
    for (const r of workflow_runs) {
      expect(now - Date.parse(r.created_at)).toBeLessThanOrEqual(25 * 3600_000);
    }
    // The 22h-old cron run is included; the 30h-old docs run is filtered out.
    const files = workflow_runs.map((r) => r.path);
    expect(files).toContain('.github/workflows/java-cron.yml');
    expect(files).not.toContain('.github/workflows/docs.yml');

    // The newest and the oldest-within-window runs are hours apart, not minutes —
    // i.e. we really span the day rather than a 2h sliver.
    const times = workflow_runs.map((r) => Date.parse(r.created_at));
    const spanHours = (Math.max(...times) - Math.min(...times)) / 3600_000;
    expect(spanHours).toBeGreaterThan(12);
  });

  it('groups into several distinct flows covering every trigger', async () => {
    const combos = recentFlowsFromRuns((await fetchRuns()).workflow_runs);
    expect(combos.length).toBeGreaterThanOrEqual(5);
    expect(new Set(combos.map((c) => c.event))).toEqual(
      new Set(['workflow_dispatch', 'pull_request', 'push', 'schedule']),
    );
  });

  it('has no more pages past the first (paging stops)', async () => {
    expect((await fetchRuns(2)).workflow_runs).toHaveLength(0);
  });
});

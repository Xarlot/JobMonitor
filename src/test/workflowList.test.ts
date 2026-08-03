/**
 * `fetchWorkflows` must return the repo's *whole* workflow list. It feeds regex
 * (pattern) flow expansion and workflow-name resolution, and both were silently
 * limited to the first 100 workflows while it read a single page.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEtagCache, setFetchImpl, setTokenProvider } from '../api/githubClient';
import { workflowsPath } from '../api/endpoints';
import { fetchWorkflows } from '../api/workflows';
import { matchWorkflows } from '../lib/flowPatterns';
import type { Workflow } from '../api/types';

function workflow(i: number): Workflow {
  return { id: i, name: `flow ${i}`, path: `.github/workflows/flow-${i}.yml`, state: 'active' };
}

/** A repo with `total` workflows, served 100 per page like the real API. */
function pagedRepo(total: number) {
  const all = Array.from({ length: total }, (_, i) => workflow(i + 1));
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const parsed = new URL(String(url));
    calls.push(parsed.search);
    const page = Number(parsed.searchParams.get('page') ?? '1');
    const perPage = Number(parsed.searchParams.get('per_page') ?? '100');
    const slice = all.slice((page - 1) * perPage, page * perPage);
    return new Response(JSON.stringify({ total_count: all.length, workflows: slice }), {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  });
  setFetchImpl(fetchMock as unknown as typeof fetch);
  return { all, calls, fetchMock };
}

describe('workflowsPath', () => {
  it('keeps page 1 free of a page param (stable ETag cache key)', () => {
    expect(workflowsPath('acme', 'rocket')).toBe('/repos/acme/rocket/actions/workflows?per_page=100');
    expect(workflowsPath('acme', 'rocket', 1)).toBe(
      '/repos/acme/rocket/actions/workflows?per_page=100',
    );
    expect(workflowsPath('a b', 'r', 3)).toBe('/repos/a%20b/r/actions/workflows?per_page=100&page=3');
  });
});

describe('fetchWorkflows', () => {
  beforeEach(() => {
    clearEtagCache();
    setTokenProvider(() => 'test-token');
  });

  it('follows pagination past the first 100 workflows', async () => {
    const { all, calls } = pagedRepo(250);
    const got = await fetchWorkflows('o', 'r');
    expect(got).toHaveLength(250);
    expect(got.map((w) => w.id)).toEqual(all.map((w) => w.id));
    expect(calls).toHaveLength(3);
    expect(calls[0]).not.toContain('&page=');
    expect(calls[1]).toContain('&page=2');
    expect(calls[2]).toContain('&page=3');
  });

  it('stops after one request when the list fits on a page', async () => {
    const { fetchMock } = pagedRepo(9);
    expect(await fetchWorkflows('o', 'r')).toHaveLength(9);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops on an exactly-full last page instead of looping', async () => {
    const { fetchMock } = pagedRepo(200);
    expect(await fetchWorkflows('o', 'r')).toHaveLength(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('merges pages by workflow id (a workflow added mid-walk can repeat)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => workflow(i + 1));
    // Second page shifted by one, as if a workflow were inserted between requests.
    const page2 = Array.from({ length: 40 }, (_, i) => workflow(i + 100));
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const page = Number(new URL(String(url)).searchParams.get('page') ?? '1');
      return new Response(
        JSON.stringify({ total_count: 140, workflows: page === 1 ? page1 : page2 }),
        { status: 200, headers: new Headers({ 'content-type': 'application/json' }) },
      );
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    const got = await fetchWorkflows('o', 'r');
    expect(got).toHaveLength(139);
    expect(new Set(got.map((w) => w.id)).size).toBe(139);
  });

  it('a regex flow can match a workflow that lives past page 1', async () => {
    pagedRepo(250);
    const workflows = await fetchWorkflows('o', 'r');
    const hits = matchWorkflows(workflows, {
      pattern: '^flow-24[0-9]\\.yml$',
      by: 'file',
      caseSensitive: false,
      maxMatches: 12,
    });
    expect(hits.map((w) => w.id)).toEqual([240, 241, 242, 243, 244, 245, 246, 247, 248, 249]);
  });
});

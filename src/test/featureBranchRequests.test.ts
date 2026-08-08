/**
 * That every request the feature-branch tab makes goes through the shared client — so it is
 * counted against the hourly budget, and conditional so a repeat costs a 304 rather than
 * quota.
 *
 * Worth asserting rather than assuming: the endpoints here were new, and one of them builds
 * its own query string. A call that reached `fetch` directly, or a path that varied between
 * polls, would work perfectly and quietly spend the rate limit — the kind of fault that only
 * shows up as "why am I out of quota", long after the change that caused it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBranchesUnder, fetchFeatureBranches } from '../api/featureBranches';
import { verifyForkParent, syncForkBranch } from '../api/forkSync';
import { createPull, fetchPullDetail, findOpenPull } from '../api/pullRequests';
import { comparePath } from '../api/endpoints';
import { clearEtagCache, ghGet, setFetchImpl, setTokenProvider } from '../api/githubClient';
import { getRequestStats, recordRequest } from '../api/requestStats';
import { recordPushAccess, recordTokenScopes, resetTokenCapability } from '../api/tokenCapability';
import type { Comparison } from '../api/types';

/** A stand-in GitHub that honours If-None-Match, as the real one does. */
function conditionalGitHub(bodyFor: (path: string) => unknown) {
  const seen = new Map<string, string>();
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = u.pathname + u.search;
    const body = JSON.stringify(bodyFor(key));
    const etag = `W/"${key.length}-${body.length}"`;
    const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
    seen.set(key, etag);
    const headers = new Headers({
      'content-type': 'application/json',
      etag,
      'x-ratelimit-remaining': '4999',
    });
    if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
    return new Response(body, { status: 200, headers });
  });
}

const REFS = [{ ref: 'refs/heads/feature/a', object: { sha: 'aaa', type: 'commit' } }];

function bodyFor(path: string): unknown {
  if (path.includes('/git/matching-refs/')) return REFS;
  if (path.includes('/compare/')) {
    return { status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0, commits: [], files: [] };
  }
  if (/\/pulls\/\d+$/.test(path)) return { number: 7, head: { sha: 'h' }, base: { ref: 'b' } };
  if (path.includes('/pulls')) return [];
  return { name: 'r', full_name: 'me/r', fork: true, parent: { full_name: 'up/r' }, private: false };
}

beforeEach(() => {
  clearEtagCache();
  localStorage.clear();
  resetTokenCapability();
  setTokenProvider(() => 'token');
  recordTokenScopes(new Headers({ 'x-oauth-scopes': 'repo, workflow' }));
  recordPushAccess(true);
});

afterEach(() => {
  setFetchImpl(globalThis.fetch);
  resetTokenCapability();
  vi.restoreAllMocks();
});

/** Requests counted while `fn` runs. */
async function counted(fn: () => Promise<unknown>): Promise<{ fresh: number; cached: number }> {
  const before = getRequestStats();
  await fn();
  const after = getRequestStats();
  return { fresh: after.fresh - before.fresh, cached: after.cached - before.cached };
}

describe('every read is counted and conditional', () => {
  /**
   * One case per endpoint the tab added. Each is fetched twice: the first must be counted
   * as fresh, the second must come back 304 and be counted as cached — which only happens
   * if the path is byte-identical (it doubles as the cache key) and the ETag was stored.
   */
  const cases: [string, () => Promise<unknown>][] = [
    ['matching refs', () => fetchBranchesUnder('up', 'r', 'feature/')],
    ['branch intersection', () => fetchFeatureBranches({ owner: 'up', repo: 'r' }, { owner: 'me', repo: 'r' }, 'feature/')],
    ['fork parent', () => verifyForkParent({ owner: 'me', repo: 'r' }, { owner: 'up', repo: 'r' })],
    ['open pull lookup', () => findOpenPull('up', 'r', { headOwner: 'me', head: 'feature/a', base: 'feature/a' })],
    ['pull detail', () => fetchPullDetail('up', 'r', 7)],
    ['comparison', () => ghGet<Comparison>(comparePath('me', 'r', 'up:aaa', 'bbb'))],
  ];

  for (const [name, call] of cases) {
    it(`${name}: fresh once, then 304`, async () => {
      setFetchImpl(conditionalGitHub(bodyFor) as unknown as typeof fetch);

      const first = await counted(call);
      expect(first.fresh, `${name} was not counted`).toBeGreaterThan(0);
      expect(first.cached).toBe(0);

      const second = await counted(call);
      expect(second.cached, `${name} did not re-use its ETag`).toBe(first.fresh);
      expect(second.fresh, `${name} spent quota on a repeat`).toBe(0);
    });
  }
});

describe('writes', () => {
  /** A write has no cacheable representation, but it still costs quota and must be counted. */
  it('are counted, and never conditional', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBeNull();
      return new Response(JSON.stringify({ merge_type: 'fast-forward', base_branch: 'up:feature/a', message: 'ok' }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' }),
      });
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    const { fresh } = await counted(() => syncForkBranch('me', 'r', 'feature/a'));

    expect(fresh).toBe(1);
  });

  it('count a refusal as an error rather than losing it', async () => {
    setFetchImpl((async () =>
      new Response(JSON.stringify({ message: 'Validation Failed', errors: [] }), {
        status: 422,
        headers: new Headers({ 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' }),
      })) as unknown as typeof fetch);

    const before = getRequestStats();
    await createPull('up', 'r', { head: 'a', base: 'b', title: 't', body: '' }).catch(() => {});
    const after = getRequestStats();

    // The pre-check GET plus the refused POST: both accounted for, neither silent.
    expect(after.total).toBeGreaterThan(before.total);
    expect(after.error).toBeGreaterThan(before.error);
  });
});

describe('the stats window itself', () => {
  it('separates fresh, cached and error', () => {
    const before = getRequestStats();
    recordRequest('fresh');
    recordRequest('cached');
    recordRequest('error');
    const after = getRequestStats();
    expect(after.fresh - before.fresh).toBe(1);
    expect(after.cached - before.cached).toBe(1);
    expect(after.error - before.error).toBe(1);
  });
});

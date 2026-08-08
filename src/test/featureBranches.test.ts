import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBranchesUnder, fetchFeatureBranches } from '../api/featureBranches';
import { clearEtagCache, setFetchImpl, setTokenProvider } from '../api/githubClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' }),
  });
}

function ref(name: string, sha: string) {
  return { ref: `refs/heads/${name}`, object: { sha, type: 'commit' } };
}

/** Route by the path the client asked for, so a test can give the two repos different refs. */
function router(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    for (const [match, body] of Object.entries(routes)) {
      if (path.startsWith(match)) return jsonResponse(body);
    }
    return jsonResponse({ message: 'Not Found' }, 404);
  });
}

beforeEach(() => {
  clearEtagCache();
  setTokenProvider(() => 'token');
});

afterEach(() => {
  setFetchImpl(globalThis.fetch);
  vi.restoreAllMocks();
});

describe('fetchBranchesUnder', () => {
  it('asks for the prefix with its slashes intact', async () => {
    const fetchMock = router({ '/repos/o/r/git/matching-refs/heads/feature/': [] });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await fetchBranchesUnder('o', 'r', 'feature/');

    const requested = new URL(fetchMock.mock.calls[0][0] as string).pathname;
    // Percent-encoding these would make the prefix match nothing at all.
    expect(requested).toBe('/repos/o/r/git/matching-refs/heads/feature/');
  });

  it('strips the refs/heads/ qualification', async () => {
    setFetchImpl(
      router({ '/repos/o/r/git/': [ref('feature/a', 'aaa')] }) as unknown as typeof fetch,
    );
    expect([...(await fetchBranchesUnder('o', 'r', 'feature/'))]).toEqual([['feature/a', 'aaa']]);
  });

  /** No matching ref is a 404, and "this repo has no feature branches" is not an error. */
  it('reads a 404 as an empty list', async () => {
    setFetchImpl(router({}) as unknown as typeof fetch);
    expect((await fetchBranchesUnder('o', 'r', 'feature/')).size).toBe(0);
  });

  /** An exact single match answers with an object rather than an array. */
  it('survives a single-object answer', async () => {
    setFetchImpl(
      router({ '/repos/o/r/git/': ref('feature/only', 'sha') }) as unknown as typeof fetch,
    );
    expect((await fetchBranchesUnder('o', 'r', 'feature/')).get('feature/only')).toBe('sha');
  });

  it('follows pagination until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ref(`feature/${i}`, `sha${i}`));
    const fetchMock = vi.fn(async (url: string) => {
      const search = new URL(url).search;
      return jsonResponse(search.includes('page=2') ? [ref('feature/last', 'z')] : page1);
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    const out = await fetchBranchesUnder('o', 'r', 'feature/');
    expect(out.size).toBe(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchFeatureBranches', () => {
  it('keeps only the branches both repositories have', async () => {
    setFetchImpl(
      router({
        '/repos/up/r/git/': [ref('feature/shared', 'u1'), ref('feature/upstream-only', 'u2')],
        '/repos/me/r/git/': [ref('feature/shared', 'f1'), ref('feature/mine-only', 'f2')],
      }) as unknown as typeof fetch,
    );

    const branches = await fetchFeatureBranches(
      { owner: 'up', repo: 'r' },
      { owner: 'me', repo: 'r' },
      'feature/',
    );
    expect(branches).toEqual([{ name: 'feature/shared', upstreamSha: 'u1', forkSha: 'f1' }]);
  });

  /**
   * Git refs are case-sensitive and both spellings can exist at once, so pairing them
   * would silently point an action at a different branch from the one displayed.
   */
  it('does not pair branches that differ only in case', async () => {
    setFetchImpl(
      router({
        '/repos/up/r/git/': [ref('feature/Payments', 'u1')],
        '/repos/me/r/git/': [ref('feature/payments', 'f1')],
      }) as unknown as typeof fetch,
    );
    expect(
      await fetchFeatureBranches({ owner: 'up', repo: 'r' }, { owner: 'me', repo: 'r' }, 'feature/'),
    ).toEqual([]);
  });

  it('sorts by name', async () => {
    const both = [ref('feature/b', 'x'), ref('feature/a', 'y')];
    setFetchImpl(
      router({ '/repos/up/r/git/': both, '/repos/me/r/git/': both }) as unknown as typeof fetch,
    );
    const branches = await fetchFeatureBranches(
      { owner: 'up', repo: 'r' },
      { owner: 'me', repo: 'r' },
      'feature/',
    );
    expect(branches.map((b) => b.name)).toEqual(['feature/a', 'feature/b']);
  });
});

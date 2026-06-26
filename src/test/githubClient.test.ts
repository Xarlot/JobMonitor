import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEtagCache,
  ghGet,
  GitHubApiError,
  setFetchImpl,
  setTokenProvider,
} from '../api/githubClient';
import { __resetRateLimit, getRateLimit } from '../api/rateLimit';

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const h = new Headers({
    'content-type': 'application/json',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': '2000000000',
  });
  if (init.etag) h.set('etag', init.etag);
  return new Response(init.status === 304 ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: h,
  });
}

describe('githubClient', () => {
  beforeEach(() => {
    clearEtagCache();
    __resetRateLimit();
    setTokenProvider(() => 'test-token');
  });

  it('sends a bearer token and parses JSON', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      expect(auth).toBe('Bearer test-token');
      return jsonResponse([{ id: 1 }], { etag: '"v1"' });
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    const res = await ghGet<{ id: number }[]>('/repos/o/r/pulls');
    expect(res.data).toEqual([{ id: 1 }]);
    expect(res.notModified).toBe(false);
    expect(getRateLimit().remaining).toBe(4999);
  });

  it('uses If-None-Match and returns cached data on 304', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      if (call === 1) return jsonResponse([{ id: 7 }], { etag: '"abc"' });
      // Second call must carry If-None-Match and gets a 304.
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"abc"');
      return jsonResponse(null, { status: 304, etag: '"abc"' });
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    const first = await ghGet<{ id: number }[]>('/x');
    const second = await ghGet<{ id: number }[]>('/x');
    expect(first.notModified).toBe(false);
    expect(second.notModified).toBe(true);
    expect(second.data).toEqual([{ id: 7 }]);
  });

  it('throws a rate-limit error on 403 with remaining 0', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('{}', {
        status: 403,
        headers: new Headers({ 'x-ratelimit-remaining': '0', 'retry-after': '60' }),
      });
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await expect(ghGet('/y')).rejects.toMatchObject({ isRateLimit: true } as Partial<GitHubApiError>);
  });
});

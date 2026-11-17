import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEtagCache, setFetchImpl, setTokenProvider } from '../api/githubClient';
import { __resetRateLimit } from '../api/rateLimit';
import { __resetJobPageSizes, fetchAllRunJobs } from '../api/jobs';

const TOTAL = 120;
const allJobs = Array.from({ length: TOTAL }, (_, i) => ({ id: i + 1, name: `job ${i + 1}`, steps: [] }));

/** GitHub stand-in: pages larger than `maxOk` fail the way the gateway 502 reaches `fetch`. */
function fakeGitHub(maxOk: number) {
  const seen: { perPage: number; page: number }[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    const perPage = Number(u.searchParams.get('per_page'));
    const page = Number(u.searchParams.get('page'));
    seen.push({ perPage, page });
    if (perPage > maxOk) throw new TypeError('Failed to fetch');
    const jobs = allJobs.slice((page - 1) * perPage, page * perPage);
    return new Response(JSON.stringify({ total_count: TOTAL, jobs }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  setFetchImpl(fetchMock as unknown as typeof fetch);
  return seen;
}

describe('fetchAllRunJobs', () => {
  beforeEach(() => {
    clearEtagCache();
    __resetRateLimit();
    __resetJobPageSizes();
    setTokenProvider(() => 'test-token');
  });

  it('reads every page at the full page size', async () => {
    const seen = fakeGitHub(100);
    const jobs = await fetchAllRunJobs('o', 'r', 1);
    expect(jobs.map((j) => j.id)).toEqual(allJobs.map((j) => j.id));
    expect(seen.every((s) => s.perPage === 100)).toBe(true);
  });

  it('drops the page size when a page fails, and keeps the size that worked for the run', async () => {
    const seen = fakeGitHub(25);
    const jobs = await fetchAllRunJobs('o', 'r', 7);
    expect(jobs.map((j) => j.id)).toEqual(allJobs.map((j) => j.id));
    expect(seen.slice(0, 2)).toEqual([
      { perPage: 100, page: 1 },
      { perPage: 50, page: 1 },
    ]);

    seen.length = 0;
    await fetchAllRunJobs('o', 'r', 7);
    expect(seen.every((s) => s.perPage === 25)).toBe(true);
  });

  it('gives up with the error once the smallest page fails too', async () => {
    fakeGitHub(10);
    await expect(fetchAllRunJobs('o', 'r', 9)).rejects.toThrow('Network request to GitHub failed.');
  });
});

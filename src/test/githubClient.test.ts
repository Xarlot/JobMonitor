import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEtagCache,
  BODY_TIMEOUT_MS,
  ghGet,
  ghGetBlob,
  ghGetText,
  ghPost,
  GitHubApiError,
  setFetchImpl,
  setTokenProvider,
} from '../api/githubClient';
import { __resetRateLimit, getRateLimit } from '../api/rateLimit';
import {
  recordPushAccess,
  recordTokenScopes,
  resetTokenCapability,
} from '../api/tokenCapability';

/** A response with a status and an optional JSON error body (null = empty body). */
function errorResponse(status: number, body: unknown | null): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: new Headers({ 'x-ratelimit-remaining': '4999' }),
  });
}

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

describe('ghPost', () => {
  beforeEach(() => {
    clearEtagCache();
    __resetRateLimit();
    setTokenProvider(() => 'test-token');
    // ghPost refuses to write unless capability is proven, so grant it.
    resetTokenCapability();
    recordTokenScopes(new Headers({ 'x-oauth-scopes': 'repo' }));
    recordPushAccess(true);
  });

  /** The guarantee the module header promises, enforced at the choke point. */
  it('refuses to write at all when the token is not known to be able to', async () => {
    const fetchMock = vi.fn(async () => errorResponse(201, null));
    setFetchImpl(fetchMock as unknown as typeof fetch);
    resetTokenCapability(); // e.g. token just swapped for a read-only one

    await expect(ghPost('/x')).rejects.toMatchObject({ status: 403, refusal: 'permission' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs with auth and no If-None-Match', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const h = new Headers(init?.headers);
      expect(h.get('authorization')).toBe('Bearer test-token');
      expect(h.get('if-none-match')).toBeNull();
      return errorResponse(201, null);
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await expect(ghPost('/repos/o/r/actions/runs/5/rerun-failed-jobs')).resolves.toBe(201);
  });

  /**
   * The re-run endpoints answer 201 with an empty body. Parsing it would throw a
   * bare SyntaxError, outside the GitHubApiError contract every caller relies on.
   */
  it('does not parse the body of an empty 201', async () => {
    setFetchImpl((async () => errorResponse(201, null)) as unknown as typeof fetch);
    await expect(ghPost('/x')).resolves.toBe(201);
  });

  it('accepts a 204 with no content', async () => {
    setFetchImpl((async () => new Response(null, { status: 204 })) as unknown as typeof fetch);
    await expect(ghPost('/x')).resolves.toBe(204);
  });

  it('serialises a JSON body only when one is given', async () => {
    const seen: (string | null)[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('content-type'));
      return errorResponse(201, null);
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await ghPost('/x');
    await ghPost('/x', { enable_debug_logging: true });
    expect(seen).toEqual([null, 'application/json']);
  });

  it('never writes the ETag cache, so a later GET on the same path still fetches', async () => {
    let posts = 0;
    let gets = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts += 1;
        return errorResponse(201, null);
      }
      gets += 1;
      // A cached POST would have made this send If-None-Match.
      expect(new Headers(init?.headers).get('if-none-match')).toBeNull();
      return jsonResponse({ ok: true });
    });
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await ghPost('/shared/path');
    await ghGet('/shared/path');
    expect([posts, gets]).toEqual([1, 1]);
  });

  it('flags a 429 as a retryable rate limit', async () => {
    setFetchImpl((async () =>
      new Response('{}', {
        status: 429,
        headers: new Headers({ 'retry-after': '30' }),
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      isRateLimit: true,
      refusal: 'rate-limit',
    });
  });

  it('flags a 403 carrying retry-after as a retryable rate limit', async () => {
    setFetchImpl((async () =>
      new Response('{}', {
        status: 403,
        headers: new Headers({ 'retry-after': '60' }),
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      isRateLimit: true,
      refusal: 'rate-limit',
    });
  });

  it('classifies a secondary rate limit from the message alone', async () => {
    setFetchImpl((async () =>
      errorResponse(403, {
        message: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      isRateLimit: true,
      refusal: 'rate-limit',
    });
  });

  /** Latches the feature off. Matched by prefix — this message has been seen with a trailing "[]". */
  it('classifies "Resource not accessible by …" as a permission problem', async () => {
    setFetchImpl((async () =>
      errorResponse(403, {
        message: 'Resource not accessible by personal access token []',
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      refusal: 'permission',
      isRateLimit: false,
    });
  });

  /** Permanent for this run only — must NOT downgrade the token's capability. */
  it('classifies the 30-day window refusal as too-old and keeps the message', async () => {
    setFetchImpl((async () =>
      errorResponse(403, {
        message: 'Unable to retry this workflow run because it was created over a month ago',
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      refusal: 'too-old',
      message: 'Unable to retry this workflow run because it was created over a month ago',
    });
  });

  /**
   * A private repo answers 404 rather than 403 when the token can't reach it. For
   * a run we listed moments ago that is a permission problem — reading it as "run
   * gone" would retry forever.
   */
  it('treats a 404 as a refusal, not a missing run', async () => {
    setFetchImpl((async () =>
      errorResponse(404, { message: 'Not Found' })) as unknown as typeof fetch);

    const err = await ghPost('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).refusal).toBe('forbidden');
    expect((err as GitHubApiError).message).toMatch(/write access/i);
  });

  /**
   * The 422 that cost a real user an unexplained failure.
   *
   * `message` for a validation failure is the constant "Validation Failed"; everything that
   * says *what* failed is in `errors` beside it. Reading only `message` produced "Could not
   * open the pull request: Validation Failed", which names nothing to act on — and it broke
   * the callers that recognise an ordinary outcome by its text, so "nothing to merge" and
   * "one already exists" were both reported as hard failures.
   */
  it('lifts the reason out of a 422 errors array', async () => {
    setFetchImpl((async () =>
      errorResponse(422, {
        message: 'Validation Failed',
        errors: [
          {
            resource: 'PullRequest',
            code: 'custom',
            message: 'No commits between master and feature/java/test_sync',
          },
        ],
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      status: 422,
      message: 'No commits between master and feature/java/test_sync',
    });
  });

  it('reads a field-and-code entry as a phrase', async () => {
    setFetchImpl((async () =>
      errorResponse(422, {
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      message: 'PullRequest.head is invalid',
    });
  });

  it('joins several entries', async () => {
    setFetchImpl((async () =>
      errorResponse(422, {
        message: 'Validation Failed',
        errors: [
          { resource: 'PullRequest', field: 'base', code: 'invalid' },
          { resource: 'PullRequest', field: 'head', code: 'missing_field' },
        ],
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      message: 'PullRequest.base is invalid; PullRequest.head is required',
    });
  });

  /** A heading that says something is kept; the useless one is not. */
  it('keeps a meaningful message ahead of the detail', async () => {
    setFetchImpl((async () =>
      errorResponse(422, {
        message: 'Reference update failed',
        errors: [{ resource: 'Ref', code: 'custom', message: 'the branch is protected' }],
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      message: 'Reference update failed: the branch is protected',
    });
  });

  it('falls back to the message when there is no errors array', async () => {
    setFetchImpl((async () =>
      errorResponse(422, { message: 'Validation Failed' })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({ message: 'Validation Failed' });
  });

  it('ignores entries it cannot describe', async () => {
    setFetchImpl((async () =>
      errorResponse(422, {
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest' }, null, { code: 'invalid' }],
      })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({ message: 'is invalid' });
  });

  it("classifies a 409 as a conflict and keeps GitHub's wording", async () => {
    setFetchImpl((async () =>
      errorResponse(409, { message: 'This run is already in progress.' })) as unknown as typeof fetch);

    await expect(ghPost('/x')).rejects.toMatchObject({
      refusal: 'conflict',
      message: 'This run is already in progress.',
    });
  });

  it('reports an unauthenticated client without hitting the network', async () => {
    const fetchMock = vi.fn(async () => errorResponse(201, null));
    setFetchImpl(fetchMock as unknown as typeof fetch);
    setTokenProvider(() => null);

    await expect(ghPost('/x')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('body reads are bounded', () => {
  beforeEach(() => {
    clearEtagCache();
    __resetRateLimit();
    setTokenProvider(() => 'test-token');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A response whose headers arrive and whose body then never does — wired to the abort
   * signal the way a real `fetch` body is, so aborting errors the stream.
   */
  function stalledFetch() {
    return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  }

  /**
   * The failure this exists for. A job log 302-redirects to blob storage, so headers come
   * back promptly and the *body* is the slow part. The request timer has to be released
   * once headers arrive — otherwise a big healthy download would be killed — which left
   * the body read with no deadline at all. A stalled body hung forever: no HTTP error, no
   * timeout, nothing in the app able to give up. It surfaced only because a caller
   * upstream happened to have its own timeout.
   */
  it('gives up on a response whose headers arrive but whose body never does', async () => {
    setFetchImpl(stalledFetch());
    vi.useFakeTimers();
    const result = ghGetText('/repos/o/r/actions/jobs/1/logs').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(BODY_TIMEOUT_MS + 10_000);
    const err = await result;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).message).toMatch(/never finished/i);
  });

  /** Artifact downloads redirect to blob storage too, so they need the same deadline. */
  it('gives up on a stalled binary download', async () => {
    setFetchImpl(stalledFetch());
    vi.useFakeTimers();
    const result = ghGetBlob('/repos/o/r/actions/artifacts/1/zip').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(BODY_TIMEOUT_MS + 10_000);
    expect(await result).toBeInstanceOf(GitHubApiError);
  });

  /** The happy path must stay unaffected — the deadline exists only for the stall. */
  it('still reads a body that arrives normally', async () => {
    setFetchImpl(
      vi.fn(async () => new Response('line one\nFAILED\n', { status: 200 })) as unknown as typeof fetch,
    );
    expect(await ghGetText('/repos/o/r/actions/jobs/1/logs')).toContain('FAILED');
  });
});

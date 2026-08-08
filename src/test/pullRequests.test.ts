/**
 * Opening a pull request whose head is in a **fork**.
 *
 * The one place this app crosses repositories, and GitHub wants the head spelled two
 * different ways on the two calls involved: the *list* filter always takes `owner:branch`,
 * while *create* takes a bare branch name for a head in the same repository. Getting either
 * wrong is quiet — the filter silently matches nothing, or create opens a pull request from
 * a branch that isn't the one intended.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPull, findOpenPull } from '../api/pullRequests';
import { clearEtagCache, setFetchImpl, setTokenProvider } from '../api/githubClient';
import { recordPushAccess, recordTokenScopes, resetTokenCapability } from '../api/tokenCapability';
import type { PullRequest } from '../api/types';

function pull(overrides: Record<string, unknown> = {}): PullRequest {
  return {
    id: 1,
    node_id: 'PR_1',
    number: 7,
    title: 'T',
    html_url: 'https://github.com/up/proj/pull/7',
    state: 'open',
    draft: false,
    user: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    auto_merge: null,
    merged_at: null,
    head: {
      sha: 'abc',
      ref: 'feature/x',
      label: 'me:feature/x',
      user: { login: 'me', avatar_url: '', html_url: '' },
    },
    base: { ref: 'feature/x', repo: null },
    ...overrides,
  } as PullRequest;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' }),
  });
}

beforeEach(() => {
  clearEtagCache();
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

describe('findOpenPull', () => {
  it('qualifies the head with the fork owner in the list filter', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse([]));
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await findOpenPull('up', 'proj', { headOwner: 'me', head: 'feature/x', base: 'feature/x' });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('head')).toBe('me:feature/x');
    expect(url.searchParams.get('base')).toBe('feature/x');
  });

  it('falls back to the repository owner when the head is not in a fork', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse([]));
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await findOpenPull('up', 'proj', { head: 'main', base: 'feature/x' });

    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('head')).toBe('up:main');
  });

  /**
   * Head and base carry the same branch name here, so the head *owner* is the only thing
   * telling one fork's offer from another's. Adopting the wrong one would attach this
   * action — and its auto-merge — to somebody else's work.
   */
  it('ignores a same-named branch belonging to a different fork', async () => {
    setFetchImpl((async () =>
      jsonResponse([
        pull({
          number: 99,
          head: {
            sha: 'zzz',
            ref: 'feature/x',
            label: 'someone-else:feature/x',
            user: { login: 'someone-else', avatar_url: '', html_url: '' },
          },
        }),
      ])) as unknown as typeof fetch);

    const found = await findOpenPull('up', 'proj', {
      headOwner: 'me',
      head: 'feature/x',
      base: 'feature/x',
    });

    expect(found).toBeNull();
  });

  it('finds the fork’s own offer', async () => {
    setFetchImpl((async () => jsonResponse([pull()])) as unknown as typeof fetch);

    const found = await findOpenPull('up', 'proj', {
      headOwner: 'me',
      head: 'feature/x',
      base: 'feature/x',
    });

    expect(found?.number).toBe(7);
  });
});

describe('createPull', () => {
  /** Create wants `owner:branch` only when the head really is in another repository. */
  it('sends a qualified head for a cross-fork pull request', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'POST' ? jsonResponse(pull()) : jsonResponse([]),
    );
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await createPull('up', 'proj', {
      headOwner: 'me',
      head: 'feature/x',
      base: 'feature/x',
      title: 'T',
      body: 'B',
    });

    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit | undefined)?.body))).toEqual({
      head: 'me:feature/x',
      base: 'feature/x',
      title: 'T',
      body: 'B',
    });
  });

  it('sends a bare head when it is in the same repository', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'POST' ? jsonResponse(pull()) : jsonResponse([]),
    );
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await createPull('up', 'proj', { head: 'main', base: 'feature/x', title: 'T', body: '' });

    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit | undefined)?.body)).head).toBe('main');
  });

  /** Same owner spelled explicitly is still a same-repo head, not a cross-fork one. */
  it('does not qualify a head owner equal to the repository owner', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'POST' ? jsonResponse(pull()) : jsonResponse([]),
    );
    setFetchImpl(fetchMock as unknown as typeof fetch);

    await createPull('up', 'proj', {
      headOwner: 'UP',
      head: 'main',
      base: 'feature/x',
      title: 'T',
      body: '',
    });

    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit | undefined)?.body)).head).toBe('main');
  });

  /** A second click while the first pull request is still open must adopt it, not 422. */
  it('adopts an already-open pull request instead of creating a second', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse([pull()]));
    setFetchImpl(fetchMock as unknown as typeof fetch);

    const result = await createPull('up', 'proj', {
      headOwner: 'me',
      head: 'feature/x',
      base: 'feature/x',
      title: 'T',
      body: 'B',
    });

    expect(result.existing).toBe(true);
    expect(result.pr.number).toBe(7);
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });
});

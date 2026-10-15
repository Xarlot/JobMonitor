import { beforeEach, describe, expect, it, vi } from 'vitest';

const ghWriteJson = vi.fn<(method: string, path: string, body?: unknown) => Promise<unknown>>();
const ghGraphQlQuery = vi.fn<(query: string, variables: Record<string, unknown>) => Promise<unknown>>();
const ghGet = vi.fn<(path: string) => Promise<unknown>>();
const recordWriteRefused = vi.fn();

vi.mock('../api/githubClient', async () => {
  // The real error class, so `instanceof` and `refusal` behave as callers rely on.
  const actual = await vi.importActual<typeof import('../api/githubClient')>('../api/githubClient');
  return {
    GitHubApiError: actual.GitHubApiError,
    ghGet: (p: string) => ghGet(p),
    ghWriteJson: (m: string, p: string, b?: unknown) => ghWriteJson(m, p, b),
    ghGraphQlQuery: (q: string, v: Record<string, unknown>) => ghGraphQlQuery(q, v),
  };
});
vi.mock('../api/tokenCapability', () => ({ recordWriteRefused: () => recordWriteRefused() }));

import {
  botUnresolved,
  commentSnippet,
  countUnresolved,
  fetchFileAtRef,
  fetchReviewThreads,
  outdatedUnresolved,
  replyToReviewThread,
  resolveAllReviewThreads,
  resolveReviewThread,
  toReviewThread,
} from '../api/reviewThreads';
import { GitHubApiError } from '../api/githubClient';

function rawThread(id: string, isResolved: boolean) {
  return {
    id,
    isResolved,
    path: 'a.ts',
    line: null,
    originalLine: 7,
    viewerCanResolve: true,
    viewerCanReply: true,
    comments: {
      totalCount: 3,
      nodes: [
        { id: `${id}-1`, body: 'hm', createdAt: '2026-10-01T00:00:00Z', url: 'u', diffHunk: '@@ x', author: null },
        null,
      ],
    },
  };
}

function page(nodes: unknown[], endCursor: string | null) {
  return {
    data: {
      repository: {
        pullRequest: { reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
      },
    },
  };
}

beforeEach(() => {
  ghWriteJson.mockReset();
  ghGraphQlQuery.mockReset();
  recordWriteRefused.mockReset();
});

describe('toReviewThread', () => {
  it('drops null comments, falls back to the original line and notices a truncated thread', () => {
    const t = toReviewThread(rawThread('T', false));
    expect(t.comments).toHaveLength(1);
    expect(t.line).toBe(7);
    expect(t.diffHunk).toBe('@@ x');
    expect(t.commentsTruncated).toBe(true);
    expect(t.isOutdated).toBe(false);
  });
});

describe('fetchReviewThreads', () => {
  it('follows the cursor across pages', async () => {
    ghGraphQlQuery
      .mockResolvedValueOnce(page([rawThread('A', false)], 'c1'))
      .mockResolvedValueOnce(page([rawThread('B', true)], null));
    const threads = await fetchReviewThreads('o', 'r', 5);
    expect(threads.map((t) => t.id)).toEqual(['A', 'B']);
    expect(ghGraphQlQuery.mock.calls[1][1]).toMatchObject({ owner: 'o', repo: 'r', number: 5, after: 'c1' });
    // Sent as a query, never a mutation — the read path refuses anything else.
    expect(ghGraphQlQuery.mock.calls[0][0].trim().startsWith('query')).toBe(true);
  });

  it('reports a 200 with errors as a failure', async () => {
    ghGraphQlQuery.mockResolvedValue({ data: null, errors: [{ message: 'SAML enforcement' }] });
    await expect(fetchReviewThreads('o', 'r', 5)).rejects.toThrow('SAML enforcement');
  });
});

describe('countUnresolved', () => {
  it('counts the open ones, and treats unknown as none', () => {
    const threads = [rawThread('A', false), rawThread('B', true), rawThread('C', false)].map(toReviewThread);
    expect(countUnresolved(threads)).toBe(2);
    expect(countUnresolved(undefined)).toBe(0);
  });
});

describe('resolveReviewThread', () => {
  it('posts the mutation with the thread id', async () => {
    ghWriteJson.mockResolvedValue({ data: { resolveReviewThread: { thread: { id: 'T', isResolved: true } } } });
    await resolveReviewThread('T');
    const [method, path, body] = ghWriteJson.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/graphql');
    expect((body as { variables: unknown }).variables).toEqual({ threadId: 'T' });
  });

  it('does not claim success GitHub did not confirm', async () => {
    ghWriteJson.mockResolvedValue({ data: { resolveReviewThread: { thread: { id: 'T', isResolved: false } } } });
    await expect(resolveReviewThread('T')).rejects.toThrow(/did not confirm/);
  });

  it('retires the write controls on a permission refusal', async () => {
    ghWriteJson.mockRejectedValue(new GitHubApiError('no', 403, false, 'permission'));
    await expect(resolveReviewThread('T')).rejects.toThrow();
    expect(recordWriteRefused).toHaveBeenCalledOnce();
  });
});

describe('replyToReviewThread', () => {
  it('trims the body and refuses an empty one without calling GitHub', async () => {
    await expect(replyToReviewThread('T', '   ')).rejects.toThrow(/empty/);
    expect(ghWriteJson).not.toHaveBeenCalled();

    ghWriteJson.mockResolvedValue({ data: { addPullRequestReviewThreadReply: { comment: { id: 'C' } } } });
    await replyToReviewThread('T', '  ok  ');
    expect((ghWriteJson.mock.calls[0][2] as { variables: unknown }).variables).toEqual({ threadId: 'T', body: 'ok' });
  });
});

describe('resolveAllReviewThreads', () => {
  const OK = { data: { resolveReviewThread: { thread: { isResolved: true } } } };

  it('carries on past an ordinary failure', async () => {
    ghWriteJson
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce({ data: null, errors: [{ message: 'nope' }] })
      .mockResolvedValueOnce(OK);
    const progress: number[] = [];
    const result = await resolveAllReviewThreads([{ id: 'A' }, { id: 'B' }, { id: 'C' }], (n) => progress.push(n));
    expect(result.resolved).toBe(2);
    expect(result.failed).toEqual([{ threadId: 'B', error: 'nope' }]);
    expect(progress).toEqual([1, 2, 3]);
  });

  /** Every remaining call would be refused the same way, so they are not made. */
  it('stops at a permission refusal', async () => {
    ghWriteJson.mockRejectedValue(new GitHubApiError('no', 403, false, 'permission'));
    const result = await resolveAllReviewThreads([{ id: 'A' }, { id: 'B' }]);
    expect(ghWriteJson).toHaveBeenCalledOnce();
    expect(result.resolved).toBe(0);
    expect(result.failed.map((f) => f.threadId)).toEqual(['A', 'B']);
  });
});

describe('outdatedUnresolved', () => {
  it('keeps the open threads whose code has changed, and only those', () => {
    const t = (id: string, isResolved: boolean, isOutdated: boolean) =>
      toReviewThread({ ...rawThread(id, isResolved), isOutdated });
    const got = outdatedUnresolved([t('a', false, true), t('b', true, true), t('c', false, false)]);
    expect(got.map((x) => x.id)).toEqual(['a']);
    expect(outdatedUnresolved(undefined)).toEqual([]);
  });
});

describe('commentSnippet', () => {
  it('reduces markdown to one line of text, keeping identifiers intact', () => {
    expect(
      commentSnippet('**Why** is `max_retries` mutable?\n\nSee [the docs](https://x.y).\n```java\nint a;\n```'),
    ).toBe('Why is max_retries mutable? See the docs. [code]');
    expect(commentSnippet('```suggestion\nfinal int x;\n```')).toBe('[suggestion]');
  });
});

describe('fetchFileAtRef', () => {
  // A block, not `() => ghGet.mockReset()`: vitest runs a function returned from beforeEach as teardown.
  beforeEach(() => {
    ghGet.mockReset();
  });

  it('decodes the file as UTF-8, from an escaped path at the ref', async () => {
    const text = 'naïve = 1\n';
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    ghGet.mockResolvedValue({ data: { type: 'file', encoding: 'base64', content: b64.replace(/(.{4})/g, '$1\n') } });
    await expect(fetchFileAtRef('acme', 'rocket', 'src/a b.ts', 'abc123')).resolves.toBe(text);
    expect(ghGet).toHaveBeenCalledWith('/repos/acme/rocket/contents/src/a%20b.ts?ref=abc123');
  });

  /** A file gone at the head is an answer, not a failure: the comment's code was deleted. */
  it('answers null for a file that does not exist at the ref', async () => {
    ghGet.mockRejectedValue(new GitHubApiError('nope', 404));
    await expect(fetchFileAtRef('a', 'b', 'gone.ts', 'sha')).resolves.toBeNull();
  });

  it('throws for a file too large to come back inline', async () => {
    ghGet.mockResolvedValue({ data: { type: 'file', encoding: 'none', content: '' } });
    await expect(fetchFileAtRef('a', 'b', 'big.bin', 'sha')).rejects.toThrow(/too large/);
  });
});

describe('botUnresolved', () => {
  /** GraphQL gives a bot's login without `[bot]`; `__typename` is what says it is one. */
  it('keeps open threads a bot started, recognised by type or by the REST-style suffix', () => {
    const t = (id: string, author: { __typename?: string; login: string }, isResolved = false) =>
      toReviewThread({
        ...rawThread(id, isResolved),
        comments: { totalCount: 1, nodes: [{ id: `${id}-1`, createdAt: '', url: '', author: { ...author, avatarUrl: '' } }] },
      });
    const got = botUnresolved([
      t('a', { __typename: 'Bot', login: 'copilot-pull-request-reviewer' }),
      t('b', { __typename: 'User', login: 'alice' }),
      t('c', { login: 'renovate[bot]' }),
      t('d', { __typename: 'Bot', login: 'coderabbitai' }, true),
    ]);
    expect(got.map((x) => x.id)).toEqual(['a', 'c']);
    expect(got[0].comments[0].author?.isBot).toBe(true);
  });
});

/**
 * A pull request's review threads — the inline code comments — and the two writes on them:
 * resolving a thread and replying to it.
 *
 * GraphQL throughout, because GitHub keeps resolution there only: the REST review-comment
 * endpoints list the comments but say nothing about whether their conversation is resolved,
 * and "how many are still open" is the whole point of reading them. The read goes through
 * {@link ghGraphQlQuery} (ungated, so a read-only token still sees the count); the writes go
 * through `ghWriteJson`, gated on write capability like every other write in the app.
 *
 * As with auto-merge, a refused mutation arrives as HTTP 200 with an `errors` array, so the
 * body is inspected rather than the status trusted.
 */

import { contentsPath, GRAPHQL_PATH } from './endpoints';
import { ghGet, ghGraphQlQuery, ghWriteJson, GitHubApiError, type WriteSubject } from './githubClient';
import { graphQlErrorMessage } from './autoMerge';
import { recordWriteRefused } from './tokenCapability';

export interface ReviewComment {
  id: string;
  author: { login: string; avatarUrl: string; isBot: boolean } | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  /** The code it was left on has since changed. Still open until someone resolves it. */
  isOutdated: boolean;
  path: string;
  /** The line in the current diff, or the original one when the thread is outdated. */
  line: number | null;
  /** The diff hunk the first comment was left on — the code being discussed. */
  diffHunk: string;
  comments: ReviewComment[];
  /** More comments than were read; the thread is long and only its start is shown. */
  commentsTruncated: boolean;
  viewerCanResolve: boolean;
  viewerCanReply: boolean;
}

/** Threads per page, and how many pages to read before giving up on a pathological PR. */
const THREADS_PER_PAGE = 100;
const MAX_PAGES = 5;
/** Comments per thread. A conversation longer than this is read on GitHub. */
const COMMENTS_PER_THREAD = 50;

const REVIEW_THREADS = `
query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREADS_PER_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          viewerCanResolve
          viewerCanReply
          comments(first: ${COMMENTS_PER_THREAD}) {
            totalCount
            nodes { id body createdAt url diffHunk author { __typename login avatarUrl } }
          }
        }
      }
    }
  }
}`;

interface GraphQlResponse<T> {
  data?: T | null;
  errors?: { message?: string; type?: string }[];
}

interface RawComment {
  id: string;
  body?: string | null;
  createdAt: string;
  url: string;
  diffHunk?: string | null;
  author?: { __typename?: string; login: string; avatarUrl: string } | null;
}

interface RawThread {
  id: string;
  isResolved: boolean;
  isOutdated?: boolean;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  viewerCanResolve?: boolean;
  viewerCanReply?: boolean;
  comments?: { totalCount?: number; nodes?: (RawComment | null)[] | null } | null;
}

interface ReviewThreadsData {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes?: (RawThread | null)[] | null;
      } | null;
    } | null;
  } | null;
}

/** Exported for its tests: GraphQL nodes are nullable everywhere, and this is where that ends. */
export function toReviewThread(raw: RawThread): ReviewThread {
  const comments = (raw.comments?.nodes ?? []).filter((c): c is RawComment => c != null);
  return {
    id: raw.id,
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated ?? false,
    path: raw.path,
    line: raw.line ?? raw.originalLine ?? null,
    diffHunk: comments[0]?.diffHunk ?? '',
    comments: comments.map((c) => ({
      id: c.id,
      author: c.author
        ? { login: c.author.login, avatarUrl: c.author.avatarUrl, isBot: isBotAuthor(c.author) }
        : null,
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url,
    })),
    commentsTruncated: (raw.comments?.totalCount ?? comments.length) > comments.length,
    viewerCanResolve: raw.viewerCanResolve ?? false,
    viewerCanReply: raw.viewerCanReply ?? false,
  };
}

/**
 * A GitHub App or bot account. GraphQL says so in `__typename`, and gives a bot's login without
 * the `[bot]` suffix REST shows — so the suffix is only the fallback, for a response without it.
 */
function isBotAuthor(author: { __typename?: string; login: string }): boolean {
  return author.__typename === 'Bot' || /\[bot\]$/.test(author.login);
}

/** Every review thread on a pull request, resolved ones included. */
export async function fetchReviewThreads(
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: GraphQlResponse<ReviewThreadsData> = await ghGraphQlQuery<
      GraphQlResponse<ReviewThreadsData>
    >(REVIEW_THREADS, { owner, repo, number, after });
    if (body.errors?.length) {
      throw new GitHubApiError(graphQlErrorMessage(body.errors), 200);
    }
    const connection = body.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) break;
    for (const node of connection.nodes ?? []) if (node) threads.push(toReviewThread(node));
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
    after = connection.pageInfo.endCursor;
  }
  return threads;
}

/** The number the PR row shows. */
export function countUnresolved(threads: readonly ReviewThread[] | undefined): number {
  if (!threads) return 0;
  let n = 0;
  for (const t of threads) if (!t.isResolved) n++;
  return n;
}

/** Unresolved threads whose code has since changed — what "Resolve outdated" acts on. */
export function outdatedUnresolved(threads: readonly ReviewThread[] | undefined): ReviewThread[] {
  return (threads ?? []).filter((t) => !t.isResolved && t.isOutdated);
}

/** Unresolved threads started by a bot — a review bot's findings, closed in one go. */
export function botUnresolved(threads: readonly ReviewThread[] | undefined): ReviewThread[] {
  return (threads ?? []).filter((t) => !t.isResolved && t.comments[0]?.author?.isBot === true);
}

/**
 * A comment as one line of plain text, for the chip in the PR row: code blocks become a word,
 * link and emphasis markup goes, whitespace collapses. The chip truncates; this only cleans.
 */
export function commentSnippet(body: string): string {
  return body
    .replace(/```suggestion[\s\S]*?(```|$)/g, ' [suggestion] ')
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*|^>\s*/gm, '')
    .replace(/[`*~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One file as it is at `ref`, or `null` when it does not exist there (deleted or moved — itself
 * the answer to "is this comment still relevant"). Any other failure throws; the caller drafts
 * without the current code rather than not at all.
 */
export async function fetchFileAtRef(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  let data: { type?: string; encoding?: string; content?: string };
  try {
    ({ data } = await ghGet<typeof data>(contentsPath(owner, repo, path, ref)));
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 404) return null;
    throw e;
  }
  // A directory answers with an array; a file over 1 MB with `encoding: "none"` and no content.
  if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new GitHubApiError('The file is too large or not a file.', 200);
  }
  const binary = atob(data.content.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

const RESOLVE_SUBJECT: WriteSubject = { action: 'resolve review comments', noun: 'Pull request' };
const REPLY_SUBJECT: WriteSubject = { action: 'reply to review comments', noun: 'Pull request' };

const RESOLVE_THREAD = `
mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

const REPLY_TO_THREAD = `
mutation ReplyToThread($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

async function mutate<T>(query: string, variables: Record<string, unknown>, subject: WriteSubject): Promise<T> {
  let body: GraphQlResponse<T>;
  try {
    body = await ghWriteJson<GraphQlResponse<T>>('POST', GRAPHQL_PATH, { query, variables }, subject);
  } catch (e) {
    if (e instanceof GitHubApiError && e.refusal === 'permission') recordWriteRefused();
    throw e;
  }
  if (body.errors?.length) {
    throw new GitHubApiError(graphQlErrorMessage(body.errors), 200, false, 'forbidden');
  }
  if (!body.data) throw new GitHubApiError('GitHub did not confirm the change.', 200);
  return body.data;
}

/** Mark one conversation resolved. Resolving an already-resolved thread is harmless. */
export async function resolveReviewThread(threadId: string): Promise<void> {
  const data = await mutate<{ resolveReviewThread?: { thread?: { isResolved?: boolean } | null } | null }>(
    RESOLVE_THREAD,
    { threadId },
    RESOLVE_SUBJECT,
  );
  if (!data.resolveReviewThread?.thread?.isResolved) {
    throw new GitHubApiError('GitHub did not confirm the conversation was resolved.', 200);
  }
}

/**
 * Add a comment to a thread.
 *
 * Published immediately, not left in a pending review: a reply that only appears once the
 * author also submits a review is a reply nobody sees, and this app has no review to submit.
 */
export async function replyToReviewThread(threadId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new GitHubApiError('A reply cannot be empty.', 0);
  const data = await mutate<{ addPullRequestReviewThreadReply?: { comment?: { id?: string } | null } | null }>(
    REPLY_TO_THREAD,
    { threadId, body: text },
    REPLY_SUBJECT,
  );
  if (!data.addPullRequestReviewThreadReply?.comment?.id) {
    throw new GitHubApiError('GitHub did not confirm the reply was posted.', 200);
  }
}

export interface ResolveAllResult {
  resolved: number;
  failed: { threadId: string; error: string }[];
}

/**
 * Resolve every thread given, one at a time.
 *
 * Sequential rather than parallel: GitHub's secondary rate limit is aimed squarely at bursts
 * of content-creating mutations, and a PR with forty open threads fired at once is exactly
 * that. A failure does not stop the rest — each thread is its own conversation, and one that
 * the token may not resolve says nothing about the others. A permission refusal does stop it,
 * since every remaining call would be refused the same way.
 */
export async function resolveAllReviewThreads(
  threads: readonly Pick<ReviewThread, 'id'>[],
  onProgress?: (done: number) => void,
): Promise<ResolveAllResult> {
  const result: ResolveAllResult = { resolved: 0, failed: [] };
  for (const [i, t] of threads.entries()) {
    try {
      await resolveReviewThread(t.id);
      result.resolved++;
    } catch (e) {
      result.failed.push({ threadId: t.id, error: e instanceof Error ? e.message : String(e) });
      if (e instanceof GitHubApiError && (e.refusal === 'permission' || e.isRateLimit)) {
        for (const rest of threads.slice(i + 1)) {
          result.failed.push({ threadId: rest.id, error: 'Not attempted.' });
        }
        break;
      }
    }
    onProgress?.(i + 1);
  }
  return result;
}

/**
 * Syncing a fork's branch from its parent.
 *
 * The reply's `base_branch` is **qualified** — `"DevExpress:feature/x"` — and the check that
 * GitHub acted on the branch we asked for compared it against the bare name. So every
 * successful sync was reported as a failure, and not a harmless one: the sync had already
 * happened, so the user was told it failed while their fork *had* been updated. Hence the
 * qualified shapes below are the ones that matter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncForkBranch, verifyForkParent } from '../api/forkSync';
import { clearEtagCache, setFetchImpl, setTokenProvider } from '../api/githubClient';
import { recordPushAccess, recordTokenScopes, resetTokenCapability } from '../api/tokenCapability';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' }),
  });
}

/** Answer the merge-upstream POST with `body`; anything else 404s. */
function stub(body: unknown, status = 200) {
  setFetchImpl((async (url: string) =>
    String(url).includes('/merge-upstream')
      ? jsonResponse(body, status)
      : jsonResponse({ message: 'Not Found' }, 404)) as unknown as typeof fetch);
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

describe('syncForkBranch', () => {
  /** The exact reply that used to be reported as a failure. */
  it('accepts the owner-qualified branch GitHub answers with', async () => {
    stub({
      message: 'Successfully fetched and fast-forwarded from upstream DevExpress:feature/java/test_sync',
      merge_type: 'fast-forward',
      base_branch: 'DevExpress:feature/java/test_sync',
    });

    const outcome = await syncForkBranch('me', 'dxvcs', 'feature/java/test_sync');

    expect(outcome.mergeType).toBe('fast-forward');
    expect(outcome.baseBranch).toBe('feature/java/test_sync');
  });

  it('keeps working if GitHub ever answers with a bare name', async () => {
    stub({ message: 'ok', merge_type: 'merge', base_branch: 'feature/x' });
    expect((await syncForkBranch('me', 'r', 'feature/x')).baseBranch).toBe('feature/x');
  });

  /** A branch name with slashes must survive the split; only the owner is stripped. */
  it('strips only the owner, however many slashes the branch has', async () => {
    stub({ message: 'ok', merge_type: 'merge', base_branch: 'Org:feature/team/a/b' });
    expect((await syncForkBranch('me', 'r', 'feature/team/a/b')).baseBranch).toBe(
      'feature/team/a/b',
    );
  });

  /** The check still has to catch the thing it exists for. */
  it('refuses when GitHub really did act on another branch', async () => {
    stub({ message: 'ok', merge_type: 'merge', base_branch: 'DevExpress:main' });

    await expect(syncForkBranch('me', 'r', 'feature/x')).rejects.toThrow(
      /synced "main" rather than "feature\/x"/,
    );
  });

  it('reads merge_type none as the success it is', async () => {
    stub({ message: 'This branch is not behind the upstream', merge_type: 'none', base_branch: 'up:feature/x' });
    expect((await syncForkBranch('me', 'r', 'feature/x')).mergeType).toBe('none');
  });

  it('propagates a conflict', async () => {
    stub({ message: 'merge conflict' }, 409);
    await expect(syncForkBranch('me', 'r', 'feature/x')).rejects.toMatchObject({ status: 409 });
  });
});

describe('verifyForkParent', () => {
  function stubRepo(body: Record<string, unknown>) {
    setFetchImpl((async () => jsonResponse(body)) as unknown as typeof fetch);
  }

  it('accepts a fork of the configured upstream', async () => {
    stubRepo({ name: 'r', full_name: 'me/r', private: false, fork: true, parent: { full_name: 'up/r' } });
    expect((await verifyForkParent({ owner: 'me', repo: 'r' }, { owner: 'up', repo: 'r' })).ok).toBe(
      true,
    );
  });

  /** Case is not significant in a repository slug; a mismatch here would be a false alarm. */
  it('compares the parent case-insensitively', async () => {
    stubRepo({ name: 'r', full_name: 'me/r', private: false, fork: true, parent: { full_name: 'UP/R' } });
    expect((await verifyForkParent({ owner: 'me', repo: 'r' }, { owner: 'up', repo: 'r' })).ok).toBe(
      true,
    );
  });

  /**
   * The hazard the check exists for: merge-upstream syncs from the fork's *actual* parent and
   * cannot be told otherwise, so this would succeed against the wrong repository.
   */
  it('rejects a fork of something else, naming both', async () => {
    stubRepo({
      name: 'r',
      full_name: 'me/r',
      private: false,
      fork: true,
      parent: { full_name: 'someone-else/r' },
    });

    const check = await verifyForkParent({ owner: 'me', repo: 'r' }, { owner: 'up', repo: 'r' });

    expect(check.ok).toBe(false);
    expect(check.problem).toMatchObject({
      kind: 'wrong-parent',
      actualParent: 'someone-else/r',
      expected: 'up/r',
    });
  });

  it('rejects a repository that is not a fork at all', async () => {
    stubRepo({ name: 'r', full_name: 'me/r', private: false, fork: false });
    expect((await verifyForkParent({ owner: 'me', repo: 'r' }, { owner: 'up', repo: 'r' })).problem)
      .toMatchObject({ kind: 'not-a-fork' });
  });
});

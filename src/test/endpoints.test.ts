import { describe, expect, it } from 'vitest';
import { pullsPath, repoPath, repoRunsPath, rerunFailedJobsPath } from '../api/endpoints';

describe('pullsPath', () => {
  it('defaults to the open list', () => {
    expect(pullsPath('acme', 'rocket')).toBe(
      '/repos/acme/rocket/pulls?state=open&per_page=100&sort=updated&direction=desc',
    );
  });

  it('can ask for closed PRs with a smaller page', () => {
    expect(pullsPath('acme', 'rocket', { state: 'closed', perPage: 30 })).toBe(
      '/repos/acme/rocket/pulls?state=closed&per_page=30&sort=updated&direction=desc',
    );
  });

  it('adds the fork head filter when given', () => {
    expect(pullsPath('acme', 'rocket', { head: 'octodev:main' })).toContain('head=octodev%3Amain');
  });

  it('encodes owner and repo', () => {
    expect(pullsPath('a b', 'r/x')).toContain('/repos/a%20b/r%2Fx/pulls');
  });
});

describe('repoRunsPath', () => {
  /**
   * The path doubles as the ETag cache key, so an unset option must not appear —
   * otherwise every existing caller's cache entry would be invalidated.
   */
  it('is unchanged when no options are passed', () => {
    expect(repoRunsPath('acme', 'rocket')).toBe('/repos/acme/rocket/actions/runs?per_page=100');
  });

  it('narrows to one commit with head_sha', () => {
    expect(repoRunsPath('acme', 'rocket', { headSha: 'abc123', perPage: 50 })).toBe(
      '/repos/acme/rocket/actions/runs?per_page=50&head_sha=abc123',
    );
  });

  it('still supports the created window and paging', () => {
    const path = repoRunsPath('acme', 'rocket', { created: '>=2026-07-30T00:00:00Z', page: 2 });
    expect(path).toContain('created=%3E%3D2026-07-30T00%3A00%3A00Z');
    expect(path).toContain('page=2');
    expect(path).not.toContain('head_sha');
  });

  it('omits page 1, which is the default', () => {
    // Note `per_page=` also ends in "page=", so match the separator too.
    expect(repoRunsPath('acme', 'rocket', { page: 1 })).not.toContain('&page=');
  });
});

describe('rerunFailedJobsPath', () => {
  it('builds the POST target', () => {
    expect(rerunFailedJobsPath('acme', 'rocket', 1002)).toBe(
      '/repos/acme/rocket/actions/runs/1002/rerun-failed-jobs',
    );
  });

  it('encodes owner and repo', () => {
    expect(rerunFailedJobsPath('a b', 'r', 1)).toBe(
      '/repos/a%20b/r/actions/runs/1/rerun-failed-jobs',
    );
  });
});

describe('repoPath', () => {
  it('addresses the repository itself', () => {
    expect(repoPath('acme', 'rocket')).toBe('/repos/acme/rocket');
  });

  /** Exactly two segments, so the mock router can't confuse it with a sub-resource. */
  it('has no trailing path or query', () => {
    expect(repoPath('acme', 'rocket').split('/')).toHaveLength(4);
  });
});

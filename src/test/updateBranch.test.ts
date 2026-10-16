import { beforeEach, describe, expect, it, vi } from 'vitest';

const ghWriteJson = vi.fn<(method: string, path: string, body?: unknown) => Promise<unknown>>();
const recordWriteRefused = vi.fn();

vi.mock('../api/githubClient', async () => {
  // The real error class, so `instanceof` and `refusal` behave as callers rely on.
  const actual = await vi.importActual<typeof import('../api/githubClient')>('../api/githubClient');
  return {
    GitHubApiError: actual.GitHubApiError,
    ghWriteJson: (m: string, p: string, b?: unknown) => ghWriteJson(m, p, b),
  };
});
vi.mock('../api/tokenCapability', () => ({ recordWriteRefused: () => recordWriteRefused() }));

import { updatePullRequestBranch } from '../api/updateBranch';
import { GitHubApiError } from '../api/githubClient';
import type { PullRequest } from '../api/types';

const PR = {
  number: 41763,
  node_id: 'PR_kwDOtest',
  head: { sha: 'abc123', ref: 'fix', label: 'me:fix', user: null },
  base: { ref: 'master', repo: null },
} as unknown as PullRequest;

describe('updatePullRequestBranch', () => {
  beforeEach(() => {
    ghWriteJson.mockReset();
    recordWriteRefused.mockReset();
  });

  it('sends the mutation pinned to the head the dialog showed, and returns the new head', async () => {
    ghWriteJson.mockResolvedValue({
      data: { updatePullRequestBranch: { pullRequest: { number: 41763, headRefOid: 'def456' } } },
    });
    await expect(updatePullRequestBranch(PR, 'REBASE')).resolves.toBe('def456');

    const [method, path, body] = ghWriteJson.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/graphql');
    const sent = body as { query: string; variables: Record<string, unknown> };
    expect(sent.query).toContain('updatePullRequestBranch');
    expect(sent.variables).toEqual({
      pullRequestId: 'PR_kwDOtest',
      expectedHeadOid: 'abc123',
      updateMethod: 'REBASE',
    });
  });

  it('treats a 200 carrying errors as a failure, with GitHub’s reason', async () => {
    ghWriteJson.mockResolvedValue({ data: null, errors: [{ message: 'head ref has changed' }] });
    await expect(updatePullRequestBranch(PR, 'MERGE')).rejects.toThrow('head ref has changed');
  });

  it('does not report success GitHub never confirmed', async () => {
    ghWriteJson.mockResolvedValue({ data: { updatePullRequestBranch: null } });
    await expect(updatePullRequestBranch(PR, 'MERGE')).rejects.toThrow(/did not confirm/);
  });

  it('retires write features when GitHub says the token cannot write', async () => {
    ghWriteJson.mockRejectedValue(new GitHubApiError('nope', 403, false, 'permission'));
    await expect(updatePullRequestBranch(PR, 'MERGE')).rejects.toThrow('nope');
    expect(recordWriteRefused).toHaveBeenCalledOnce();
  });
});

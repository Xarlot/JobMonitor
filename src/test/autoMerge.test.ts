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

import {
  armAutoMerge,
  clearPrDescription,
  enableAutoMerge,
  graphQlErrorMessage,
} from '../api/autoMerge';
import { GitHubApiError } from '../api/githubClient';
import type { PullRequest } from '../api/types';

const PR = {
  number: 41763,
  node_id: 'PR_kwDOtest',
  title: 'Fix compilation',
  body: 'a description',
} as PullRequest;

/** What GitHub answers when the mutation worked. */
const ENABLED = {
  data: {
    enablePullRequestAutoMerge: {
      pullRequest: { number: 41763, autoMergeRequest: { mergeMethod: 'SQUASH' } },
    },
  },
};

describe('graphQlErrorMessage', () => {
  it('joins the messages GitHub gave', () => {
    expect(
      graphQlErrorMessage([{ message: 'Pull request is in clean status' }, { message: 'and more' }]),
    ).toBe('Pull request is in clean status; and more');
  });

  /** Never leave the UI showing an empty reason. */
  it('falls back when GitHub gave no message at all', () => {
    expect(graphQlErrorMessage([])).toMatch(/no reason/i);
    expect(graphQlErrorMessage([{ type: 'FORBIDDEN' }])).toMatch(/no reason/i);
  });
});

describe('enableAutoMerge', () => {
  beforeEach(() => {
    ghWriteJson.mockReset();
    recordWriteRefused.mockReset();
  });

  it('posts the mutation with the PR node id and the chosen method', async () => {
    ghWriteJson.mockResolvedValue(ENABLED);
    await enableAutoMerge(PR, 'SQUASH');

    const [method, path, body] = ghWriteJson.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/graphql');
    const sent = body as { query: string; variables: Record<string, unknown> };
    expect(sent.query).toContain('enablePullRequestAutoMerge');
    expect(sent.variables).toEqual({ pullRequestId: 'PR_kwDOtest', mergeMethod: 'SQUASH' });
  });

  /**
   * The trap that makes GraphQL different from every other call in this app: a refusal
   * arrives as HTTP 200, so the status proves nothing and only the body says so.
   */
  it('treats a 200 carrying errors as a failure, with GitHub’s reason', async () => {
    ghWriteJson.mockResolvedValue({
      data: null,
      errors: [{ message: 'Auto merge is not allowed for this repository' }],
    });
    await expect(enableAutoMerge(PR, 'SQUASH')).rejects.toThrow(/not allowed for this repository/);
  });

  /** Silence is not success: claiming it would leave the UI asserting a fiction. */
  it('fails when the mutation confirms nothing', async () => {
    ghWriteJson.mockResolvedValue({ data: { enablePullRequestAutoMerge: { pullRequest: null } } });
    await expect(enableAutoMerge(PR, 'SQUASH')).rejects.toThrow(/did not confirm/i);
  });

  it('retires the feature when GitHub says the token may not write', async () => {
    ghWriteJson.mockRejectedValue(new GitHubApiError('nope', 403, false, 'permission'));
    await expect(enableAutoMerge(PR, 'SQUASH')).rejects.toThrow('nope');
    expect(recordWriteRefused).toHaveBeenCalledTimes(1);
  });

  it('leaves capability alone for a refusal that is not about permission', async () => {
    ghWriteJson.mockRejectedValue(new GitHubApiError('slow down', 403, true, 'rate-limit'));
    await expect(enableAutoMerge(PR, 'SQUASH')).rejects.toThrow('slow down');
    expect(recordWriteRefused).not.toHaveBeenCalled();
  });
});

describe('clearPrDescription', () => {
  beforeEach(() => ghWriteJson.mockReset());

  it('PATCHes the pull request with an empty body', async () => {
    ghWriteJson.mockResolvedValue({});
    await clearPrDescription('o', 'r', 41763);
    expect(ghWriteJson.mock.calls[0][0]).toBe('PATCH');
    expect(ghWriteJson.mock.calls[0][1]).toBe('/repos/o/r/pulls/41763');
    expect(ghWriteJson.mock.calls[0][2]).toEqual({ body: '' });
  });
});

describe('armAutoMerge', () => {
  beforeEach(() => {
    ghWriteJson.mockReset();
    recordWriteRefused.mockReset();
  });

  /**
   * Order matters and is not arbitrary: a PR whose checks are already green merges within
   * seconds of arming, so clearing afterwards would race the merge and lose — defeating the
   * point of clearing at all.
   */
  it('clears the description before arming', async () => {
    ghWriteJson.mockImplementation((method) =>
      Promise.resolve(method === 'PATCH' ? {} : ENABLED),
    );
    const result = await armAutoMerge('o', 'r', PR, 'SQUASH');

    expect(result).toEqual({ descriptionCleared: true, autoMergeEnabled: true });
    expect(ghWriteJson.mock.calls.map((c) => c[0])).toEqual(['PATCH', 'POST']);
  });

  it('does not arm when the description could not be cleared', async () => {
    ghWriteJson.mockRejectedValue(new GitHubApiError('PR is locked', 403, false, 'forbidden'));
    const result = await armAutoMerge('o', 'r', PR, 'SQUASH');

    expect(result).toEqual({
      descriptionCleared: false,
      autoMergeEnabled: false,
      error: 'PR is locked',
    });
    // Nothing else was attempted, so nothing was changed on GitHub.
    expect(ghWriteJson).toHaveBeenCalledTimes(1);
  });

  /** The half-done case, reported as such rather than as a plain failure. */
  it('reports that the description is already gone when arming fails', async () => {
    ghWriteJson.mockImplementation((method) =>
      method === 'PATCH'
        ? Promise.resolve({})
        : Promise.resolve({ errors: [{ message: 'Auto merge is disabled' }] }),
    );
    const result = await armAutoMerge('o', 'r', PR, 'SQUASH');

    expect(result.descriptionCleared).toBe(true);
    expect(result.autoMergeEnabled).toBe(false);
    expect(result.error).toContain('Auto merge is disabled');
  });
});

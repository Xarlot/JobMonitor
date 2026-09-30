/**
 * What the Diagnostics log says about one read of the open-PR list — the record that has to
 * answer "why is my Pull requests tab empty" for someone whose setup we cannot see.
 */

import { describe, expect, it } from 'vitest';
import { describePrList, forkMismatch } from '../hooks/useGitHubDashboard';
import { DEFAULT_CONFIG, type MonitorConfig } from '../storage/configStore';
import type { PullRequest } from '../api/types';

const config: MonitorConfig = {
  ...DEFAULT_CONFIG,
  upstream: { ...DEFAULT_CONFIG.upstream, owner: 'up', repo: 'proj' },
  fork: { owner: 'me', repo: '', branch: null },
  prAuthor: '',
};

function pull(number: number, headOwner: string | null, author = headOwner, ref = 'topic'): PullRequest {
  return {
    number,
    user: author ? { login: author } : null,
    head: { ref, sha: 'abc', user: headOwner ? { login: headOwner } : null },
  } as unknown as PullRequest;
}

describe('forkMismatch', () => {
  it('names the rule that dropped the PR', () => {
    expect(forkMismatch(pull(1, 'me'), config)).toBeNull();
    expect(forkMismatch(pull(1, 'Me'), config)).toBeNull();
    expect(forkMismatch(pull(1, 'up'), config)).toBe('head_owner');
    expect(forkMismatch(pull(1, 'me', 'me', 'other'), { ...config, fork: { ...config.fork, branch: 'main' } })).toBe(
      'branch',
    );
    expect(forkMismatch(pull(1, 'me', 'bot'), { ...config, prAuthor: 'me' })).toBe('author');
  });
});

describe('describePrList', () => {
  it('counts what was kept and why the rest was dropped', () => {
    const info = describePrList(
      [pull(1, 'me'), pull(2, 'up', 'me'), pull(3, 'up', 'me'), pull(4, 'someone'), pull(5, null)],
      config,
      2,
      false,
    );
    expect(info.fetched).toBe(5);
    expect(info.pages).toBe(2);
    expect(info.kept).toEqual([1]);
    expect(info.dropped).toEqual({ head_owner: 4, branch: 0, author: 0 });
    // The upstream itself heading PRs is the tell for "branches pushed straight to upstream".
    expect(info.otherHeadOwners[0]).toEqual({ login: 'up', count: 2 });
    expect(info.otherHeadOwners.map((o) => o.login)).toContain('(deleted fork)');
  });

  it('keeps the owner list short', () => {
    const many = Array.from({ length: 30 }, (_, i) => pull(i, `u${i}`));
    expect(describePrList(many, config, 1, false).otherHeadOwners).toHaveLength(10);
  });
});

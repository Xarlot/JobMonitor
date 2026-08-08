import { describe, expect, it } from 'vitest';
import {
  autoMergeIsAvailable,
  nextStep,
  checkCounts,
  defangReferences,
  hasMaterialToDescribe,
  isFeatureBranch,
  mergeStages,
  mergeVerdict,
  normaliseTitle,
  parseComposedPr,
  staticPrBody,
  staticPrTitle,
} from '../lib/featureBranch';
import type { CheckRun, OverallStatus, PullRequest } from '../api/types';
import { featureBranchesSchema } from '../storage/configStore';

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    node_id: 'PR_1',
    number: 42,
    title: 'Something',
    html_url: 'https://github.com/o/r/pull/42',
    state: 'open',
    draft: false,
    user: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    auto_merge: null,
    merged_at: null,
    head: { sha: 'abc', ref: 'feature/x', label: 'o:feature/x', user: null },
    base: { ref: 'main', repo: null },
    ...overrides,
  };
}

function check(overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 1,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    started_at: null,
    completed_at: null,
    html_url: null,
    details_url: null,
    ...overrides,
  } as CheckRun;
}

describe('isFeatureBranch', () => {
  it('needs something after the prefix', () => {
    expect(isFeatureBranch('feature/x', 'feature/')).toBe(true);
    expect(isFeatureBranch('feature/', 'feature/')).toBe(false);
    expect(isFeatureBranch('features-old', 'feature/')).toBe(false);
  });

  /** Git refs are case-sensitive, and two branches differing only in case can both exist. */
  it('does not fold case', () => {
    expect(isFeatureBranch('Feature/x', 'feature/')).toBe(false);
  });

  it('accepts a nested path', () => {
    expect(isFeatureBranch('feature/team/x', 'feature/')).toBe(true);
  });
});

describe('the configured prefix', () => {
  /**
   * It reaches GitHub as a path segment with its slashes intact — encoding them would make
   * the prefix match nothing — so a `?` or `#` in it would stop being part of the path.
   */
  it('rejects characters that would change the URL it is spliced into', () => {
    const parse = (prefix: string) =>
      featureBranchesSchema.safeParse({ enabled: true, prefix }).success;
    expect(parse('feature/')).toBe(true);
    expect(parse('release-2.1/')).toBe(true);
    expect(parse('feature?x=1')).toBe(false);
    expect(parse('feature#frag')).toBe(false);
    expect(parse('feature branch/')).toBe(false);
  });
});

describe('static pull request text', () => {
  it('names both branches for a backmerge', () => {
    expect(staticPrTitle('sync', 'feature/x', 'main')).toBe('Merge main into feature/x');
  });

  /**
   * An offer's two ends are the *same* branch name in two repositories, so naming them both
   * would read "feature/x → feature/x" and say nothing. Only ever seen when composition
   * produced nothing usable.
   */
  it('names the branch once for an offer', () => {
    expect(staticPrTitle('offer', 'feature/x', 'feature/x')).toBe('Changes for feature/x');
  });

  /** A backmerge has no story: an empty body is honest where a summary would be noise. */
  it('leaves a backmerge description empty', () => {
    expect(staticPrBody('sync', null)).toBe('');
  });

  /**
   * The rule: nothing to merge means an empty description, and — more importantly — no
   * model call. Asked to summarise an empty change set a model does not say "nothing to
   * say"; it hedges from the branch name at length ("appears to relate to…", "a reviewer
   * should check the actual diff"), which occupies the space a reader scans and tells them
   * less than a blank body would.
   */
  it('leaves the description empty when there is nothing to describe', () => {
    const empty = { subjects: [], totalCommits: 0, files: [], filesTruncated: false };
    expect(hasMaterialToDescribe(empty)).toBe(false);
    expect(hasMaterialToDescribe(null)).toBe(false);
    expect(staticPrBody('offer', empty)).toBe('');
    expect(staticPrBody('offer', null)).toBe('');
  });

  it('counts a change set with commits or files as worth describing', () => {
    expect(
      hasMaterialToDescribe({
        subjects: ['Add a thing'],
        totalCommits: 1,
        files: [],
        filesTruncated: false,
      }),
    ).toBe(true);
    // Files without commits happens on an odd range; either alone is enough.
    expect(
      hasMaterialToDescribe({
        subjects: [],
        totalCommits: 0,
        files: [{ filename: 'a.ts', additions: 1, deletions: 0 }],
        filesTruncated: false,
      }),
    ).toBe(true);
  });

  it('lists commits for an offer, and says how many it left out', () => {
    const body = staticPrBody('offer', {
      subjects: Array.from({ length: 25 }, (_, i) => `commit ${i}`),
      totalCommits: 25,
      files: [{ filename: 'a.ts', additions: 1, deletions: 0 }],
      filesTruncated: false,
    });
    expect(body).toContain('- commit 0');
    expect(body).toContain('- …and 5 more commits');
    expect(body).toContain('1 files changed.');
  });
});

describe('normaliseTitle', () => {
  it('takes the first line and strips what a model wraps around it', () => {
    expect(normaliseTitle('  "Add a retry"  \nand more')).toBe('Add a retry');
    expect(normaliseTitle('Title: `Add a retry`')).toBe('Add a retry');
  });

  it('caps the length', () => {
    expect(normaliseTitle('x'.repeat(200))).toHaveLength(100);
  });
});

describe('defangReferences', () => {
  /**
   * The consequence this exists for: a closing keyword in a merged pull request closes
   * somebody's issue, and this app cannot know which issue the branch belongs to.
   */
  it('stops an issue reference being a reference', () => {
    expect(defangReferences('Fixes #123 at last')).toBe('Fixes `#123` at last');
  });

  it('stops a mention notifying anyone', () => {
    expect(defangReferences('thanks @octocat')).toBe('thanks `@octocat`');
  });

  it('leaves a code span alone rather than nesting backticks in it', () => {
    expect(defangReferences('see `#123` there')).toBe('see `#123` there');
  });

  it('leaves a URL fragment alone', () => {
    const url = 'https://example.com/x#123';
    expect(defangReferences(url)).toBe(url);
  });
});

describe('parseComposedPr', () => {
  it('splits on the markers', () => {
    const parsed = parseComposedPr('<<<TITLE>>>\nAdd retries\n<<<BODY>>>\nBecause flakes.', 'fb');
    expect(parsed.title).toBe('Add retries');
    expect(parsed.body).toBe('Because flakes.');
  });

  /**
   * The pull request is the product and the prose is decoration, so a reply that ignored
   * the contract still has to produce something openable.
   */
  it('falls back to the caller title when no marker appears', () => {
    const parsed = parseComposedPr('I have written you a lovely description.', 'feature/x → main');
    expect(parsed.title).toBe('feature/x → main');
    expect(parsed.body).toBe('I have written you a lovely description.');
  });

  it('falls back when the title section is empty', () => {
    const parsed = parseComposedPr('<<<TITLE>>>\n\n<<<BODY>>>\nbody', 'fallback');
    expect(parsed.title).toBe('fallback');
  });

  it('defangs references that came through the markers', () => {
    const parsed = parseComposedPr('<<<TITLE>>>\nT\n<<<BODY>>>\nCloses #9', 'fb');
    expect(parsed.body).toBe('Closes `#9`');
  });
});

describe('mergeVerdict', () => {
  it('reads the states that matter', () => {
    expect(mergeVerdict(pr({ mergeable_state: 'clean' })).tone).toBe('ok');
    expect(mergeVerdict(pr({ mergeable_state: 'blocked' })).tone).toBe('wait');
    expect(mergeVerdict(pr({ mergeable_state: 'dirty' })).tone).toBe('stuck');
  });

  it('says so plainly while GitHub is still deciding', () => {
    expect(mergeVerdict(pr()).text).toMatch(/still working out/);
  });

  /** The set is undocumented and GitHub extends it; a new value must not be mistranslated. */
  it('reports an unrecognised state rather than guessing at one', () => {
    expect(mergeVerdict(pr({ mergeable_state: 'wobbly' })).text).toContain('wobbly');
  });

  it('puts merged ahead of everything else', () => {
    expect(mergeVerdict(pr({ merged_at: '2026-01-02T00:00:00Z', state: 'closed' })).text).toBe(
      'Merged',
    );
  });
});

describe('checkCounts', () => {
  it('counts only completed runs, and failures among them', () => {
    const counts = checkCounts([
      check(),
      check({ conclusion: 'failure' }),
      check({ status: 'in_progress', conclusion: null }),
    ]);
    expect(counts).toEqual({ total: 3, done: 2, failed: 1 });
  });
});

describe('mergeStages', () => {
  it('marks the checks stage stuck when one failed', () => {
    const stages = mergeStages(pr(), [check({ conclusion: 'failure' })], null, true);
    const checks = stages.find((s) => s.id === 'checks')!;
    expect(checks.state).toBe('stuck');
    expect(checks.detail).toBe('1 failed of 1');
  });

  it('holds the checks stage pending until they have been fetched', () => {
    expect(mergeStages(pr(), [], null, false).find((s) => s.id === 'checks')!.state).toBe(
      'pending',
    );
  });

  it('treats a PR with no checks as having cleared them', () => {
    const checks = mergeStages(pr(), [], null, true).find((s) => s.id === 'checks')!;
    expect(checks.state).toBe('done');
    expect(checks.detail).toBe('none required');
  });

  it('shows every stage done once it is merged', () => {
    const stages = mergeStages(pr({ merged_at: '2026-01-02T00:00:00Z' }), [], null, true);
    expect(stages.every((s) => s.state === 'done')).toBe(true);
  });

  it('marks the last stage stuck when it was closed unmerged', () => {
    const stages = mergeStages(pr({ state: 'closed' }), [], null, true);
    expect(stages.find((s) => s.id === 'merged')!.state).toBe('stuck');
  });
});

describe('autoMergeIsAvailable', () => {
  /**
   * The rule the whole feature turns on: GitHub refuses to queue a pull request it could
   * merge already, so this decides between two different API calls rather than being a
   * preference. Getting it wrong means a write that always fails.
   */
  it('is false for a pull request GitHub can merge now', () => {
    expect(autoMergeIsAvailable(pr({ mergeable_state: 'clean' }))).toBe(false);
    expect(autoMergeIsAvailable(pr({ mergeable_state: 'has_hooks' }))).toBe(false);
  });

  it('is true for one that is blocked or behind', () => {
    expect(autoMergeIsAvailable(pr({ mergeable_state: 'blocked' }))).toBe(true);
    expect(autoMergeIsAvailable(pr({ mergeable_state: 'behind' }))).toBe(true);
  });

  it('is false when it is already armed or no longer open', () => {
    expect(
      autoMergeIsAvailable(
        pr({
          mergeable_state: 'blocked',
          auto_merge: { enabled_by: null, merge_method: 'merge', commit_title: null, commit_message: null },
        }),
      ),
    ).toBe(false);
    expect(autoMergeIsAvailable(pr({ mergeable_state: 'blocked', state: 'closed' }))).toBe(false);
  });
});

describe('nextStep', () => {
  const standing = (over: Partial<Parameters<typeof nextStep>[0]> = {}) => ({
    state: 'identical' as const,
    behindBy: 0,
    aheadBy: 0,
    ownCommits: 0,
    filesDiffering: 0,
    ...over,
  });
  const facts = (over: Partial<PullRequest> = {}, overall: OverallStatus = 'success') => ({
    pr: pr(over),
    overall,
  });

  /**
   * An open pull request outranks the branch's standing: whatever is wrong with it blocks
   * everything behind it, so that is what to look at.
   */
  it('puts an open offer ahead of the standing', () => {
    const step = nextStep(standing({ state: 'behind', behindBy: 3 }), facts(), null);
    expect(step).toMatchObject({ text: 'Enable auto-merge on #42', target: 'arm' });
  });

  it('names conflicts before anything else', () => {
    expect(nextStep(standing(), facts({ mergeable: false, mergeable_state: 'dirty' }), null)).toMatchObject({
      text: 'Resolve the conflicts on #42',
      tone: 'stuck',
    });
  });

  it('names failing checks', () => {
    expect(nextStep(standing(), facts({}, 'failure'), null)).toMatchObject({
      text: 'Fix the failing checks on #42',
      tone: 'stuck',
    });
  });

  it('says there is nothing to do once auto-merge is on', () => {
    const armed = facts({
      auto_merge: { enabled_by: null, merge_method: 'squash', commit_title: null, commit_message: null },
    });
    expect(nextStep(standing(), armed, null)).toMatchObject({ target: 'none', tone: 'ok' });
  });

  it('flags a failing backmerge when nothing is being offered', () => {
    expect(nextStep(standing(), null, facts({ number: 9 }, 'failure'))).toMatchObject({
      text: 'Fix the failing checks on #9, the incoming backmerge',
      tone: 'stuck',
    });
  });

  it('sends you to pull when the fork is behind', () => {
    expect(nextStep(standing({ state: 'behind', behindBy: 2 }), null, null)).toMatchObject({
      text: 'Pull it into your fork',
      target: 'pull',
    });
  });

  it('sends you to commit when the fork is ahead with work of its own', () => {
    expect(
      nextStep(standing({ state: 'ahead', aheadBy: 2, ownCommits: 2, filesDiffering: 1 }), null, null),
    ).toMatchObject({ text: 'Commit your changes to the upstream', target: 'offer' });
  });

  /** Getting current first is what keeps the offer from being made against stale code. */
  it('pulls before committing when both directions have something', () => {
    expect(
      nextStep(
        standing({ state: 'diverged', behindBy: 1, aheadBy: 2, ownCommits: 2, filesDiffering: 1 }),
        null,
        null,
      ),
    ).toMatchObject({ text: 'Pull it into your fork, then commit your changes', target: 'pull' });
  });

  /**
   * The squash-merge case. The commit counts say two commits are still ahead; the content
   * says otherwise, and the content is what matters.
   */
  it('says the work is already merged when only the history diverges', () => {
    expect(
      nextStep(
        standing({ state: 'diverged', behindBy: 1, aheadBy: 2, ownCommits: 2, filesDiffering: 0 }),
        null,
        null,
      ),
    ).toMatchObject({ text: 'Already merged upstream — pull to line the histories up', tone: 'ok' });
  });

  it('has nothing to offer when the fork is ahead but changes no file', () => {
    expect(
      nextStep(standing({ state: 'ahead', aheadBy: 1, ownCommits: 1, filesDiffering: 0 }), null, null),
    ).toMatchObject({ text: 'Nothing to do', target: 'none' });
  });

  it('admits when it could not compare', () => {
    expect(
      nextStep(standing({ state: 'unknown', filesDiffering: null }), null, null),
    ).toMatchObject({ tone: 'stuck', target: 'none' });
  });
});

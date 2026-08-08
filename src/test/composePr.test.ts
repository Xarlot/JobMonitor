import { describe, expect, it } from 'vitest';
import { buildComposePrompt, summariseComparison } from '../lib/composePr';
import { BODY_MARKER, TITLE_MARKER } from '../lib/featureBranch';
import type { Comparison } from '../api/types';

function comparison(overrides: Partial<Comparison> = {}): Comparison {
  return {
    status: 'ahead',
    ahead_by: 2,
    behind_by: 0,
    total_commits: 2,
    commits: [
      { sha: 'a', commit: { message: 'Older subject\n\nA body nobody needs.', author: null } },
      { sha: 'b', commit: { message: 'Newer subject', author: null } },
    ],
    files: [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }],
    ...overrides,
  };
}

describe('summariseComparison', () => {
  it('keeps only the subject line of each commit', () => {
    expect(summariseComparison(comparison()).subjects).toEqual(['Newer subject', 'Older subject']);
  });

  /**
   * The order is reversed from GitHub's on purpose — the list is capped, and the recent
   * work is what a pull request is about — so whatever renders it has to say "newest
   * first". Labelling a reversed list "oldest first" makes the model read the branch's
   * chronology backwards.
   */
  it('is labelled in the order it actually produces', () => {
    const summary = summariseComparison(comparison());
    const prompt = buildComposePrompt({
      branch: 'feature/x',
      baseBranch: 'main',
      repoSlug: 'o/r',
      summary,
    });
    expect(prompt).toContain('newest first');
    expect(prompt).not.toContain('oldest first');
    // And the label matches the data: the first subject listed is the newest commit.
    expect(summary.subjects[0]).toBe('Newer subject');
  });

  it('reports the true commit count even when the list is capped', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      sha: `s${i}`,
      commit: { message: `subject ${i}`, author: null },
    }));
    const summary = summariseComparison(comparison({ commits: many, total_commits: 412 }));
    expect(summary.subjects).toHaveLength(60);
    expect(summary.totalCommits).toBe(412);
  });

  it('notices the 300-file ceiling GitHub imposes', () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    }));
    expect(summariseComparison(comparison({ files })).filesTruncated).toBe(true);
  });

  it('survives a comparison with no file list', () => {
    const summary = summariseComparison(comparison({ files: undefined }));
    expect(summary.files).toEqual([]);
    expect(summary.filesTruncated).toBe(false);
  });
});

describe('buildComposePrompt', () => {
  const context = {
    branch: 'feature/x',
    baseBranch: 'main',
    repoSlug: 'o/r',
    summary: summariseComparison(comparison()),
  };

  it('asks for both markers', () => {
    const prompt = buildComposePrompt(context);
    expect(prompt).toContain(TITLE_MARKER);
    expect(prompt).toContain(BODY_MARKER);
  });

  /**
   * The rule with a consequence outside this app: a closing keyword in a merged pull
   * request closes somebody's issue, and nothing here can know which one belongs to it.
   */
  it('forbids closing keywords and mentions', () => {
    const prompt = buildComposePrompt(context);
    expect(prompt).toMatch(/No "Fixes #…"/);
    expect(prompt).toMatch(/No @mentions/);
  });

  /**
   * The second line of defence. The first is not calling the model at all when there is
   * nothing to summarise; this covers thin-but-nonempty material, where the same hedging
   * appears — a description about the evidence rather than about the change.
   */
  it('forbids guessing from the branch name and writing about the evidence', () => {
    const prompt = buildComposePrompt(context);
    expect(prompt).toMatch(/Do not guess from the branch name/);
    expect(prompt).toMatch(/leave the description section empty rather than filling it/);
    expect(prompt).toMatch(/Never speculate about what a change "appears to relate to"/);
    expect(prompt).toMatch(/Nothing about your own confidence/);
  });

  it('carries the commits and the files', () => {
    const prompt = buildComposePrompt(context);
    expect(prompt).toContain('Newer subject');
    expect(prompt).toContain('src/a.ts (+3 −1)');
  });

  it('says how many commits were left out', () => {
    const prompt = buildComposePrompt({
      ...context,
      summary: { ...context.summary, totalCommits: 400 },
    });
    expect(prompt).toContain('…and 398 earlier commits');
  });

  it('appends the standing instructions rather than replacing anything', () => {
    const prompt = buildComposePrompt({ ...context, extraInstructions: 'We use British spelling.' });
    expect(prompt).toContain(TITLE_MARKER);
    expect(prompt).toContain('We use British spelling.');
  });

  /** A custom prompt replaces the brief; the material is still appended below it. */
  it('lets a custom prompt replace the brief', () => {
    const prompt = buildComposePrompt({ ...context, promptOverride: 'Write it in haiku.' });
    expect(prompt).toContain('Write it in haiku.');
    expect(prompt).not.toContain(TITLE_MARKER);
    expect(prompt).toContain('Newer subject');
  });
});

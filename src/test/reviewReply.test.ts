import { describe, expect, it } from 'vitest';
import {
  buildImproveReplyPrompt,
  buildResolveNotePrompt,
  buildReviewReplyPrompt,
  codeExcerpt,
  parseResolveNote,
  parseReviewReply,
} from '../lib/reviewReply';
import type { ReviewThread } from '../api/reviewThreads';

const THREAD: ReviewThread = {
  id: 'T',
  isResolved: false,
  isOutdated: true,
  path: 'src/Exporter.java',
  line: 12,
  diffHunk: '@@ -1 +1 @@\n+int retries = 3;',
  comments: [
    { id: 'c1', author: { login: 'alice', avatarUrl: '', isBot: false }, body: 'Why mutable?', createdAt: '', url: '' },
    { id: 'c2', author: { login: 'bob', avatarUrl: '', isBot: false }, body: 'Agreed', createdAt: '', url: '' },
  ],
  commentsTruncated: false,
  viewerCanResolve: true,
  viewerCanReply: true,
};

describe('buildReviewReplyPrompt', () => {
  it('carries the code, the conversation and which comment to answer', () => {
    const prompt = buildReviewReplyPrompt({
      repoSlug: 'acme/rocket',
      prNumber: 7,
      prTitle: 'Retry exports',
      thread: THREAD,
      commentId: 'c1',
      extraInstructions: 'Be terse.',
    });
    expect(prompt).toContain('src/Exporter.java:12 (the code has changed since)');
    expect(prompt).toContain('+int retries = 3;');
    expect(prompt).toMatch(/--- alice ← reply to this one\nWhy mutable\?/);
    expect(prompt).not.toMatch(/bob ← reply/);
    expect(prompt).toContain('Never claim a change has already been made');
    expect(prompt.trimEnd().endsWith('Be terse.')).toBe(true);
  });

  it('answers the last comment when none is named', () => {
    const prompt = buildReviewReplyPrompt({ repoSlug: 'a/b', prNumber: 1, prTitle: 't', thread: THREAD });
    expect(prompt).toMatch(/bob ← reply to this one/);
  });

  it('lets an override replace the brief but keeps the material', () => {
    const prompt = buildReviewReplyPrompt({
      repoSlug: 'a/b',
      prNumber: 1,
      prTitle: 't',
      thread: THREAD,
      promptOverride: 'Reply in German.',
    });
    expect(prompt.startsWith('Reply in German.')).toBe(true);
    expect(prompt).toContain('Why mutable?');
  });
});

describe('parseReviewReply', () => {
  it('unwraps a fence around the whole reply', () => {
    expect(parseReviewReply('```markdown\nMakes sense, will make it final.\n```')).toBe(
      'Makes sense, will make it final.',
    );
  });

  /** A reply goes out under the user's name; a handle the model picked must not notify anyone. */
  it('defuses mentions but leaves email addresses alone', () => {
    expect(parseReviewReply('Agreed (@alice), see me@example.com')).toBe('Agreed (`@alice`), see me@example.com');
  });
});

describe('codeExcerpt', () => {
  const file = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  it('numbers a window around the line, marking what was cut', () => {
    const out = codeExcerpt(file, 100, 2).split('\n');
    expect(out).toEqual(['…', ' 98| line 98', ' 99| line 99', '100| line 100', '101| line 101', '102| line 102', '…']);
  });

  it('gives a short file whole, and clamps a line past the end', () => {
    expect(codeExcerpt('a\nb\n', 1, 2)).toBe('1| a\n2| b');
    expect(codeExcerpt(file, 500, 1).split('\n')).toEqual(['…', '199| line 199', '200| line 200']);
  });
});

describe('buildResolveNotePrompt', () => {
  const base = { repoSlug: 'acme/rocket', prNumber: 7, prTitle: 'Retry exports', thread: THREAD };

  it('carries the old code, the conversation and the current file', () => {
    const prompt = buildResolveNotePrompt({ ...base, currentCode: { kind: 'excerpt', text: '12| final int retries = 3;' } });
    expect(prompt).toContain('VERDICT: <addressed|obsolete|settled|unaddressed>');
    expect(prompt).toContain('+int retries = 3;');
    expect(prompt).toContain('--- alice\nWhy mutable?');
    expect(prompt).toContain('12| final int retries = 3;');
    expect(prompt).toContain('marks this conversation outdated');
  });

  it('says when the file is gone, or could not be read', () => {
    expect(buildResolveNotePrompt({ ...base, currentCode: { kind: 'deleted' } })).toContain(
      'src/Exporter.java no longer exists',
    );
    expect(buildResolveNotePrompt({ ...base, currentCode: { kind: 'unavailable' } })).toContain('could not be read');
  });
});

describe('parseResolveNote', () => {
  it('splits the verdict from the note, and cleans the note', () => {
    expect(parseResolveNote('VERDICT: addressed\n\n`retries` is `final` now, as @alice asked.')).toEqual({
      verdict: 'addressed',
      text: '`retries` is `final` now, as `@alice` asked.',
    });
    expect(parseResolveNote('**Verdict:** Unaddressed\nStill mutable.').verdict).toBe('unaddressed');
  });

  it('treats a reply without a known verdict as all note', () => {
    expect(parseResolveNote('VERDICT: maybe\nHm.')).toEqual({ verdict: null, text: 'VERDICT: maybe\nHm.' });
    expect(parseResolveNote('Done.')).toEqual({ verdict: null, text: 'Done.' });
  });
});

describe('buildImproveReplyPrompt', () => {
  it('carries the draft and the instruction, and forbids adding facts', () => {
    const prompt = buildImproveReplyPrompt({
      repoSlug: 'acme/rocket',
      prNumber: 7,
      prTitle: 'Retry exports',
      thread: THREAD,
      draft: 'made it final  ',
      instruction: 'more polite',
      resolving: true,
    });
    expect(prompt).toContain('posted as they resolve the conversation');
    expect(prompt).toContain('"""\nmade it final\n"""');
    expect(prompt).toMatch(/How the user wants it changed:\nmore polite$/);
    expect(prompt).toContain('Do not add facts');
  });
});

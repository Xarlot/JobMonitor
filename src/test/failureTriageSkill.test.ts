import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { failureTriageSkill: { SKILL_NAME, SKILL_MARKDOWN } } = require('../../electron/skills.cjs');

describe('the failure-triage skill', () => {
  /**
   * The repo copy is generated (`npm run skills:sync`) so a developer can run the same
   * procedure by hand, while the app ships the string — a packaged build has no repo to
   * read from. Two copies only stay honest if drift is a test failure.
   */
  it('matches the copy checked into .claude/skills', () => {
    const onDisk = readFileSync(`.claude/skills/${SKILL_NAME}/SKILL.md`, 'utf8');
    expect(onDisk).toBe(SKILL_MARKDOWN);
  });

  it('has the frontmatter the CLI needs to discover it', () => {
    const [, frontmatter] = SKILL_MARKDOWN.split('---');
    expect(frontmatter).toContain(`name: ${SKILL_NAME}`);
    expect(frontmatter).toMatch(/description:\s*\S/);
  });

  /** The description is what the model matches on; a vague one never fires. */
  it('says when to use it, not just what it is', () => {
    const [, frontmatter] = SKILL_MARKDOWN.split('---');
    expect(frontmatter).toMatch(/use when/i);
  });

  /**
   * The failure this exists to prevent: asked about one job, the model surveys the whole
   * pull request and returns five findings, leaving the reader to do the sorting that was
   * the point of asking.
   */
  it('scopes the work to the one failure it was given', () => {
    expect(SKILL_MARKDOWN).toMatch(/stay on the failure you were given/i);
    expect(SKILL_MARKDOWN).toMatch(/do not survey the pull request/i);
    expect(SKILL_MARKDOWN).toMatch(/two unrelated failing jobs are two triages/i);
  });

  /**
   * …but not so narrowly that an aggregator becomes unanswerable. A job that exits 1
   * because a `needs:` job failed can never name a cause from its own log.
   */
  it('allows going upstream, with a test for when', () => {
    expect(SKILL_MARKDOWN).toMatch(/only when/i);
    expect(SKILL_MARKDOWN).toMatch(/aggregator/i);
    expect(SKILL_MARKDOWN).toContain('needs:');
  });

  it('requires saying which job it ended up in', () => {
    expect(SKILL_MARKDOWN).toMatch(/say in your answer which job you ended up in/i);
  });

  /** Transient download failures are common and none of them mean the artifact is gone. */
  it('tells it to retry a failed download before giving up', () => {
    expect(SKILL_MARKDOWN).toMatch(/retry a download before giving up/i);
    expect(SKILL_MARKDOWN).toMatch(/retry once/i);
    expect(SKILL_MARKDOWN).toContain('GODEBUG=http2client=0');
    expect(SKILL_MARKDOWN).toMatch(/CANCEL; received from peer/);
  });

  /** …and bounds the retrying, so a dead artifact store can't eat the whole budget. */
  it('caps the retrying and says what to do instead', () => {
    expect(SKILL_MARKDOWN).toMatch(/two failed attempts is enough/i);
    expect(SKILL_MARKDOWN).toMatch(/fall back to a cheaper source/i);
  });

  /**
   * The speed/accuracy trade-off, stated as a budget rather than an adjective — "be
   * efficient" changes nothing, "two to four tool calls" does.
   */
  it('gives a concrete budget and a stopping rule', () => {
    expect(SKILL_MARKDOWN).toMatch(/two to four tool calls/i);
    expect(SKILL_MARKDOWN).toMatch(/stop as soon as you can name/i);
    expect(SKILL_MARKDOWN).toMatch(/skipping a step you did not need is correct/i);
  });

  it('orders the evidence cheapest first', () => {
    const log = SKILL_MARKDOWN.indexOf('The failed step');
    const report = SKILL_MARKDOWN.indexOf('The test report');
    const workflow = SKILL_MARKDOWN.indexOf('The workflow file');
    const diff = SKILL_MARKDOWN.indexOf('The diff');
    expect(log).toBeGreaterThan(-1);
    expect(log).toBeLessThan(report);
    expect(report).toBeLessThan(workflow);
    expect(workflow).toBeLessThan(diff);
  });

  it('points at the runner’s own failure lines rather than the summary', () => {
    for (const token of ['FAILED', 'AssertionError', 'Caused by']) {
      expect(SKILL_MARKDOWN).toContain(token);
    }
    expect(SKILL_MARKDOWN).toMatch(/grep them rather than reading end to end/i);
  });

  /** Same rule as the brief: a confident wrong link is worse than no link. */
  it('forbids inventing links, SHAs, paths and test names', () => {
    expect(SKILL_MARKDOWN).toMatch(/never invent/i);
    expect(SKILL_MARKDOWN).toMatch(/commit SHA/i);
  });

  it('asks it to separate an infrastructure failure from a code one', () => {
    expect(SKILL_MARKDOWN).toMatch(/infrastructure/i);
    expect(SKILL_MARKDOWN).toMatch(/who should pick this up/i);
  });

  it('asks for one recommendation rather than a list', () => {
    expect(SKILL_MARKDOWN).toMatch(/one recommendation\*?\*?, not a list/i);
  });
});


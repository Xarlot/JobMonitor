import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { flowBlameSkill: { SKILL_NAME, SKILL_MARKDOWN } } = require('../../electron/skills.cjs');

describe('the flow-blame skill', () => {
  it('matches the copy checked into .claude/skills', () => {
    expect(readFileSync(`.claude/skills/${SKILL_NAME}/SKILL.md`, 'utf8')).toBe(SKILL_MARKDOWN);
  });

  it('has the frontmatter the CLI needs to discover it', () => {
    const [, frontmatter] = SKILL_MARKDOWN.split('---');
    expect(frontmatter).toContain(`name: ${SKILL_NAME}`);
    expect(frontmatter).toMatch(/use when/i);
  });

  /** It answers a different question from failure-triage and must not be confused with it. */
  it('distinguishes itself from triaging one run', () => {
    const [, frontmatter] = SKILL_MARKDOWN.split('---');
    expect(frontmatter).toMatch(/rather than why one run failed/i);
  });

  /**
   * The expensive mistake this whole ordering exists to prevent: naming a developer's
   * commit for someone else's flaky test. On a gated branch a flake and infrastructure are
   * both likelier than a bad commit, so they are ruled out first.
   */
  it('rules out a flake and infrastructure before naming a commit', () => {
    const intermittent = SKILL_MARKDOWN.indexOf('intermittent before you ask whose fault');
    const infra = SKILL_MARKDOWN.indexOf('Rule out infrastructure');
    const commits = SKILL_MARKDOWN.indexOf('Name the commits in the range');
    expect(intermittent).toBeGreaterThan(-1);
    expect(intermittent).toBeLessThan(infra);
    expect(infra).toBeLessThan(commits);
  });

  it('finds the boundary between the last good and first bad run', () => {
    expect(SKILL_MARKDOWN).toMatch(/last successful run/i);
    expect(SKILL_MARKDOWN).toMatch(/first failing run after it/i);
    expect(SKILL_MARKDOWN).toContain('gh run list');
  });

  it('reads the alternating pattern as a flake rather than a break', () => {
    expect(SKILL_MARKDOWN).toMatch(/passing and failing alternately/i);
    expect(SKILL_MARKDOWN).toMatch(/do not name a commit/i);
  });

  /** A failure that names no test is not anybody's commit. */
  it('classifies a testless failure as infrastructure', () => {
    expect(SKILL_MARKDOWN).toMatch(/without naming a test/i);
    expect(SKILL_MARKDOWN).toMatch(/not\s+anybody's commit/i);
  });

  it('uses the compare API to list the commits in the range', () => {
    expect(SKILL_MARKDOWN).toContain('compare/<last-good-sha>...<first-bad-sha>');
  });

  /** The gate is what makes a branch failure evidence of a flake. */
  it('explains why a gated branch failure means a flaky test', () => {
    expect(SKILL_MARKDOWN).toMatch(/merge-gated branch/i);
    expect(SKILL_MARKDOWN).toContain('check-pull-request.yml');
    expect(SKILL_MARKDOWN).toMatch(/2026\.1/);
    expect(SKILL_MARKDOWN).toMatch(/already passed it/i);
  });

  /**
   * The scan is the most expensive thing this skill can do, and fanning out across branches
   * turns a bounded question into a survey of the repository. It stays on the branch under
   * analysis unless someone explicitly asks otherwise.
   */
  it('scans only the branch being analysed', () => {
    expect(SKILL_MARKDOWN).toMatch(/scan only the branch you are\s+analysing/i);
    expect(SKILL_MARKDOWN).toMatch(/do not fan out across other branches/i);
    expect(SKILL_MARKDOWN).toMatch(/say which branch and why, and stop/i);
  });

  it('bounds how many failing runs it opens', () => {
    expect(SKILL_MARKDOWN).toMatch(/three or four is enough/i);
    expect(SKILL_MARKDOWN).toMatch(/annotations are far cheaper than logs/i);
  });

  /** The same history means different things depending on whether the branch is gated. */
  it('reads the evidence differently on a PR branch', () => {
    expect(SKILL_MARKDOWN).toMatch(/pull-request branch\*\* carries no such guarantee/i);
    expect(SKILL_MARKDOWN).toMatch(/means nothing about whose fault it is/i);
  });

  it('keeps infrastructure runs out of the flake list', () => {
    expect(SKILL_MARKDOWN).toMatch(/is infrastructure, not a flake/i);
    expect(SKILL_MARKDOWN).toMatch(/padded with dead runners/i);
  });

  /** Intermittency is the signal; something failing every time is broken, not flaky. */
  it('excludes a test that fails on every run', () => {
    expect(SKILL_MARKDOWN).toMatch(/is not flaky\s+—\s+it is broken/i);
    expect(SKILL_MARKDOWN).toMatch(/intermittency\s+is the whole signal/i);
  });

  /** "Where it failed" is the half that makes the row actionable. */
  it('asks for the flaky test as a table with run links', () => {
    expect(SKILL_MARKDOWN).toMatch(/### Flaky tests/);
    expect(SKILL_MARKDOWN).toMatch(/\| Test \| Failures \| Last seen \| Runs \|/);
    expect(SKILL_MARKDOWN).toMatch(/keep the run links/i);
  });

  /**
   * A fixed four-line block, so the answer is scannable and pasteable without editing —
   * prose alone made the reader hunt for the name and the run number.
   */
  it('opens with a fixed summary block', () => {
    expect(SKILL_MARKDOWN).toMatch(/### Summary/);
    for (const field of ['\\*\\*Who:\\*\\*', '\\*\\*What happened:\\*\\*', '\\*\\*When:\\*\\*', '\\*\\*Kind:\\*\\*']) {
      expect(SKILL_MARKDOWN).toMatch(new RegExp(field));
    }
  });

  it('constrains Kind to the four verdicts', () => {
    expect(SKILL_MARKDOWN).toMatch(/`commit`, `flaky test`, `infrastructure`, `never verified`/);
  });

  /** "nobody" has to be as explicit as a name, or the reader assumes it was left blank. */
  it('requires an explicit nobody when it is not a person', () => {
    expect(SKILL_MARKDOWN).toMatch(/`nobody — flaky test`/);
  });

  /** Written as @login so the eye finds it and the reader can search for it. */
  it('requires the login to be written as a mention, never invented', () => {
    expect(SKILL_MARKDOWN).toMatch(/always write a login as `@login`/i);
    expect(SKILL_MARKDOWN).toMatch(/write `@unknown`/);
  });

  it('keeps the nuance out of the scannable part', () => {
    expect(SKILL_MARKDOWN).toMatch(/the four lines above must stay scannable/i);
  });

  it('forbids inventing a SHA, an author or a run number', () => {
    expect(SKILL_MARKDOWN).toMatch(/never invent a URL, a SHA, an author, a run number/i);
  });

  /** The scan is the expensive part, so it is bounded rather than open-ended. */
  it('bounds the scan', () => {
    expect(SKILL_MARKDOWN).toMatch(/do this once, in as few calls as the API allows/i);
  });
});

describe('attributing the break to a person', () => {
  /** The question is "who", so the answer has to be a name and a commit, not a hint. */
  it('is framed as naming the commit and its author', () => {
    expect(SKILL_MARKDOWN).toMatch(/# Who broke this flow/);
    expect(SKILL_MARKDOWN).toMatch(/the commit that broke a flow and the author who wrote it/i);
  });

  /** …but a wrong name is worse than none, which is what keeps the ordering honest. */
  it('says why a wrong name costs more than no name', () => {
    expect(SKILL_MARKDOWN).toMatch(/a wrong name costs more than no name/i);
  });

  it('answers directly when the range holds one commit', () => {
    expect(SKILL_MARKDOWN).toMatch(/one commit in the range\?\*\* That is your answer/i);
  });

  /**
   * The case the mode exists for: several commits between two runs. Order of arrival is a
   * weak signal, so the ranking has to come from what each commit actually changed.
   */
  it('ranks several candidates by what they changed, not by arrival order', () => {
    expect(SKILL_MARKDOWN).toMatch(/weigh the candidates by what they changed/i);
    expect(SKILL_MARKDOWN).toMatch(/order of arrival is a \*\*weak\*\* signal/i);
    expect(SKILL_MARKDOWN).toMatch(/content decides/i);
  });

  it('names the signals for and against a candidate', () => {
    expect(SKILL_MARKDOWN).toMatch(/touches the code the failing test exercises/i);
    expect(SKILL_MARKDOWN).toMatch(/touches the test, its fixtures or its baselines/i);
    expect(SKILL_MARKDOWN).toMatch(/failure text names something it changed/i);
    expect(SKILL_MARKDOWN).toMatch(/changes shared machinery/i);
    expect(SKILL_MARKDOWN).toMatch(/touches nothing the failure could reach/i);
  });

  /** Breadth is not guilt — a big refactor must not win by being big. */
  it('refuses to treat size as evidence on its own', () => {
    expect(SKILL_MARKDOWN).toMatch(/breadth is not guilt/i);
  });

  /** The probability the answer is asked for, with a rule that keeps it from being noise. */
  it('asks for a likelihood per candidate, justified by the signals', () => {
    expect(SKILL_MARKDOWN).toMatch(/likelihood per candidate/i);
    expect(SKILL_MARKDOWN).toMatch(/summing to about 100/i);
    expect(SKILL_MARKDOWN).toMatch(/inventing a number you cannot justify/i);
  });

  /** Calibration, so "least-bad guess" never gets promoted to an accusation. */
  it('says what each confidence band means, including not knowing', () => {
    expect(SKILL_MARKDOWN).toMatch(/one candidate at 90%\+/i);
    expect(SKILL_MARKDOWN).toMatch(/everything under 40%\*\* means you do not know/i);
    expect(SKILL_MARKDOWN).toMatch(/never move a percentage to make the list look decisive/i);
  });

  /** Pressing the merge button is not writing the change. */
  it('attributes a merge commit to the author of the merged work', () => {
    expect(SKILL_MARKDOWN).toMatch(/not whoever pressed the\s+button/i);
  });

  it('asks for the suspects as a table with author and likelihood', () => {
    expect(SKILL_MARKDOWN).toMatch(/### Who/);
    expect(SKILL_MARKDOWN).toMatch(/\| Likelihood \| Author \| Commit \| What they changed \|/);
  });

  it('requires unknown rather than a guessed author', () => {
    expect(SKILL_MARKDOWN).toMatch(/write `unknown` rather than guessing/i);
  });
});

describe('when run history cannot answer', () => {
  /**
   * The trap this exists for, from a real run: `main` was green, but its green runs **skip**
   * the failing suite entirely — the jobs are conditional. A green run that never executed
   * the test is not a baseline, and treating it as one manufactures a boundary that leads
   * straight to blaming an innocent commit.
   */
  it('requires the good run to have actually run the failing test', () => {
    expect(SKILL_MARKDOWN).toMatch(/check the good run actually ran the failing test/i);
    expect(SKILL_MARKDOWN).toMatch(/a suite that never ran\s+cannot have passed/i);
    expect(SKILL_MARKDOWN).toMatch(/treat it\s+as no baseline at all/i);
  });

  /** …and the verdict that follows is a different one, belonging to a different person. */
  it('offers "never verified" as an outcome in its own right', () => {
    expect(SKILL_MARKDOWN).toMatch(/\*\*never verified\*\*/i);
    expect(SKILL_MARKDOWN).toMatch(/nothing regressed; something started being\s+checked/i);
  });

  /**
   * One workflow file is several pipelines depending on the trigger. A green push beside a
   * red dispatch is two different pipelines, not a boundary.
   */
  it('insists on comparing runs of the same trigger event', () => {
    expect(SKILL_MARKDOWN).toMatch(/compare like with like/i);
    expect(SKILL_MARKDOWN).toMatch(/is not a boundary — it is two different pipelines/i);
    expect(SKILL_MARKDOWN).toContain('group_by(.event)');
  });

  it('sends you to the target branch when nothing here has ever passed', () => {
    expect(SKILL_MARKDOWN).toMatch(/if nothing on this branch has ever passed/i);
  });

  /** The fallback the user asked for: no range, so walk the tree by path instead. */
  it('falls back to searching the commit tree by path', () => {
    expect(SKILL_MARKDOWN).toMatch(/no boundary: search the tree by path/i);
    expect(SKILL_MARKDOWN).toContain('commits?path=<file-from-the-stack-trace>');
    expect(SKILL_MARKDOWN).toMatch(/start from the failure, not from the commit list/i);
  });

  it('refuses to invent a range when there is no real boundary', () => {
    expect(SKILL_MARKDOWN).toMatch(/do not invent a range/i);
  });

  /** A new test that has never been green anywhere is not a regression. */
  it('recognises a brand-new test as not a regression', () => {
    expect(SKILL_MARKDOWN).toMatch(/the test is new/i);
    expect(SKILL_MARKDOWN).toMatch(/it is not a regression at all/i);
  });

  /** Fixtures and baselines break deterministic tests exactly like code, and get missed. */
  it('counts a changed fixture or baseline as a candidate', () => {
    expect(SKILL_MARKDOWN).toMatch(/the input changed, not the code/i);
    expect(SKILL_MARKDOWN).toMatch(/changed a fixture, a baseline or an expected-output file/i);
  });

  /** Same failure in two ports means the shared source, which removes half the tree. */
  it('uses a cross-port reproduction to narrow to shared code', () => {
    expect(SKILL_MARKDOWN).toMatch(/two ports of the same code/i);
    expect(SKILL_MARKDOWN).toMatch(/the cause is in the \*\*shared\s+source\*\*/i);
  });

  /** A commit that only changed *which* jobs run revealed the break; it did not cause it. */
  it('separates revealing a break from causing one', () => {
    expect(SKILL_MARKDOWN).toMatch(/only changed which jobs run/i);
    expect(SKILL_MARKDOWN).toMatch(/revealed a test that was already broken/i);
  });

  /** A fixed exception on a fixed input is never noise, whatever the run pattern looks like. */
  it('rules out flakiness for a deterministic error on a fixed input', () => {
    expect(SKILL_MARKDOWN).toMatch(/a deterministic error on a fixed input/i);
    expect(SKILL_MARKDOWN).toMatch(/is never a flake/i);
  });

  /** An unusable boundary has to be reported as which kind, not left blank. */
  it('names the ways a boundary can be unusable', () => {
    expect(SKILL_MARKDOWN).toMatch(/if there is no usable boundary, say which of these it is/i);
    expect(SKILL_MARKDOWN).toMatch(/the green runs never ran this test/i);
  });
});

describe('keeping the answer about the attribution', () => {
  /**
   * The complaint this exists for, from a real verdict: three paragraphs of evidence, a
   * table of eighteen unrelated tests from other branches, an accounting of infrastructure
   * failures and a recommendation about the build farm — around one line saying nobody broke
   * it. Padding makes the reader do the filtering the analysis was supposed to do.
   */
  it('states the test every line has to pass', () => {
    expect(SKILL_MARKDOWN).toMatch(/bears on \*\*who broke\s+this failure\*\*/i);
    expect(SKILL_MARKDOWN).toMatch(/the reader wants a name, or to be told there isn't one/i);
  });

  it('names what to leave out', () => {
    for (const pattern of [
      /tests and runs unrelated to this failure/i,
      /a tour of your investigation/i,
      /observations about the CI infrastructure in general/i,
      /restating the same conclusion/i,
    ]) {
      expect(SKILL_MARKDOWN).toMatch(pattern);
    }
  });

  /** Something broader may still be worth saying — as a sentence, not a section. */
  it('allows a broader observation only as one closing sentence', () => {
    expect(SKILL_MARKDOWN).toMatch(/one sentence at the very end\*\*, not\s+a section/i);
  });

  it('caps the reasoning paragraph', () => {
    expect(SKILL_MARKDOWN).toMatch(/at most three sentences/i);
    expect(SKILL_MARKDOWN).toMatch(/must stay about the attribution/i);
  });

  /** The boundary is two runs; the rest were how you found them. */
  it('keeps the boundary to two lines', () => {
    expect(SKILL_MARKDOWN).toMatch(/not a table of every run you listed/i);
  });

  /**
   * The flaky section is about *this* test. A catalogue of everything the scan saw is the
   * single biggest source of padding, and it reads as evidence while being irrelevant.
   */
  it('limits the flaky table to the test that actually failed', () => {
    expect(SKILL_MARKDOWN).toMatch(/only the test that failed in the run you were asked about/i);
    expect(SKILL_MARKDOWN).toMatch(/not a catalogue/i);
  });

  /** A branch-wide pattern is a real finding — but it is one sentence, not twenty rows. */
  it('reports a wider pattern as a count rather than a list', () => {
    expect(SKILL_MARKDOWN).toMatch(/say that in \*\*one sentence\*\* with the\s+counts/i);
    expect(SKILL_MARKDOWN).toMatch(/do not list them/i);
  });

  it('keeps the follow-up about this failure', () => {
    expect(SKILL_MARKDOWN).toMatch(/not a recommendation about the build farm/i);
  });
});

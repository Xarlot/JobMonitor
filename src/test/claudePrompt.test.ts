import { describe, expect, it } from 'vitest';
import {
  buildClaudePrompt,
  CLAUDE_RESUME_PROMPT,
  CLAUDE_INVESTIGATION_BRIEF,
  CLAUDE_LOG_BRIEF,
  CLAUDE_OFFLINE_BRIEF,
  CLAUDE_QUICK_BRIEF,
  splitIntoSentenceLines,
  parseClaudeAnalysis,
  PROBLEM_MARKER,
  SOLUTION_MARKER,
  trimLog,
  type ClaudePromptInput,
} from '../lib/claudePrompt';
import type { Annotation } from '../api/types';

function annotation(over: Partial<Annotation> = {}): Annotation {
  return {
    path: 'src/Foo.test.ts',
    start_line: 42,
    end_line: 42,
    annotation_level: 'failure',
    message: 'expected 1 to equal 2',
    title: 'Foo > adds',
    raw_details: null,
    ...over,
  };
}

function input(over: Partial<ClaudePromptInput> = {}): ClaudePromptInput {
  return {
    owner: 'acme',
    repo: 'rocket',
    runId: 1001,
    canInvestigate: true,
    depth: 'deep',
    origin: {
      kind: 'pr',
      prNumber: 42,
      prTitle: 'speed up export',
      prUrl: 'https://github.com/acme/rocket/pull/42',
      prState: 'open',
      baseRef: 'main',
    },
    jobName: 'java / test (ubuntu, 21)',
    failedStep: 'Run tests',
    workflowFile: 'ci.yml',
    headRef: 'faster-export',
    headSha: 'abc1234',
    annotations: [annotation()],
    log: 'Run ./gradlew test\nFAILED\n',
    ...over,
  };
}

describe.each([
  ['investigation', CLAUDE_INVESTIGATION_BRIEF],
  ['offline', CLAUDE_OFFLINE_BRIEF],
  ['quick', CLAUDE_QUICK_BRIEF],
])('%s brief', (_name, brief) => {
  /**
   * The whole design rests on the model writing prose only and never inventing
   * links — the report supplies the verified ones. If these instructions get edited
   * loose, reports start carrying plausible-looking wrong URLs.
   */
  it('forbids inventing links and metadata', () => {
    expect(brief).toMatch(/never invent/i);
    expect(brief).toMatch(/url/i);
    expect(brief).toMatch(/sha/i);
  });

  /** The app wraps the solution in <details> itself, and Teams renders no HTML. */
  it('asks for portable Markdown with no HTML or headings', () => {
    expect(brief).toMatch(/no HTML/i);
    expect(brief).toMatch(/Teams/i);
  });

  it('names both output markers', () => {
    expect(brief).toContain(PROBLEM_MARKER);
    expect(brief).toContain(SOLUTION_MARKER);
  });

  it('tells the model to distinguish infrastructure from code failures', () => {
    expect(brief).toMatch(/infrastructure/i);
  });
});

describe('CLAUDE_INVESTIGATION_BRIEF', () => {
  /**
   * The reason this brief exists: with only the workflow's summary annotation the model
   * answers "not enough evidence to name a cause" and lists what it would need — all of
   * which it can fetch itself.
   */
  it('states that tools exist and are expected to be used', () => {
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/you have tools/i);
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/expected to use them/i);
  });

  /**
   * The procedure moved into the skill, so what has to stay here is the pointer to it —
   * without this the model never loads it and falls back to whatever it would have done.
   */
  it('points at the failure-triage skill', () => {
    expect(CLAUDE_INVESTIGATION_BRIEF).toContain('failure-triage');
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/installed in your working directory/i);
  });

  /** The skill can fail to install, so the brief has to survive without it. */
  it('says what to do when the skill is unavailable', () => {
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/if it is not available/i);
    expect(CLAUDE_INVESTIGATION_BRIEF).toContain('COMMANDS');
  });

  /**
   * Repeated in the brief on purpose. These two are the constraints a model drifts from
   * most, and the ones that decide whether the answer is a triage or a survey.
   */
  it('repeats the single-job focus and the tool-call budget', () => {
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/not the pull request/i);
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/two to four tool calls/i);
  });

  it('refuses "insufficient evidence" as a first answer', () => {
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/not enough evidence/i);
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/only .*after you have actually tried/i);
  });




});

describe('CLAUDE_OFFLINE_BRIEF', () => {
  /** Without tools it must not pretend to have investigated. */
  it('says there are no tools on this run', () => {
    expect(CLAUDE_OFFLINE_BRIEF).toMatch(/no tools/i);
    expect(CLAUDE_OFFLINE_BRIEF).not.toMatch(/gh run view/);
  });
});

describe('buildClaudePrompt — commands', () => {
  it('gives the exact commands for this failure, so nothing is reconstructed', () => {
    const p = buildClaudePrompt(input());
    expect(p).toContain('--- COMMANDS ---');
    expect(p).toContain('gh run view 1001 --log-failed --repo acme/rocket');
    expect(p).toContain('gh run download 1001 --repo acme/rocket --dir ./artifacts');
    expect(p).toContain('gh api repos/acme/rocket/actions/runs/1001/artifacts');
    expect(p).toContain('contents/.github/workflows/ci.yml?ref=abc1234');
  });

  it('includes the PR diff commands for a pull-request failure', () => {
    const p = buildClaudePrompt(input());
    expect(p).toContain('gh pr diff 42 --repo acme/rocket');
    expect(p).toContain('gh pr view 42 --repo acme/rocket --json files');
  });

  it('omits PR commands for a flow failure', () => {
    const p = buildClaudePrompt(
      input({
        origin: {
          kind: 'flow',
          flowId: 'f1',
          flowName: 'java-cron',
          runUrl: 'https://github.com/acme/rocket/actions/runs/9',
          runNumber: 42,
          event: 'schedule',
        },
      }),
    );
    expect(p).not.toContain('gh pr diff');
  });

  it('omits run commands when there is no run id', () => {
    const p = buildClaudePrompt(input({ runId: null }));
    expect(p).not.toContain('gh run view');
    // …but still offers the generic file read, which only needs the commit.
    expect(p).toContain('contents/<PATH>?ref=abc1234');
  });

  /** Without tools, listing commands would invite it to claim it had run them. */
  it('lists no commands when it cannot investigate', () => {
    const p = buildClaudePrompt(input({ canInvestigate: false }));
    expect(p).not.toContain('--- COMMANDS ---');
    expect(p).toContain('no tools');
  });
});

describe('buildClaudePrompt', () => {
  it('includes the verified facts the model must not invent', () => {
    const p = buildClaudePrompt(input());
    expect(p).toContain('Repository: acme/rocket');
    expect(p).toContain('pull request #42 — speed up export');
    expect(p).toContain('Merge direction: into main');
    expect(p).toContain('Workflow file: ci.yml');
    expect(p).toContain('Failed job: java / test (ubuntu, 21)');
    expect(p).toContain('Failed step: Run tests');
    expect(p).toContain('Commit: abc1234');
  });

  it('describes a flow failure as a flow, not a pull request', () => {
    const p = buildClaudePrompt(
      input({
        origin: {
          kind: 'flow',
          flowId: 'f1',
          flowName: 'java-cron',
          runUrl: 'https://github.com/acme/rocket/actions/runs/9',
          runNumber: 42,
          event: 'schedule',
        },
      }),
    );
    expect(p).toContain('flow "java-cron"');
    expect(p).toContain('Triggered by: schedule');
    expect(p).not.toContain('pull request #');
  });

  it('lists the failing annotations with file and line', () => {
    const p = buildClaudePrompt(input());
    expect(p).toContain('- src/Foo.test.ts:42: Foo > adds — expected 1 to equal 2');
  });

  it('only passes failure-level annotations, not warnings', () => {
    const p = buildClaudePrompt(
      input({
        annotations: [annotation(), annotation({ annotation_level: 'warning', message: 'deprecated' })],
      }),
    );
    expect(p).not.toContain('deprecated');
  });

  /** Says so rather than leaving a blank the model might fill with a guess. */
  it('states explicitly when there are no annotations', () => {
    const p = buildClaudePrompt(input({ annotations: [] }));
    expect(p).toContain('no failure annotations');
  });

  it('omits absent optional facts rather than printing empties', () => {
    const p = buildClaudePrompt(input({ workflowFile: null, failedStep: null }));
    expect(p).not.toContain('Workflow file:');
    expect(p).not.toContain('Failed step:');
    expect(p).not.toContain('null');
  });

  /** The bridge appends the fetched log to whatever this returns. */
  it('ends with the log section header so the caller can append the log', () => {
    const p = buildClaudePrompt(input({ log: '' }));
    expect(p.trimEnd().endsWith('(start here, then dig deeper) ---')).toBe(true);
  });
});

describe('trimLog', () => {
  it('leaves a short log alone', () => {
    expect(trimLog('short', 100)).toBe('short');
  });

  /**
   * Both ends are kept: the tail holds the failure, the head holds what was being
   * built. Cutting only the tail would lose the context that makes a write-up
   * readable.
   */
  it('keeps the head and the tail of a long log', () => {
    const log = `HEAD${'x'.repeat(5000)}TAIL`;
    const trimmed = trimLog(log, 1000);
    expect(trimmed.length).toBeLessThan(log.length);
    expect(trimmed.startsWith('HEAD')).toBe(true);
    expect(trimmed.endsWith('TAIL')).toBe(true);
    expect(trimmed).toMatch(/omitted from the middle/);
  });
});

describe('parseClaudeAnalysis', () => {
  it('splits a well-formed reply', () => {
    const reply = `${PROBLEM_MARKER}\nThe export test broke.\n\n${SOLUTION_MARKER}\nFix the rounding.`;
    expect(parseClaudeAnalysis(reply)).toEqual({
      problem: 'The export test broke.',
      solution: 'Fix the rounding.',
    });
  });

  /** Models add preambles despite instructions; a slow call shouldn't be wasted. */
  it('tolerates a preamble before the first marker', () => {
    const reply = `Sure, here you go:\n\n${PROBLEM_MARKER}\nBroke.\n${SOLUTION_MARKER}\nFix.`;
    expect(parseClaudeAnalysis(reply)).toEqual({ problem: 'Broke.', solution: 'Fix.' });
  });

  it('accepts a reply with only a problem section', () => {
    expect(parseClaudeAnalysis(`${PROBLEM_MARKER}\nBroke.`)).toEqual({
      problem: 'Broke.',
      solution: '',
    });
  });

  it('accepts a reply with only a solution section', () => {
    expect(parseClaudeAnalysis(`${SOLUTION_MARKER}\nFix.`)).toEqual({
      problem: '',
      solution: 'Fix.',
    });
  });

  it('keeps multi-paragraph Markdown intact', () => {
    const problem = 'Line one.\n\n- a bullet\n- another\n\nWith `code`.';
    const parsed = parseClaudeAnalysis(`${PROBLEM_MARKER}\n${problem}\n${SOLUTION_MARKER}\nFix.`);
    expect(parsed?.problem).toBe(problem);
  });

  it('rejects a reply with no markers at all', () => {
    expect(parseClaudeAnalysis('I could not determine the failure.')).toBeNull();
  });

  it('rejects markers with nothing between them', () => {
    expect(parseClaudeAnalysis(`${PROBLEM_MARKER}\n   \n${SOLUTION_MARKER}\n  `)).toBeNull();
  });
});

describe('CLAUDE_QUICK_BRIEF', () => {
  /**
   * The quick pass earns its button by being fast. Without an explicit budget the model
   * treats it as an ordinary triage and takes as long as the deep one, at which point
   * there is no reason to have two.
   */
  it('states the one-minute budget', () => {
    expect(CLAUDE_QUICK_BRIEF).toMatch(/about one minute/i);
  });

  it('forbids investigating, fetching, or asking for more', () => {
    expect(CLAUDE_QUICK_BRIEF).toMatch(/do not investigate/i);
    expect(CLAUDE_QUICK_BRIEF).toMatch(/do not fetch/i);
    expect(CLAUDE_QUICK_BRIEF).toMatch(/do not ask for more/i);
  });

  /** It has no tools, so it must not be told to run commands it cannot run. */
  it('names no gh commands', () => {
    expect(CLAUDE_QUICK_BRIEF).not.toMatch(/gh run|gh pr|gh api/);
  });

  /**
   * "I cannot tell" is a legitimate one-minute answer — the deep pass exists for the
   * rest. Refusing it here would push the model into guessing.
   */
  it('allows admitting the log does not say, unlike the deep brief', () => {
    expect(CLAUDE_QUICK_BRIEF).toMatch(/does not say what broke/i);
    expect(CLAUDE_INVESTIGATION_BRIEF).toMatch(/not enough evidence/i);
  });
});

describe('buildClaudePrompt — depth', () => {
  it('uses the quick brief and lists no commands for a quick read', () => {
    const p = buildClaudePrompt(input({ depth: 'quick' }));
    expect(p).toContain('about one minute');
    expect(p).not.toContain('--- COMMANDS ---');
  });

  it('uses the investigation brief for a deep read', () => {
    const p = buildClaudePrompt(input({ depth: 'deep' }));
    expect(p).toContain('--- COMMANDS ---');
    expect(p).not.toContain('about one minute');
  });

  /** Even with tools available, quick must not be handed the investigation brief. */
  it('keeps quick toolless regardless of canInvestigate', () => {
    const p = buildClaudePrompt(input({ depth: 'quick', canInvestigate: true }));
    expect(p).not.toContain('gh run view');
  });
});

describe('splitIntoSentenceLines', () => {
  it('puts each sentence on its own line', () => {
    expect(splitIntoSentenceLines('The build broke. A test failed. Fix the import.')).toBe(
      'The build broke.\nA test failed.\nFix the import.',
    );
  });

  /**
   * Version numbers and abbreviations are the reason this can't just split on ". " —
   * getting it wrong shatters a sentence mid-clause, which reads worse than not
   * splitting at all.
   */
  it('does not split on abbreviations or version numbers', () => {
    expect(splitIntoSentenceLines('Node v20.11.1 is required, e.g. via nvm.')).toBe(
      'Node v20.11.1 is required, e.g. via nvm.',
    );
  });

  it('keeps blank lines between paragraphs', () => {
    expect(splitIntoSentenceLines('One. Two.\n\nThree.')).toBe('One.\nTwo.\n\nThree.');
  });

  /** Bullets and fenced code are already line-structured; resplitting them mangles them. */
  it('leaves list items and code fences alone', () => {
    const text = '- a. b\n- c';
    expect(splitIntoSentenceLines(text)).toBe(text);
  });

  it('handles question and exclamation marks', () => {
    expect(splitIntoSentenceLines('Is it flaky? Probably not.')).toBe(
      'Is it flaky?\nProbably not.',
    );
  });

  it('leaves a single sentence untouched', () => {
    expect(splitIntoSentenceLines('Just one thing.')).toBe('Just one thing.');
  });
});

describe('buildClaudePrompt — no log', () => {
  /**
   * A check run whose details link isn't an Actions job has no job log to fetch at all,
   * so `jobId` is null and nothing can be appended. Ending on a bare log header invites
   * the model either to blame itself for not looking or to describe a log it never saw.
   */
  it('says there is no log instead of leaving an empty section', () => {
    const p = buildClaudePrompt(input({ depth: 'quick', log: '', hasLog: false }));
    expect(p).toMatch(/No log could be read/i);
    expect(p).not.toContain('LOG OF THE FAILED STEP(S) ---\n');
  });

  it('tells the model not to invent log contents it was not given', () => {
    const p = buildClaudePrompt(input({ depth: 'quick', log: '', hasLog: false }));
    expect(p).toMatch(/do not describe log contents you were not given/i);
  });

  /** The annotations are then the only evidence, so they must still be there. */
  it('still carries the reported failures', () => {
    const p = buildClaudePrompt(input({ depth: 'quick', log: '', hasLog: false }));
    expect(p).toContain('- src/Foo.test.ts:42: Foo > adds — expected 1 to equal 2');
  });

  /** hasLog omitted means "a log is coming" — the main process appends it. */
  it('keeps the appendable log header when hasLog is not set', () => {
    const p = buildClaudePrompt(input({ depth: 'deep', log: '' }));
    expect(p.trimEnd().endsWith('(start here, then dig deeper) ---')).toBe(true);
    expect(p).not.toMatch(/No log could be read/i);
  });
});

describe('CLAUDE_LOG_BRIEF', () => {
  /**
   * The failure mode this guards against: asked to "make the log readable", a model
   * summarises it instead, and a summary is not a log — the reader loses the ability to
   * see the actual output, which is the whole point of opening a log.
   */
  it('asks for the log back, not a report about it', () => {
    expect(CLAUDE_LOG_BRIEF).toMatch(/the \*\*log itself\*\*/i);
    expect(CLAUDE_LOG_BRIEF).toMatch(/do not paraphrase/i);
  });

  it('asks for the decisive lines first and the noise cut', () => {
    expect(CLAUDE_LOG_BRIEF).toMatch(/lead with what failed/i);
    expect(CLAUDE_LOG_BRIEF).toMatch(/cut the noise/i);
  });

  /** Over-annotating defeats it: a note on every line is no easier to read than none. */
  it('tells it to annotate sparingly', () => {
    expect(CLAUDE_LOG_BRIEF).toMatch(/annotate sparingly/i);
    expect(CLAUDE_LOG_BRIEF).toMatch(/every line is annotated/i);
  });

  it('forbids inventing log content', () => {
    expect(CLAUDE_LOG_BRIEF).toMatch(/never invent/i);
    expect(CLAUDE_LOG_BRIEF).toMatch(/verbatim/i);
  });

  it('asks for the Markdown the viewer renders', () => {
    expect(CLAUDE_LOG_BRIEF).toMatch(/fenced code blocks/i);
    expect(CLAUDE_LOG_BRIEF).toMatch(/italics/i);
  });

  /** Colour is done locally; a model call for it would be slow and non-deterministic. */
  it('does not ask the model to colour anything', () => {
    expect(CLAUDE_LOG_BRIEF).not.toMatch(/colou?r/i);
  });

  /** It returns a document, so the marker contract must not be imposed on it. */
  it('does not use the problem/solution markers', () => {
    expect(CLAUDE_LOG_BRIEF).not.toContain(PROBLEM_MARKER);
    expect(CLAUDE_LOG_BRIEF).not.toContain(SOLUTION_MARKER);
  });

  it('is selected by the log task and gets no investigation commands', () => {
    const p = buildClaudePrompt(input({ depth: 'log' }));
    expect(p).toMatch(/the \*\*log itself\*\*/i);
    expect(p).not.toContain('--- COMMANDS ---');
    expect(p).toContain('--- LOG TO REWRITE ---');
  });
});

describe('buildClaudePrompt — settings', () => {
  /** Additive, so standing context can't break the parse the way an override could. */
  it('appends the user’s extra instructions after the brief', () => {
    const p = buildClaudePrompt(input({ extraInstructions: 'Windows tests are flaky.' }));
    expect(p).toContain('--- ADDITIONAL INSTRUCTIONS FROM THE USER ---');
    expect(p).toContain('Windows tests are flaky.');
    // The brief is still there — this adds to it rather than replacing it.
    expect(p).toMatch(/you have tools/i);
  });

  it('adds no section when there are no extra instructions', () => {
    expect(buildClaudePrompt(input({ extraInstructions: '   ' }))).not.toContain(
      'ADDITIONAL INSTRUCTIONS',
    );
  });

  it('replaces the built-in brief with a custom prompt', () => {
    const p = buildClaudePrompt(input({ promptOverride: 'Just tell me the failing test.' }));
    expect(p).toContain('Just tell me the failing test.');
    expect(p).not.toMatch(/you have tools/i);
  });

  /**
   * The load-bearing part of allowing an override: the markers are restated after it, so a
   * well-meaning custom prompt cannot produce a reply the app fails to parse.
   */
  it('still demands the output contract under a custom prompt', () => {
    const p = buildClaudePrompt(input({ promptOverride: 'Be brief.' }));
    expect(p).toContain(PROBLEM_MARKER);
    expect(p).toContain(SOLUTION_MARKER);
  });

  /** The log task returns a document, so there is no marker contract to restate. */
  it('does not impose the markers on a custom log prompt', () => {
    const p = buildClaudePrompt(input({ depth: 'log', promptOverride: 'Trim the log.' }));
    expect(p).toContain('Trim the log.');
    expect(p).not.toContain(PROBLEM_MARKER);
  });

  it('keeps the facts and the log with a custom prompt', () => {
    const p = buildClaudePrompt(input({ promptOverride: 'Be brief.' }));
    expect(p).toContain('Repository: acme/rocket');
    expect(p).toContain('- src/Foo.test.ts:42: Foo > adds — expected 1 to equal 2');
  });

  it('treats a whitespace-only override as absent', () => {
    expect(buildClaudePrompt(input({ promptOverride: '  \n ' }))).toMatch(/you have tools/i);
  });
});

describe('CLAUDE_RESUME_PROMPT', () => {
  /**
   * The bug this exists to prevent, seen in a real continuation: told to "spend what is
   * left on reaching an answer", the model wrapped up and declined to assign a likelihood
   * because it had "run out of time before reading that patch". Continuing must mean
   * continuing the investigation — an unread diff is not an unknowable one.
   */
  it('tells it to resume investigating, not to conclude', () => {
    expect(CLAUDE_RESUME_PROMPT).toMatch(/continue the investigation from exactly where it stopped/i);
    expect(CLAUDE_RESUME_PROMPT).toMatch(/do not conclude early/i);
    expect(CLAUDE_RESUME_PROMPT).toMatch(/an unread diff is not an unknowable one/i);
  });

  it('says the budget is fresh, so nothing is being rationed', () => {
    expect(CLAUDE_RESUME_PROMPT).toMatch(/full fresh budget/i);
    expect(CLAUDE_RESUME_PROMPT).toMatch(/interrupted by a time limit — you were not asked to wrap up/i);
  });

  /** …while still not paying twice for what it already has. */
  it('forbids repeating work it has already done', () => {
    expect(CLAUDE_RESUME_PROMPT).toMatch(/do not repeat work/i);
    expect(CLAUDE_RESUME_PROMPT).toMatch(/do not start over/i);
  });

  /** If it runs short again, the report has to be about evidence, not about the clock. */
  it('asks for what is outstanding rather than an excuse about time', () => {
    expect(CLAUDE_RESUME_PROMPT).toMatch(/what is still outstanding and what it would settle/i);
    expect(CLAUDE_RESUME_PROMPT).toMatch(/not that you lacked time/i);
  });

  /** Short on purpose: --resume replays the conversation, so re-sending the brief is waste. */
  it('is far shorter than a full prompt', () => {
    expect(CLAUDE_RESUME_PROMPT.length).toBeLessThan(1200);
  });
});

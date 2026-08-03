import { describe, expect, it } from 'vitest';
import {
  buildFailureReport,
  failureFingerprint,
  joinReports,
  mergeSignatures,
  normalizeFailureText,
  blameVerdict,
  signatureFromAnnotations,
  TEAMS_LOG_LINES,
  type FailureReportInput,
} from '../lib/failureReport';
import type { Annotation } from '../api/types';

function annotation(over: Partial<Annotation> = {}): Annotation {
  return {
    path: 'src/Foo.test.ts',
    start_line: 42,
    end_line: 42,
    annotation_level: 'failure',
    message: 'expected 1 to equal 2',
    title: 'Foo > adds numbers',
    raw_details: null,
    ...over,
  };
}

function reportInput(over: Partial<FailureReportInput> = {}): FailureReportInput {
  return {
    jobName: 'java / test (ubuntu-latest, 21)',
    failedStep: 'Run tests',
    origin: {
      kind: 'pr',
      prNumber: 37977,
      prTitle: 'visual tests refactoring',
      prUrl: 'https://github.com/o/r/pull/37977',
      prState: 'open',
      baseRef: 'main',
    },
    headRef: 'visualtests-refactoring',
    headSha: 'abc1234def5678',
    workflowFile: 'ci.yml',
    runUrl: 'https://github.com/o/r/actions/runs/1001',
    runNumber: 412,
    runAttempt: 2,
    jobUrl: 'https://github.com/o/r/actions/runs/1001/job/5',
    completedAt: '2026-07-31T10:12:00Z',
    annotations: [annotation()],
    logTail: ['line one', 'line two'],
    fingerprint: 'a1b2c3d4',
    format: 'github',
    appVersion: '1.2.0',
    generatedAt: new Date('2026-07-31T12:00:00Z'),
    ...over,
  };
}

describe('normalizeFailureText', () => {
  it('strips timestamps, long hex and long numbers', () => {
    expect(normalizeFailureText('2026-07-31T10:12:00.123Z failed')).toBe('<ts> failed');
    expect(normalizeFailureText('commit abc1234def')).toBe('commit <hex>');
    expect(normalizeFailureText('run 123456 done')).toBe('run <n> done');
  });

  it('strips temp paths on both platforms', () => {
    expect(normalizeFailureText('wrote /tmp/build-xyz/out.txt')).toBe('wrote <tmp>');
    expect(normalizeFailureText('wrote C:\\Temp\\abc\\out.txt')).toBe('wrote <tmp>');
  });

  /** Line numbers are stable within a commit and distinguish two failures. */
  it('keeps short numbers such as line numbers', () => {
    expect(normalizeFailureText('Foo.test.ts:42 expected 1 to equal 2')).toBe(
      'foo.test.ts:42 expected 1 to equal 2',
    );
  });

  it('collapses whitespace and case', () => {
    expect(normalizeFailureText('  Expected\n   TWO  things ')).toBe('expected two things');
  });
});

describe('failureFingerprint', () => {
  const sig = signatureFromAnnotations('test (ubuntu, 21)', 'Run tests', [annotation()]);

  it('is stable for the same failure', () => {
    expect(failureFingerprint(sig)).toBe(failureFingerprint(sig));
  });

  /** The whole point: a rerun of an unchanged break must fingerprint identically. */
  it('ignores timestamps and run ids that differ between attempts', () => {
    const first = signatureFromAnnotations('test', 'Run tests', [
      annotation({ message: 'timed out at 2026-07-31T10:12:00Z after 5000ms (run 987654)' }),
    ]);
    const second = signatureFromAnnotations('test', 'Run tests', [
      annotation({ message: 'timed out at 2026-07-31T18:44:03Z after 5000ms (run 123456)' }),
    ]);
    expect(failureFingerprint(first)).toBe(failureFingerprint(second));
  });

  it('differs when a different test fails', () => {
    const other = signatureFromAnnotations('test (ubuntu, 21)', 'Run tests', [
      annotation({ path: 'src/Bar.test.ts', message: 'timeout' }),
    ]);
    expect(failureFingerprint(sig)).not.toBe(failureFingerprint(other));
  });

  it('differs when a different job fails on the same message', () => {
    const other = signatureFromAnnotations('test (windows, 17)', 'Run tests', [annotation()]);
    expect(failureFingerprint(sig)).not.toBe(failureFingerprint(other));
  });

  it('is order-independent across jobs and messages', () => {
    const a = mergeSignatures([
      signatureFromAnnotations('job-a', 'step', [annotation({ message: 'one' })]),
      signatureFromAnnotations('job-b', 'step', [annotation({ message: 'two' })]),
    ]);
    const b = mergeSignatures([
      signatureFromAnnotations('job-b', 'step', [annotation({ message: 'two' })]),
      signatureFromAnnotations('job-a', 'step', [annotation({ message: 'one' })]),
    ]);
    expect(failureFingerprint(a)).toBe(failureFingerprint(b));
  });

  it('only considers failure-level annotations', () => {
    const withWarning = signatureFromAnnotations('test (ubuntu, 21)', 'Run tests', [
      annotation(),
      annotation({ annotation_level: 'warning', message: 'deprecated API' }),
    ]);
    expect(failureFingerprint(withWarning)).toBe(failureFingerprint(sig));
  });

  /** Null means "unknown", which callers must not read as "same as last time". */
  it('returns null when there is nothing to fingerprint', () => {
    expect(failureFingerprint({ jobs: [], messages: [] })).toBeNull();
  });

  it('still fingerprints a job with no annotations at all', () => {
    const bare = signatureFromAnnotations('test', 'Run tests', []);
    expect(failureFingerprint(bare)).toBeTruthy();
    // …and distinguishes it from a different job that also has none.
    expect(failureFingerprint(bare)).not.toBe(
      failureFingerprint(signatureFromAnnotations('build', 'Compile', [])),
    );
  });
});

describe('buildFailureReport', () => {
  it('leads with the job, PR, workflow and failed step', () => {
    const md = buildFailureReport(reportInput());
    expect(md).toContain('### `java / test (ubuntu-latest, 21)` failed');
    expect(md).toContain('[#37977 visual tests refactoring](https://github.com/o/r/pull/37977)');
    expect(md).toContain('`visualtests-refactoring` → `main`');
    expect(md).toContain('`ci.yml`');
    expect(md).toContain('run #412, attempt 2');
    expect(md).toContain('**Failed step** `Run tests`');
    expect(md).toContain('commit `abc1234`'); // short sha
    expect(md).toContain('finished 2026-07-31 10:12 UTC');
  });

  it('lists the failed tests with file, line and message', () => {
    const md = buildFailureReport(reportInput());
    expect(md).toContain('#### Failed tests (1)');
    expect(md).toContain('`src/Foo.test.ts:42`');
    expect(md).toContain('Foo > adds numbers — expected 1 to equal 2');
  });

  it('says so explicitly when there are no annotations', () => {
    const md = buildFailureReport(reportInput({ annotations: [] }));
    expect(md).toContain('No failure annotations were reported');
  });

  it('separates warnings from failures and caps the list', () => {
    const warnings = Array.from({ length: 12 }, (_, i) =>
      annotation({ annotation_level: 'warning', message: `warn ${i}`, title: null }),
    );
    const md = buildFailureReport(reportInput({ annotations: [annotation(), ...warnings] }));
    expect(md).toContain('#### Failed tests (1)');
    expect(md).toContain('#### Warnings (12)');
    expect(md).toContain('…and 2 more.');
  });

  it('collapses the log behind <details> for GitHub', () => {
    const md = buildFailureReport(reportInput({ format: 'github' }));
    expect(md).toContain('<details><summary>Log tail — step "Run tests" (last 2 lines)</summary>');
    expect(md).toContain('</details>');
    expect(md).toContain('line one');
  });

  /** Teams renders no <details>, so the log must be emitted flat there. */
  it('emits the log flat for Teams', () => {
    const md = buildFailureReport(reportInput({ format: 'teams' }));
    expect(md).not.toContain('<details>');
    expect(md).toContain('**Log tail — step "Run tests" (last 2 lines)**');
    expect(md).toContain('line one');
  });

  it('omits the log block entirely when there is no tail', () => {
    const md = buildFailureReport(reportInput({ logTail: [] }));
    expect(md).not.toContain('Log tail');
    expect(md).not.toContain('```');
  });

  it('footers the version and the fingerprint that ties reports together', () => {
    const md = buildFailureReport(reportInput());
    expect(md).toContain('_Job Monitor v1.2.0 · generated 2026-07-31 12:00 UTC · fingerprint `a1b2c3d4`_');
  });

  it('degrades gracefully when the run and job links are unknown', () => {
    const md = buildFailureReport(
      reportInput({
        workflowFile: null, runUrl: null, runNumber: null, runAttempt: null,
        jobUrl: null, failedStep: null, completedAt: null, fingerprint: null,
      }),
    );
    expect(md).toContain('### `java / test (ubuntu-latest, 21)` failed');
    expect(md).not.toContain('fingerprint');
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('null');
  });

  it('marks a merged PR as merged', () => {
    const md = buildFailureReport(
      reportInput({
        origin: {
          kind: 'pr',
          prNumber: 1,
          prTitle: 't',
          prUrl: 'u',
          prState: 'merged',
          baseRef: 'main',
        },
      }),
    );
    expect(md).toContain('· merged');
  });

  /** A flow has no branch pair or open/merged state — it has a trigger. */
  it('describes a flow failure by its flow name and trigger, not as a PR', () => {
    const md = buildFailureReport(
      reportInput({
        origin: {
          kind: 'flow',
          flowId: 'flow-java-cron',
          flowName: 'java-cron',
          runUrl: 'https://github.com/o/r/actions/runs/9',
          runNumber: 42,
          event: 'schedule',
        },
        headRef: 'main',
      }),
    );
    expect(md).toContain('**Flow** java-cron · `main` · schedule');
    expect(md).not.toContain('**PR**');
    expect(md).not.toContain('→');
  });

  it('does not repeat "attempt" for a first attempt', () => {
    const md = buildFailureReport(reportInput({ runAttempt: 1 }));
    expect(md).toContain('run #412');
    expect(md).not.toContain('attempt 1');
  });
});

describe('buildFailureReport — Claude analysis', () => {
  const analysis = { problem: 'The PDF comparison drifted by one pixel.', solution: 'Widen the tolerance in ExportToPdfTests.' };

  /** A human skimming this in Teams should understand the failure before metadata. */
  it('leads with the problem statement, above the PR line', () => {
    const md = buildFailureReport(reportInput({ analysis }));
    const problemAt = md.indexOf('The PDF comparison drifted');
    const prAt = md.indexOf('**PR**');
    expect(problemAt).toBeGreaterThan(-1);
    expect(problemAt).toBeLessThan(prAt);
  });

  /** A suggestion, not a fact — folded away, and last. */
  it('puts the suggested fix last, collapsed, for GitHub', () => {
    const md = buildFailureReport(reportInput({ analysis, format: 'github' }));
    expect(md).toContain('<details><summary>Suggested fix (generated — review before trusting)</summary>');
    expect(md.indexOf('Widen the tolerance')).toBeGreaterThan(md.indexOf('#### Failed tests'));
    expect(md.indexOf('Widen the tolerance')).toBeGreaterThan(md.indexOf('Log tail'));
  });

  it('flattens the suggested fix for Teams, which renders no <details>', () => {
    const md = buildFailureReport(reportInput({ analysis, format: 'teams' }));
    expect(md).toContain('**Suggested fix (generated — review before trusting)**');
    expect(md).not.toContain('<details><summary>Suggested fix');
    expect(md).toContain('Widen the tolerance');
  });

  it('labels the suggestion as generated, so it is never mistaken for a finding', () => {
    const md = buildFailureReport(reportInput({ analysis }));
    expect(md).toMatch(/generated — review before trusting/);
  });

  it('is unchanged when no analysis was run', () => {
    const md = buildFailureReport(reportInput());
    expect(md).not.toContain('Suggested fix');
    expect(md.startsWith('### `java / test (ubuntu-latest, 21)` failed')).toBe(true);
  });

  it('includes each half independently', () => {
    const onlyProblem = buildFailureReport(reportInput({ analysis: { problem: 'Broke.', solution: '' } }));
    expect(onlyProblem).toContain('Broke.');
    expect(onlyProblem).not.toContain('Suggested fix');

    const onlySolution = buildFailureReport(reportInput({ analysis: { problem: '', solution: 'Fix.' } }));
    expect(onlySolution).toContain('Suggested fix');
    expect(onlySolution).toContain('Fix.');
  });
});

describe('joinReports', () => {
  it('separates documents with a horizontal rule', () => {
    expect(joinReports(['a', 'b'])).toBe('a\n\n---\n\nb');
  });

  it('leaves a single report untouched', () => {
    expect(joinReports(['only'])).toBe('only');
  });
});

describe('the Teams log block', () => {
  const longLog = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);

  /**
   * GitHub folds eighty lines away behind a summary; a chat message cannot. Left at full
   * length, the log buries the two lines that matter and pushes the metadata and the
   * suggested fix off the screen.
   */
  it('shows only the last few lines for Teams', () => {
    const md = buildFailureReport(reportInput({ format: 'teams', logTail: longLog }));
    expect(md).toContain(`line ${longLog.length}`);
    expect(md).not.toContain('line 1\n');
    expect(md.match(/^line \d+$/gm)?.length).toBe(TEAMS_LOG_LINES);
  });

  /** GitHub keeps the whole thing — it has somewhere to put it. */
  it('keeps the whole tail for GitHub', () => {
    const md = buildFailureReport(reportInput({ format: 'github', logTail: longLog }));
    expect(md.match(/^line \d+$/gm)?.length).toBe(longLog.length);
  });

  /** Cut silently, a reader can't tell a short log from a truncated one. */
  it('says how many lines it dropped, and links to the rest', () => {
    const md = buildFailureReport(reportInput({ format: 'teams', logTail: longLog, jobUrl: 'https://example.com/job/1' }));
    expect(md).toContain(`${longLog.length - TEAMS_LOG_LINES} earlier lines omitted`);
    expect(md).toContain('https://example.com/job/1');
  });

  it('adds no note when nothing was dropped', () => {
    const md = buildFailureReport(reportInput({ format: 'teams', logTail: ['only line'] }));
    expect(md).not.toMatch(/omitted/);
  });

  it('says "line" rather than "lines" when it dropped one', () => {
    const md = buildFailureReport(reportInput({
      format: 'teams',
      logTail: Array.from({ length: TEAMS_LOG_LINES + 1 }, (_, i) => `line ${i + 1}`),
    }));
    expect(md).toContain('1 earlier line omitted');
  });

  /** The count in the heading has to describe what is actually shown. */
  it('counts what it shows, not what it was given', () => {
    expect(buildFailureReport(reportInput({ format: 'teams', logTail: longLog }))).toContain(
      `(last ${TEAMS_LOG_LINES} lines)`,
    );
  });
});

describe('blameVerdict', () => {
  const doc = [
    '### Summary',
    '',
    '**Who:** @jdoe (`a1b2c3d4`) — 70% confidence',
    '**Kind:** commit',
    '',
    '### Boundary',
    '',
    'Last good: run #417.',
  ].join('\n');

  /**
   * Only the Summary: that block is written to be read at a glance, while the boundary and
   * the suspect table are the working that produced it. A bug report wants the conclusion.
   */
  it('takes the summary and leaves the working behind', () => {
    const verdict = blameVerdict(doc);
    expect(verdict).toContain('@jdoe');
    expect(verdict).toContain('**Kind:** commit');
    expect(verdict).not.toContain('Boundary');
    expect(verdict).not.toContain('run #417');
  });

  /** The report supplies its own heading, so the section's own would double up. */
  it('drops the Summary heading itself', () => {
    expect(blameVerdict(doc).startsWith('**Who:**')).toBe(true);
  });

  /** A verdict in an unexpected shape still beats silently adding nothing. */
  it('falls back to the whole document when there is no Summary section', () => {
    expect(blameVerdict('Just some prose about a commit.')).toBe('Just some prose about a commit.');
  });

  it('copes with a summary that runs to the end', () => {
    expect(blameVerdict('## Summary\n\n**Kind:** flaky test')).toBe('**Kind:** flaky test');
  });
});

describe('the verdict in a report', () => {
  /** Naming a person is the most actionable line there is, so it goes above the problem. */
  it('puts the verdict above the problem statement', () => {
    const md = buildFailureReport(
      reportInput({
        analysis: { problem: 'The export test broke.', solution: 'Fix it.' },
        blame: '**Who:** @jdoe (`a1b2c3d4`) — 70% confidence',
      }),
    );
    expect(md).toContain('**Who broke it**');
    expect(md.indexOf('@jdoe')).toBeLessThan(md.indexOf('The export test broke.'));
  });

  /** Never by default: a bug report that names someone must be a deliberate act. */
  it('omits the section entirely when no verdict was added', () => {
    expect(buildFailureReport(reportInput())).not.toContain('Who broke it');
    expect(buildFailureReport(reportInput({ blame: '   ' }))).not.toContain('Who broke it');
  });

  it('works with a verdict and no analysis', () => {
    const md = buildFailureReport(reportInput({ blame: '**Kind:** infrastructure' }));
    expect(md).toContain('**Kind:** infrastructure');
  });
});

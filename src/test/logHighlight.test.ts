import { describe, expect, it } from 'vitest';
import {
  hasRecognisableStructure,
  highlightLog,
  highlightLogLine,
  stripAnsi,
} from '../lib/logHighlight';

const ESC = '\x1b';

describe('stripAnsi', () => {
  it('removes SGR colour sequences', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red');
  });

  it('leaves text with no escapes alone', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  /** Cursor moves and erases appear in progress-bar output. */
  it('removes non-colour sequences too', () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gdownloading`)).toBe('downloading');
  });
});

describe('highlightLogLine', () => {
  it('splits off the runner timestamp', () => {
    const line = highlightLogLine('2026-07-31T14:11:02.1234567Z Compiling sources...');
    expect(line.timestamp).toBe('2026-07-31T14:11:02.1234567Z');
    expect(line.text).toBe('Compiling sources...');
  });

  it('treats a line with no timestamp as all text', () => {
    expect(highlightLogLine('no timestamp here').timestamp).toBeNull();
  });

  /**
   * The runner's own annotations are authoritative, so they outrank anything inferred
   * from the wording.
   */
  it('reads workflow commands and drops the marker', () => {
    expect(highlightLogLine('##[error]Process completed with exit code 1.')).toMatchObject({
      kind: 'error',
      text: 'Process completed with exit code 1.',
    });
    expect(highlightLogLine('##[group]Run ./gradlew test').kind).toBe('group');
    expect(highlightLogLine('##[endgroup]').kind).toBe('endgroup');
    expect(highlightLogLine('##[warning]Node 16 is deprecated').kind).toBe('warning');
  });

  /** Dropping an unknown marker would silently lose text from the log. */
  it('keeps an unrecognised marker visible as plain text', () => {
    const line = highlightLogLine('##[debug]Evaluating condition');
    expect(line.kind).toBe('plain');
    expect(line.text).toBe('##[debug]Evaluating condition');
  });

  it('recognises a failing test line', () => {
    expect(highlightLogLine('ExportToPdfTests > exportsInvoice() FAILED').kind).toBe('failure');
    expect(highlightLogLine('    org.opentest4j.AssertionFailedError: nope').kind).toBe('failure');
    expect(highlightLogLine('Tests run: 12, Failures: 1, Errors: 0').kind).toBe('failure');
  });

  /** `dotnet test` writes "  Failed Namespace.Test [12 ms]", not "FAILED". */
  it('recognises a .NET test failure line', () => {
    expect(highlightLogLine('  Failed PdfParsingTests.ReadsTable [12 ms]').kind).toBe('failure');
    expect(highlightLogLine('Failed!  - Failed: 2, Passed: 40').kind).toBe('failure');
  });

  /** Anchored, so prose that merely contains the word stays plain. */
  it('does not treat the word "failed" mid-sentence as a failure line', () => {
    expect(highlightLogLine('Retrying because the upload failed earlier').kind).toBe('plain');
  });

  it('recognises a stack frame', () => {
    expect(highlightLogLine('    at com.foo.Bar.run(Bar.java:88)').kind).toBe('stack');
    expect(highlightLogLine('  File "app.py", line 3').kind).toBe('stack');
    expect(highlightLogLine('    ... 24 more').kind).toBe('stack');
  });

  it('recognises the command a step ran', () => {
    expect(highlightLogLine('+ ./gradlew :app:test').kind).toBe('command');
    expect(highlightLogLine('$ npm ci').kind).toBe('command');
  });

  it('recognises build-tool section headers', () => {
    expect(highlightLogLine('> Task :app:compileJava').kind).toBe('section');
  });

  it('recognises success lines', () => {
    expect(highlightLogLine('BUILD SUCCESSFUL in 20s').kind).toBe('success');
  });

  /**
   * The load-bearing restraint. Colouring ordinary prose that merely contains "error"
   * teaches the reader to ignore the colour, which is worse than no colour at all.
   */
  it('does not colour prose that merely mentions failure words', () => {
    for (const text of [
      'Configuring error handling middleware',
      'Downloading failure-analysis-plugin-1.2.jar',
      'See docs/errors.md for details',
    ]) {
      expect(highlightLogLine(text).kind).toBe('plain');
    }
  });

  it('strips ANSI before classifying, so colour codes cannot hide a match', () => {
    expect(highlightLogLine(`${ESC}[31mBuildTest > run() FAILED${ESC}[0m`).kind).toBe('failure');
  });

  /** A stack frame inside a failure block is a frame, not another failure headline. */
  it('prefers the stack-frame reading for an indented frame', () => {
    expect(highlightLogLine('    at Assert.fail(Assert.java:1)').kind).toBe('stack');
  });
});

describe('highlightLog', () => {
  const log = [
    '2026-07-31T14:11:00.0000000Z ##[group]Run ./gradlew test',
    '2026-07-31T14:11:01.0000000Z + ./gradlew test',
    '2026-07-31T14:11:02.0000000Z > Task :app:test',
    '2026-07-31T14:11:03.0000000Z ExportToPdfTests > exportsInvoice() FAILED',
    '2026-07-31T14:11:03.5000000Z     at Assert.fail(Assert.java:1)',
    '2026-07-31T14:11:04.0000000Z ##[error]Process completed with exit code 1.',
  ].join('\n');

  it('classifies every line of a realistic log', () => {
    expect(highlightLog(log).map((l) => l.kind)).toEqual([
      'group',
      'command',
      'section',
      'failure',
      'stack',
      'error',
    ]);
  });

  it('preserves blank lines rather than dropping them', () => {
    expect(highlightLog('a\n\nb')).toHaveLength(3);
  });

  it('handles CRLF logs', () => {
    expect(highlightLog('a\r\nb')).toHaveLength(2);
    expect(highlightLog('a\r\nb')[0].text).toBe('a');
  });
});

describe('hasRecognisableStructure', () => {
  /** Uniform colour is the same as none, and costs the reader's trust in it. */
  it('is false for a log with nothing to colour', () => {
    expect(hasRecognisableStructure(highlightLog('just\nsome\nlines'))).toBe(false);
  });

  it('is true once anything is recognised', () => {
    expect(hasRecognisableStructure(highlightLog('fine\n##[error]bad'))).toBe(true);
  });
});

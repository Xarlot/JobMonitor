import { describe, expect, it } from 'vitest';
import { anchorLogMarks, MARKS_MARKER, parseLogMarks } from '../lib/logMarks';

const REPLY = `${MARKS_MARKER}
- text: FAILED com.devexpress.drawing.docs.PdfExportTest > exportsRotatedPage
  line: 3
  severity: error
  label: PdfExportTest.exportsRotatedPage failed
  note: The first real failure.

- text: Execution failed for task ':drawing-tests:test'
  line: 5
  severity: warning
  label: Gradle reports the task failed
  note: A consequence of the failure above.
`;

const LOG = [
  '2026-08-12T08:20:01.0000000Z Starting tests',
  '2026-08-12T08:20:02.0000000Z > Task :drawing-tests:test',
  '2026-08-12T08:20:09.0000000Z FAILED com.devexpress.drawing.docs.PdfExportTest > exportsRotatedPage',
  '2026-08-12T08:20:09.5000000Z   expected: <42> but was: <41>',
  "2026-08-12T08:20:10.0000000Z Execution failed for task ':drawing-tests:test'",
].join('\n');

describe('parseLogMarks', () => {
  it('reads the records the brief asks for', () => {
    const records = parseLogMarks(REPLY);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      line: 3,
      severity: 'error',
      label: 'PdfExportTest.exportsRotatedPage failed',
      note: 'The first real failure.',
    });
    expect(records[1].severity).toBe('warning');
  });

  it('defaults a missing or unknown severity to error', () => {
    expect(parseLogMarks('- text: something broke\n')[0].severity).toBe('error');
    expect(parseLogMarks('- text: something broke\n  severity: spicy\n')[0].severity).toBe('error');
  });

  /** A model that quotes the line as its label has still said where to look. */
  it('anchors on the label when there is no quoted text', () => {
    const [record] = parseLogMarks('- label: Execution failed for task\n  severity: warning\n');
    expect(record.text).toBe('Execution failed for task');
  });

  it('finds no records in a reply that is only prose', () => {
    expect(parseLogMarks('Nothing in this log indicates a failure.')).toEqual([]);
  });

  it('ignores a line number that is not one', () => {
    expect(parseLogMarks('- text: boom\n  line: unknown\n')[0].line).toBeNull();
  });
});

describe('anchorLogMarks', () => {
  it('pins each finding to the line it quoted', () => {
    const { marks, unanchored } = anchorLogMarks(parseLogMarks(REPLY), LOG);
    expect(unanchored).toBe(0);
    expect(marks.map((m) => m.line)).toEqual([3, 5]);
  });

  /**
   * The whole reason anchoring is by text: the log handed to the model is trimmed in the
   * middle, and the viewer may be showing the whole-run log from `gh` instead of the job's
   * own — so a line number the model counted is right about the ordering and wrong about the
   * position.
   */
  it('ignores a line number that disagrees with the text', () => {
    const records = parseLogMarks('- text: Execution failed for task\n  line: 999\n');
    expect(anchorLogMarks(records, LOG).marks[0].line).toBe(5);
  });

  /** The model sees the log stripped of timestamps and ANSI, so the match has to be too. */
  it('matches against the line as it is rendered, not as it arrived', () => {
    const withAnsi = '2026-08-12T08:20:09.0000000Z [31mFAILED PdfExportTest[0m';
    const { marks } = anchorLogMarks(parseLogMarks('- text: FAILED PdfExportTest\n'), withAnsi);
    expect(marks).toHaveLength(1);
    expect(marks[0].line).toBe(1);
  });

  it('forgives a difference in whitespace and in case', () => {
    const log = 'Compiling\n  expected:   <42>  but was: <41>\nDone';
    const records = parseLogMarks('- text: EXPECTED: <42> but was: <41>\n');
    expect(anchorLogMarks(records, log).marks[0].line).toBe(2);
  });

  /**
   * A build that ran the same failing command twice prints the same line twice; the hint is
   * exactly what tells the two apart.
   */
  it('uses the line number to choose between identical lines', () => {
    const log = ['assertion failed here', 'middle', 'assertion failed here', 'end'].join('\n');
    const near3 = parseLogMarks('- text: assertion failed here\n  line: 3\n');
    expect(anchorLogMarks(near3, log).marks[0].line).toBe(3);
    const near1 = parseLogMarks('- text: assertion failed here\n  line: 1\n');
    expect(anchorLogMarks(near1, log).marks[0].line).toBe(1);
  });

  /** Two findings about one line would stack into a single tick and lose one of them. */
  it('gives each finding its own line', () => {
    const records = parseLogMarks(
      '- text: assertion failed here\n\n- text: assertion failed here\n',
    );
    const { marks } = anchorLogMarks(
      records,
      ['assertion failed here', 'x', 'assertion failed here'].join('\n'),
    );
    expect(marks.map((m) => m.line)).toEqual([1, 3]);
  });

  /**
   * Dropped rather than guessed at: an error marker on an innocent line is worse than one
   * fewer marker, because a mark is only worth anything if it means something.
   */
  it('counts a finding it cannot locate instead of placing it anyway', () => {
    const records = parseLogMarks('- text: this line is not in the log\n  line: 2\n');
    const { marks, unanchored } = anchorLogMarks(records, LOG);
    expect(marks).toEqual([]);
    expect(unanchored).toBe(1);
  });

  /** Too short to be unique: it would anchor to whichever line happened to be first. */
  it('refuses an excerpt too short to identify a line', () => {
    const { marks, unanchored } = anchorLogMarks(parseLogMarks('- text: at\n'), LOG);
    expect(marks).toEqual([]);
    expect(unanchored).toBe(1);
  });

  it('reports every finding as unanchored when there is no log at all', () => {
    expect(anchorLogMarks(parseLogMarks(REPLY), '')).toEqual({ marks: [], unanchored: 2 });
  });

  /** The stripe is walked top to bottom, so the list has to be in log order. */
  it('returns the marks in log order whatever order they were written in', () => {
    const records = parseLogMarks(
      "- text: Execution failed for task\n\n- text: > Task :drawing-tests:test\n",
    );
    expect(anchorLogMarks(records, LOG).marks.map((m) => m.line)).toEqual([2, 5]);
  });
});

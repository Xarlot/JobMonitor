import { describe, expect, it } from 'vitest';
import {
  FAILURES_MARKER,
  failureItemCount,
  failuresBlock,
  groupItems,
  parseFailureCause,
} from '../lib/failureCause';

/** A well-behaved reply, as the brief asks for it. */
const CANONICAL = `${FAILURES_MARKER}
cause: three pages differ in the PDF comparison, so ExportToPdfTests fails on a real assertion
source: JUnit XML from artifact \`test-results-exporttopdf\`
failed: 2

- kind: assertion
  what: exportsRotatedPage
  group: com.example.reporting.ExportToPdfTests
  where: testing/exporttopdf/ExportToPdfTests.java:88
  message: Expected 0 diffs but got 3

- kind: error
  what: keepsFormFields
  group: com.example.reporting.ExportToPdfTests
  message: NullPointerException: Cannot invoke "Form.fields()" because "form" is null
`;

describe('parseFailureCause', () => {
  it('reads the headline and the records', () => {
    const cause = parseFailureCause(CANONICAL);
    expect(cause?.headline).toMatch(/three pages differ/);
    expect(cause?.items).toHaveLength(2);
    expect(cause?.items[0]).toEqual({
      what: 'exportsRotatedPage',
      kind: 'assertion',
      group: 'com.example.reporting.ExportToPdfTests',
      where: 'testing/exporttopdf/ExportToPdfTests.java:88',
      message: 'Expected 0 diffs but got 3',
    });
    expect(cause?.source).toBe('JUnit XML from artifact test-results-exporttopdf');
  });

  /**
   * The point of not calling this "failing tests": half of CI failures are not tests, and a
   * parser that only knew test vocabulary would either drop those items or file them as tests.
   */
  it('keeps the kinds that are not tests', () => {
    const cause = parseFailureCause(`
- kind: infrastructure
  what: Download artifacts step
  message: Error: The operation was canceled — the runner lost connection

- kind: compile
  what: PdfExporter.java
  where: src/PdfExporter.java:41
  message: cannot find symbol: method embedSubset(Font)

- kind: dependency
  what: npm ci
  message: ETIMEDOUT registry.npmjs.org

- kind: timeout
  what: Run integration tests
  message: The step timed out after 60 minutes
`);
    expect(cause?.items.map((i) => i.kind)).toEqual([
      'infrastructure',
      'compile',
      'dependency',
      'timeout',
    ]);
  });

  /** An infrastructure failure often has nothing to list — the cause line is the answer. */
  it('accepts a cause with no records', () => {
    const cause = parseFailureCause(
      `${FAILURES_MARKER}\ncause: the runner lost its connection mid-build\nsource: the job log\n`,
    );
    expect(cause?.headline).toMatch(/lost its connection/);
    expect(cause?.items).toEqual([]);
  });

  /**
   * …but a reply with neither a cause nor an item answered a different question, and an empty
   * panel would report that as a fact about the job rather than about the reply.
   */
  it('returns null when the reply says nothing at all', () => {
    expect(parseFailureCause('I was unable to determine anything.')).toBeNull();
    expect(parseFailureCause('')).toBeNull();
  });

  /** A model that has just read a JUnit XML reaches for its vocabulary, not ours. */
  it('accepts the synonyms the evidence would suggest', () => {
    const cause = parseFailureCause(`
- classname: PdfExportTest
  method: exportsRotatedPage
  type: timeout
  location: PdfExportTest.java:9
  assertion: timed out after 30s
`);
    expect(cause?.items[0]).toMatchObject({
      group: 'PdfExportTest',
      what: 'exportsRotatedPage',
      kind: 'timeout',
      where: 'PdfExportTest.java:9',
      message: 'timed out after 30s',
    });
  });

  /**
   * Two records with no blank line between them is the common shape, so the repeat of a field —
   * not the blank line — has to be what ends a record.
   */
  it('splits records on a repeated field, not only on a blank line', () => {
    const cause = parseFailureCause(`
- what: first
  message: boom
- what: second
  message: bang
`);
    expect(cause?.items.map((i) => i.what)).toEqual(['first', 'second']);
    expect(cause?.items.map((i) => i.message)).toEqual(['boom', 'bang']);
  });

  /** …and an aliased key counts as the same field, or `class:` would open a third record. */
  it('treats an alias as the same field when spotting a repeat', () => {
    const cause = parseFailureCause('- group: A\n  what: one\n- class: B\n  what: two\n');
    expect(cause?.items).toHaveLength(2);
    expect(cause?.items[1]).toMatchObject({ group: 'B', what: 'two' });
  });

  /** Models wrap a long assertion diff rather than letting it run off the edge. */
  it('joins a wrapped message onto the line it belongs to', () => {
    const cause = parseFailureCause(`
- what: rendersPdf
  message: expected: <42>
    but was: <41>
`);
    expect(cause?.items[0].message).toBe('expected: <42> but was: <41>');
  });

  /**
   * A model asked for a field it hasn't got answers "n/a" rather than leaving the line out, and
   * "unknown" in a bug report reads as a location rather than as an absence.
   */
  it('drops placeholder values instead of reporting them as facts', () => {
    const cause = parseFailureCause('- what: rendersPdf\n  where: n/a\n  message: unknown\n');
    expect(cause?.items[0].where).toBeNull();
    expect(cause?.items[0].message).toBeNull();
  });

  it('falls back to a plain failure for a kind it does not recognise', () => {
    expect(parseFailureCause('- what: t\n  kind: kaboom\n')?.items[0].kind).toBe('failure');
  });

  it('ignores a preamble the brief asked it not to write', () => {
    const cause = parseFailureCause(`Here is what I found: two failures.\n\n${CANONICAL}`);
    expect(cause?.items).toHaveLength(2);
    // The preamble's own colon must not be read as a header field.
    expect(cause?.source).toBe('JUnit XML from artifact test-results-exporttopdf');
  });

  it('reads records out of a fenced block', () => {
    const cause = parseFailureCause(`${FAILURES_MARKER}\n\`\`\`\n- what: fenced\n\`\`\`\n`);
    expect(cause?.items[0].what).toBe('fenced');
  });

  /**
   * The count and the list are different quantities: a shard can fail 400 tests off one root
   * cause, and the report has to be able to say "12 listed of 400".
   */
  it('keeps a total larger than the list', () => {
    const cause = parseFailureCause('failed: 400\n\n- what: one\n');
    expect(cause?.total).toBe(400);
    expect(failureItemCount(cause!)).toBe(400);
  });

  /** A miscounted total must not make a complete list look partial. */
  it('discards a total smaller than the list', () => {
    const cause = parseFailureCause('failed: 1\n\n- what: one\n\n- what: two\n');
    expect(cause?.total).toBeNull();
    expect(failureItemCount(cause!)).toBe(2);
  });

  /** Bounded, so a runaway reply can't fill the pane or the week-long cache. */
  it('caps how many records it keeps', () => {
    const many = Array.from({ length: 500 }, (_, i) => `- what: t${i}`).join('\n');
    expect(parseFailureCause(many)!.items.length).toBeLessThanOrEqual(300);
  });

  it('trims a message that arrived as a pasted stack trace', () => {
    const cause = parseFailureCause(`- what: t\n  message: ${'x'.repeat(900)}\n`);
    expect(cause!.items[0].message!.length).toBeLessThanOrEqual(400);
  });

  it('strips the decoration a model puts round a value', () => {
    const cause = parseFailureCause('- group: `PdfExportTest`\n  **what**: exportsRotatedPage\n');
    expect(cause?.items[0]).toMatchObject({
      group: 'PdfExportTest',
      what: 'exportsRotatedPage',
    });
  });
});

describe('groupItems', () => {
  it('groups by group in first-seen order', () => {
    const cause = parseFailureCause(`
- group: B
  what: one
- group: A
  what: two
- group: B
  what: three
`);
    const groups = groupItems(cause!.items);
    expect(groups.map((g) => g.group)).toEqual(['B', 'A']);
    expect(groups[0].items.map((i) => i.what)).toEqual(['one', 'three']);
  });

  /** Infrastructure items have nothing to group under, and must still render. */
  it('keeps ungrouped items together', () => {
    const groups = groupItems(parseFailureCause('- what: one\n\n- what: two\n')!.items);
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBeNull();
  });
});

describe('failuresBlock', () => {
  /**
   * The quick read answers with prose *and* records, and the two are kept apart from here on:
   * the prose goes into the bug report, the records into the card. Slicing at the marker is what
   * keeps a suggested fix from ending in a page of `kind:` lines.
   */
  it('slices the records out of a reply that also carried prose', () => {
    const reply = [
      '<<<PROBLEM>>>',
      'The export test broke.',
      '<<<SOLUTION>>>',
      'Fix the rounding.',
      FAILURES_MARKER,
      'source: the job log',
      '- kind: assertion',
      '  what: exportsRotatedPage',
      '  message: Expected 0 diffs but got 3',
    ].join('\n');

    const block = failuresBlock(reply);
    expect(block).not.toBeNull();
    expect(block).not.toMatch(/Fix the rounding/);
    // Kept verbatim, marker and all, so the stored text parses on its own a week later.
    expect(block?.startsWith(FAILURES_MARKER)).toBe(true);

    const cause = parseFailureCause(block as string);
    expect(cause?.items).toHaveLength(1);
    expect(cause?.items[0].what).toBe('exportsRotatedPage');
    expect(cause?.source).toBe('the job log');
  });

  it('has nothing to return when the reply carried no records', () => {
    expect(failuresBlock('<<<PROBLEM>>>\nBroke.\n<<<SOLUTION>>>\nFix it.')).toBeNull();
  });

  /**
   * The brief tells it to write the marker and nothing else when the log names no individual
   * failures — which is the common case on a sharded suite. Storing that bare marker would have
   * the card claiming an answer that has no content.
   */
  it('has nothing to return for a marker with no records under it', () => {
    expect(failuresBlock(`<<<SOLUTION>>>\nFix it.\n${FAILURES_MARKER}\n\n`)).toBeNull();
  });
});

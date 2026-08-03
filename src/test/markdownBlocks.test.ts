import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdownBlocks } from '../lib/markdownBlocks';

describe('parseMarkdownBlocks', () => {
  it('reads headings with their level', () => {
    expect(parseMarkdownBlocks('## Run tests')).toEqual([
      { kind: 'heading', level: 2, text: 'Run tests' },
    ]);
  });

  it('keeps a fenced block verbatim, including indentation', () => {
    const md = '```\n  at Assert.fail(Assert.java:1)\n    ... 24 more\n```';
    expect(parseMarkdownBlocks(md)).toEqual([
      { kind: 'code', info: '', text: '  at Assert.fail(Assert.java:1)\n    ... 24 more' },
    ]);
  });

  it('records the fence language hint', () => {
    expect(parseMarkdownBlocks('```java\nint x;\n```')[0]).toMatchObject({ info: 'java' });
  });

  /** Log text is full of `#`, `-` and `*`; inside a fence none of it is Markdown. */
  it('does not interpret Markdown inside a fence', () => {
    const md = '```\n## not a heading\n- not a bullet\n```';
    expect(parseMarkdownBlocks(md)).toHaveLength(1);
    expect(parseMarkdownBlocks(md)[0].kind).toBe('code');
  });

  it('groups consecutive bullets into one list', () => {
    expect(parseMarkdownBlocks('- one\n- two')).toEqual([
      { kind: 'list', items: ['one', 'two'] },
    ]);
  });

  it('separates paragraphs on a blank line', () => {
    const blocks = parseMarkdownBlocks('first para\n\nsecond para');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
  });

  /** A single newline inside a paragraph is kept, matching how the reports are written. */
  it('keeps a soft line break inside a paragraph', () => {
    expect(parseMarkdownBlocks('one\ntwo')).toEqual([{ kind: 'paragraph', text: 'one\ntwo' }]);
  });

  /**
   * A truncated reply is exactly when you most want to see what did arrive, so an
   * unterminated fence must still reach the output.
   */
  it('emits an unterminated fence rather than dropping it', () => {
    const blocks = parseMarkdownBlocks('```\nhalf a log');
    expect(blocks).toEqual([{ kind: 'code', info: '', text: 'half a log' }]);
  });

  it('handles a realistic rewritten log', () => {
    const md = [
      '## Run tests',
      '',
      '```',
      'ExportToPdfTests > exportsInvoice() FAILED',
      '```',
      '',
      '*The comparison found three differing pages.*',
      '',
      '## What this log does not show',
      '',
      '- the upstream job’s output',
    ].join('\n');
    expect(parseMarkdownBlocks(md).map((b) => b.kind)).toEqual([
      'heading',
      'code',
      'paragraph',
      'heading',
      'list',
    ]);
  });

  /**
   * The one piece of raw HTML the reports emit. A Markdown-only parser leaves the literal
   * `<details>` tags on screen, which is exactly what the report pane used to show.
   */
  it('reads a details block and its summary', () => {
    const md = '<details><summary>Log tail</summary>\n\n```\nFAILED\n```\n\n</details>';
    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'details', summary: 'Log tail' });
  });

  it('parses the contents of a details block, so a log inside it is still a fence', () => {
    const md = '<details><summary>Log tail</summary>\n\n```\nFAILED\n```\n\n</details>';
    const block = parseMarkdownBlocks(md)[0];
    if (block.kind !== 'details') throw new Error('expected a details block');
    expect(block.blocks).toEqual([{ kind: 'code', info: '', text: 'FAILED' }]);
  });

  /** Log text can contain anything, including a line that looks like a closing tag. */
  it('does not end a details block at a </details> inside a fence', () => {
    const md = '<details><summary>s</summary>\n\n```\n</details>\n```\n\n</details>\n\nafter';
    const blocks = parseMarkdownBlocks(md);
    expect(blocks.map((b) => b.kind)).toEqual(['details', 'paragraph']);
  });

  it('handles a details block with no summary', () => {
    expect(parseMarkdownBlocks('<details>\n\ntext\n\n</details>')[0]).toMatchObject({
      kind: 'details',
      summary: '',
    });
  });

  /** A truncated report still has to show what arrived. */
  it('emits an unterminated details block', () => {
    const blocks = parseMarkdownBlocks('<details><summary>s</summary>\n\nhalf');
    expect(blocks[0]).toMatchObject({ kind: 'details', summary: 's' });
  });

  /** The blame report's flaky-test list is a table; as prose it loses what makes it usable. */
  it('reads a pipe table with its header', () => {
    const md = ['| Test | Failures |', '|---|---|', '| `a.b` | 3 of 30 |', '| `c.d` | 1 of 30 |'].join(
      '\n',
    );
    expect(parseMarkdownBlocks(md)).toEqual([
      {
        kind: 'table',
        header: ['Test', 'Failures'],
        rows: [
          ['`a.b`', '3 of 30'],
          ['`c.d`', '1 of 30'],
        ],
      },
    ]);
  });

  /**
   * The separator is what makes it a table. A lone pipe-delimited line is far more often
   * prose — a log line, a shell pipeline — and turning that into a one-row table is worse
   * than leaving it as text.
   */
  it('does not treat a pipe-delimited line without a rule as a table', () => {
    const md = '| this is just prose | with a pipe |';
    expect(parseMarkdownBlocks(md)[0].kind).toBe('paragraph');
  });

  it('ends the table at the first non-row line', () => {
    const md = ['| A |', '|---|', '| 1 |', '', 'after the table'].join('\n');
    expect(parseMarkdownBlocks(md).map((b) => b.kind)).toEqual(['table', 'paragraph']);
  });

  it('handles a table with no body rows', () => {
    expect(parseMarkdownBlocks('| A | B |\n|---|---|')[0]).toMatchObject({
      kind: 'table',
      rows: [],
    });
  });

  /** Inside a fence a pipe is log output, not markup. */
  it('does not read a table inside a code fence', () => {
    const md = '```\n| A |\n|---|\n```';
    expect(parseMarkdownBlocks(md)).toHaveLength(1);
    expect(parseMarkdownBlocks(md)[0].kind).toBe('code');
  });

  it('accepts an aligned separator row', () => {
    expect(parseMarkdownBlocks('| A | B |\n|:--|--:|\n| 1 | 2 |')[0].kind).toBe('table');
  });

  it('returns nothing for empty input', () => {
    expect(parseMarkdownBlocks('')).toEqual([]);
  });
});

describe('parseInline', () => {
  it('splits code spans out of prose', () => {
    expect(parseInline('see `Assert.java:1` here')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'code', text: 'Assert.java:1' },
      { kind: 'text', text: ' here' },
    ]);
  });

  /**
   * Code first, deliberately: quoted log text routinely contains `**`, and reading that
   * as bold would eat the asterisks and mangle the line.
   */
  it('does not read bold markers inside a code span', () => {
    expect(parseInline('`a ** b`')).toEqual([{ kind: 'code', text: 'a ** b' }]);
  });

  it('reads bold and italic', () => {
    expect(parseInline('**loud** and *quiet*')).toEqual([
      { kind: 'bold', text: 'loud' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'quiet' },
    ]);
  });

  it('reads an http link', () => {
    expect(parseInline('[run](https://example.com/1)')).toEqual([
      { kind: 'link', text: 'run', href: 'https://example.com/1' },
    ]);
  });

  /** Only http(s) becomes a link; anything else stays literal text. */
  it('refuses a non-http target', () => {
    const spans = parseInline('[x](javascript:alert(1))');
    expect(spans.every((s) => s.kind !== 'link')).toBe(true);
  });

  /** The report's own footer is written this way, and it was rendering with the marks. */
  it('reads underscore emphasis when it wraps a whole span', () => {
    expect(parseInline('_Job Monitor v1.2.0 · fingerprint a1b2_')).toEqual([
      { kind: 'italic', text: 'Job Monitor v1.2.0 · fingerprint a1b2' },
    ]);
  });

  /**
   * The reason underscore emphasis is bounded: log text and test names are full of
   * snake_case, and eating those underscores corrupts the identifiers a reader copies.
   */
  it('does not treat snake_case as emphasis', () => {
    for (const text of ['test_pdf_parsing_net failed', 'a some_var_name b', 'run_id=7']) {
      expect(parseInline(text)).toEqual([{ kind: 'text', text }]);
    }
  });

  it('leaves snake_case and lone asterisks alone', () => {
    expect(parseInline('some_var_name and 2 * 3')).toEqual([
      { kind: 'text', text: 'some_var_name and 2 * 3' },
    ]);
  });

  /** The blame report is about a person, so the login has to be findable at a glance. */
  it('picks out an @login as a mention', () => {
    expect(parseInline('**Who:** @jdoe broke it')).toContainEqual({ kind: 'mention', text: '@jdoe' });
  });

  it('accepts the hyphens GitHub logins use', () => {
    expect(parseInline('@some-user-1 did')).toContainEqual({ kind: 'mention', text: '@some-user-1' });
  });

  /**
   * Bounded on the left, or every email address and `user@host` in a quoted log line
   * becomes a person — which would make the highlighting worthless.
   */
  it('does not read an email or user@host as a mention', () => {
    for (const text of ['mail me at jane@example.com', 'ssh build@runner-3 failed']) {
      expect(parseInline(text).every((s) => s.kind !== 'mention')).toBe(true);
    }
  });

  /** Inside backticks it is log text, not a person. */
  it('does not find a mention inside a code span', () => {
    expect(parseInline('`git log --author=@jdoe`')).toEqual([
      { kind: 'code', text: 'git log --author=@jdoe' },
    ]);
  });

  it('keeps the surrounding prose intact around a mention', () => {
    expect(parseInline('by @jdoe, in a1b2')).toEqual([
      { kind: 'text', text: 'by ' },
      { kind: 'mention', text: '@jdoe' },
      { kind: 'text', text: ', in a1b2' },
    ]);
  });

  it('returns plain text unchanged', () => {
    expect(parseInline('nothing special')).toEqual([{ kind: 'text', text: 'nothing special' }]);
  });
});

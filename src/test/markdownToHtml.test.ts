import { describe, expect, it } from 'vitest';
import { escapeHtml, markdownToHtml } from '../lib/markdownToHtml';

describe('escapeHtml', () => {
  it('escapes the characters that could open a tag or attribute', () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
  });
});

describe('markdownToHtml', () => {
  it('converts headings', () => {
    expect(markdownToHtml('### Title')).toContain('<h3>Title</h3>');
    expect(markdownToHtml('#### Failed tests (1)')).toContain('<h4>Failed tests (1)</h4>');
  });

  /** GitHub's comment renderer treats a single newline as a hard break; match it. */
  it('keeps single newlines as line breaks, and blank lines as paragraphs', () => {
    expect(markdownToHtml('one\ntwo\n\nthree')).toBe(
      '<div style="font-family:Segoe UI,system-ui,sans-serif;font-size:14px;line-height:1.45">' +
        '<p>one<br>two</p><p>three</p></div>',
    );
  });

  /**
   * Report text is full of digits ("Expected 0 diffs but got 3"), so a numeric code
   * placeholder would be matched inside the prose and swapped for the wrong span.
   */
  it('does not confuse digits in the text with a parked code span', () => {
    const html = markdownToHtml('- `Foo.java:88` — Expected 0 diffs but got 3 in export');
    expect(html).toMatch(/<code[^>]*>Foo\.java:88<\/code>/);
    expect(html).toContain('Expected 0 diffs but got 3 in export');
    expect(html).not.toContain('undefined');
  });

  it('restores several code spans on one line in order', () => {
    const html = markdownToHtml('`first` then `second`');
    expect(html).toMatch(/<code[^>]*>first<\/code> then <code[^>]*>second<\/code>/);
  });

  it('converts bullet lists into a single <ul>', () => {
    const html = markdownToHtml('- one\n- two');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
  });

  it('converts bold, inline code and http links', () => {
    const html = markdownToHtml('**PR** [#7 title](https://github.com/o/r/pull/7) `ci.yml`');
    expect(html).toContain('<strong>PR</strong>');
    expect(html).toContain('<a href="https://github.com/o/r/pull/7">#7 title</a>');
    expect(html).toMatch(/<code[^>]*>ci\.yml<\/code>/);
  });

  it('converts a fenced block into a <pre><code> block', () => {
    const html = markdownToHtml('```\nline one\nline two\n```');
    expect(html).toContain('<pre');
    expect(html).toMatch(/<code[^>]*>line one\nline two<\/code>/);
  });

  /** A `**` inside backticks is code, not emphasis. */
  it('does not apply bold inside a code span', () => {
    const html = markdownToHtml('`a ** b`');
    expect(html).toMatch(/<code[^>]*>a \*\* b<\/code>/);
    expect(html).not.toContain('<strong>');
  });

  it('leaves snake_case alone', () => {
    expect(markdownToHtml('some_var_name here')).toContain('some_var_name here');
    expect(markdownToHtml('some_var_name here')).not.toContain('<em>');
  });

  it('italicises a fully wrapped span, as the report footer uses', () => {
    expect(markdownToHtml('_Job Monitor v1.2.0_')).toContain('<em>Job Monitor v1.2.0</em>');
  });

  // --- the security-relevant cases ------------------------------------------
  // The input carries CI log text and model output, so markup in it must never
  // become live markup in the clipboard payload or the preview.

  it('escapes HTML in prose', () => {
    const html = markdownToHtml('a <script>alert(1)</script> b');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('escapes HTML inside a fenced log block', () => {
    const html = markdownToHtml('```\n<img src=x onerror=alert(1)>\n```');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('escapes HTML inside list items and code spans', () => {
    expect(markdownToHtml('- <b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(markdownToHtml('`<b>x</b>`')).toMatch(/<code[^>]*>&lt;b&gt;x&lt;\/b&gt;<\/code>/);
  });

  it('refuses a javascript: link target, leaving it as text', () => {
    const html = markdownToHtml('[click](javascript:alert(1))');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('[click](javascript:alert(1))');
  });

  it('refuses other non-http schemes', () => {
    expect(markdownToHtml('[x](data:text/html,<b>)')).not.toContain('href="data:');
    expect(markdownToHtml('[x](file:///etc/passwd)')).not.toContain('href="file:');
  });

  /**
   * The payload may still *contain* the word as inert text — what must not happen is
   * a raw quote closing the href and turning the rest into attributes.
   */
  it('cannot be tricked into a quoted attribute break', () => {
    const html = markdownToHtml('[x](https://ok.test/") onmouseover="alert(1))');
    expect(html).not.toMatch(/onmouseover\s*=\s*"/);
    expect(html).toContain('&quot;');
    // Every quote inside the tag itself is one we put there.
    const tag = /<a href="[^"]*">/.exec(html);
    expect(tag).not.toBeNull();
  });

  it('handles an unterminated fence without dropping its content', () => {
    expect(markdownToHtml('```\nstranded line')).toContain('stranded line');
  });

  it('produces a self-contained wrapper, since it lands in a foreign renderer', () => {
    const html = markdownToHtml('hi');
    expect(html.startsWith('<div style="font-family:')).toBe(true);
    expect(html.endsWith('</div>')).toBe(true);
  });

  it('handles empty input', () => {
    expect(markdownToHtml('')).toContain('<div');
  });
});

describe('code blocks on the clipboard', () => {
  /**
   * The bug: only the background was set, so the text colour came from the host. A light
   * block in Teams' dark theme rendered light text on a light background — invisible.
   */
  it('sets a text colour alongside the background', () => {
    const html = markdownToHtml('```\nFAILED\n```');
    expect(html).toMatch(/<pre style="[^"]*background:#f6f8fa/);
    expect(html).toMatch(/<pre style="[^"]*color:#1f2328/);
  });

  /** A chat message cannot scroll sideways, so a scroll container just clips. */
  it('wraps long lines instead of trying to scroll', () => {
    const html = markdownToHtml('```\n' + 'x'.repeat(400) + '\n```');
    expect(html).toMatch(/white-space:pre-wrap/);
    expect(html).toMatch(/overflow-wrap:anywhere/);
    expect(html).not.toMatch(/overflow-x:auto/);
  });

  /** Teams normalises pasted HTML and does not reliably keep <pre>'s default font. */
  it('names a monospace font explicitly', () => {
    expect(markdownToHtml('```\nx\n```')).toMatch(/font-family:Consolas/);
  });

  /** So the block still reads as one if the background is stripped. */
  it('gives the block a border', () => {
    expect(markdownToHtml('```\nx\n```')).toMatch(/<pre style="[^"]*border:1px solid/);
  });

  it('styles inline code too, since no stylesheet travels with a paste', () => {
    expect(markdownToHtml('run `ci.yml` now')).toMatch(/<code style="[^"]*font-family:Consolas/);
  });

  /** Styling must not weaken the escaping — log text is whatever the build printed. */
  it('still escapes the block contents', () => {
    expect(markdownToHtml('```\n<img src=x>\n```')).toContain('&lt;img src=x&gt;');
  });
});

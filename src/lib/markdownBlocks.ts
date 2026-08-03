/**
 * Split Markdown into the block types the app renders.
 *
 * Separate from `markdownToHtml`, which exists for the clipboard: that one produces a
 * string of HTML for someone else's renderer, this one produces data for React
 * components. Sharing a parser between them would mean either injecting HTML into the app
 * (log text is untrusted) or building the clipboard payload out of React, and neither is
 * better than parsing twice — the grammar is a dozen lines.
 *
 * The subset is exactly what `CLAUDE_LOG_BRIEF` asks for, plus what the app's own reports
 * emit. Anything unrecognised falls through as paragraph text, which renders as plain
 * prose — the safe failure.
 */

export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  /** A fenced block. `info` is the fence's language hint, '' when absent. */
  | { kind: 'code'; info: string; text: string }
  /**
   * A `<details><summary>…</summary>…</details>` section.
   *
   * The one piece of raw HTML the app's own reports emit — GitHub renders it as a
   * collapsible, which is how the log tail and the suggested fix stay out of the way.
   * Parsed rather than escaped so the preview can show a real collapsible instead of the
   * literal tags, which is what a Markdown-only parser would leave behind.
   */
  | { kind: 'details'; summary: string; blocks: MarkdownBlock[] }
  /**
   * A pipe table. The blame report's flaky-test list is one — a test, where it failed and
   * how often is genuinely tabular, and rendering it as paragraph text would throw away
   * the alignment that makes it scannable.
   */
  | { kind: 'table'; header: string[]; rows: string[][] };

const FENCE_RE = /^\s*```(.*)$/;
const DETAILS_OPEN_RE = /^\s*<details>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i;
const DETAILS_CLOSE_RE = /^\s*<\/details>\s*$/i;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
/** The `|---|:--:|` line under a header, which is what makes it a table rather than prose. */
const TABLE_RULE_RE = /^\s*\|[\s:|-]+\|\s*$/;

function tableCells(line: string): string[] {
  const inner = TABLE_ROW_RE.exec(line)?.[1] ?? '';
  return inner.split('|').map((c) => c.trim());
}
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.split(/\r?\n/);

  let paragraph: string[] = [];
  let list: string[] = [];
  let fence: { info: string; body: string[] } | null = null;
  /**
   * Lines gathered inside a `<details>`, parsed recursively when it closes. `inFence`
   * tracks whether the body is currently inside a fenced block, because log text can
   * contain a line that looks like a closing tag and must not end the section.
   */
  let details: { summary: string; body: string[]; inFence: boolean } | null = null;
  let table: { header: string[]; rows: string[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ kind: 'list', items: list });
    list = [];
  };
  const flushTable = () => {
    if (table) blocks.push({ kind: 'table', header: table.header, rows: table.rows });
    table = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Everything up to the matching close belongs to the details and is re-parsed as a
    // whole, so the body is only scanned here for its own fences and its closing tag.
    if (details) {
      if (FENCE_RE.test(line)) details.inFence = !details.inFence;
      if (!details.inFence && DETAILS_CLOSE_RE.test(line)) {
        blocks.push({
          kind: 'details',
          summary: details.summary,
          blocks: parseMarkdownBlocks(details.body.join('\n')),
        });
        details = null;
      } else {
        details.body.push(line);
      }
      continue;
    }
    if (fence === null) {
      const open = DETAILS_OPEN_RE.exec(line);
      if (open) {
        flush();
        details = { summary: open[1] ?? '', body: [], inFence: false };
        continue;
      }
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      if (fence) {
        blocks.push({ kind: 'code', info: fence.info, text: fence.body.join('\n') });
        fence = null;
      } else {
        flush();
        fence = { info: fenceMatch[1].trim(), body: [] };
      }
      continue;
    }
    if (fence) {
      fence.body.push(line);
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    // A pipe-delimited line is only a table once the `|---|` rule under it says so — on its
    // own it is far more often ordinary prose that happens to contain a pipe.
    if (table) {
      if (TABLE_ROW_RE.test(line)) {
        table.rows.push(tableCells(line));
        continue;
      }
      flushTable();
    } else if (TABLE_ROW_RE.test(line) && TABLE_RULE_RE.test(lines[i + 1] ?? '')) {
      flush();
      table = { header: tableCells(line), rows: [] };
      i += 1; // consume the rule line
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  // Unterminated blocks still have to reach the output rather than vanish — a truncated
  // reply is exactly when you most want to see what did arrive.
  if (fence) blocks.push({ kind: 'code', info: fence.info, text: fence.body.join('\n') });
  if (details) {
    blocks.push({
      kind: 'details',
      summary: details.summary,
      blocks: parseMarkdownBlocks(details.body.join('\n')),
    });
  }
  flush();

  return blocks;
}

/** Inline spans within a block's text. */
export type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'link'; text: string; href: string }
  /** `@login` — a person, picked out so the eye finds them without reading. */
  | { kind: 'mention'; text: string };

/** Only http(s) becomes a link; anything else stays as the literal text. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

/**
 * Code spans are matched first so that `**` inside backticks is not read as bold, which
 * is common in log text quoted inside an annotation.
 *
 * Mentions are last and bounded on the left by start-of-line or whitespace, so an email
 * address or a `user@host` in a log line is not mistaken for one. GitHub logins are
 * alphanumeric with single hyphens, up to 39 characters.
 *
 * Underscore emphasis only counts when it wraps a whole span — bounded by a space or
 * punctuation on both sides — so `some_var_name` and `test_pdf_parsing` survive. Log text
 * and test names are full of snake_case, and eating those underscores would corrupt the
 * very identifiers a reader needs to copy.
 */
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|((?<=^|\s)_[^_\n]+_(?=$|\s|[.,;:!?]))|((?<=^|\s)@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\b)/g;

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;

  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) spans.push({ kind: 'text', text: text.slice(last, at) });
    const [token] = m;

    if (token.startsWith('`')) {
      spans.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const close = token.indexOf(']');
      const label = token.slice(1, close);
      const href = safeHref(token.slice(close + 2, -1));
      spans.push(href ? { kind: 'link', text: label, href } : { kind: 'text', text: token });
    } else if (token.startsWith('**')) {
      spans.push({ kind: 'bold', text: token.slice(2, -2) });
    } else if (token.startsWith('@')) {
      spans.push({ kind: 'mention', text: token });
    } else {
      // `*x*` and `_x_` both land here; each strips one delimiter per side.
      spans.push({ kind: 'italic', text: token.slice(1, -1) });
    }
    last = at + token.length;
  }

  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) });
  return spans;
}

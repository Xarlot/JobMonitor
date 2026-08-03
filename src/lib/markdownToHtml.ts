/**
 * A deliberately small Markdown → HTML converter, for putting a report on the
 * clipboard as rich text.
 *
 * **Why this exists.** Teams does not render Markdown that arrives from the
 * clipboard: it applies its Markdown-*like* shortcuts as you type, and only a
 * limited subset of them. Pasting a whole `.md` file yields literal `**` and `####`.
 * What Teams *does* accept is rich text — so the report is converted to HTML and
 * written to the clipboard as `text/html`, which is exactly what copying out of a
 * Markdown preview pane does by hand.
 *
 * **This is not a general Markdown parser** and should not grow into one. It handles
 * precisely the constructs `buildFailureReport` emits, plus the simple prose the model
 * is instructed to return (paragraphs, bullets, bold, inline code, links). Anything
 * else passes through as escaped text, which is the safe failure.
 *
 * Every piece of dynamic text — log lines, annotation messages, model output — is
 * HTML-escaped before any markup is added, and link targets are restricted to
 * http(s). The input includes CI log content, so treating it as trusted markup would
 * be an injection waiting to happen.
 */

/**
 * Inline styling for a log block on the clipboard.
 *
 * Every property here is load-bearing in a paste target, where no stylesheet follows the
 * content:
 *
 * - `color` alongside `background`. Setting only the background was a bug: the text colour
 *   is inherited from the host, so a light block in Teams' dark theme rendered light text
 *   on a light background — invisible.
 * - `pre-wrap` + `overflow-wrap`, not `overflow-x: auto`. A chat message cannot scroll
 *   sideways, so a scroll container just clips; log lines are long and must wrap.
 * - An explicit monospace stack. Teams normalises pasted HTML and does not reliably keep
 *   `<pre>`'s default font.
 * - A border, so the block still reads as a block if the background is stripped.
 */
const CODE_BLOCK_STYLE = [
  'background:#f6f8fa',
  'color:#1f2328',
  'border:1px solid #d0d7de',
  'border-radius:6px',
  'padding:8px 10px',
  'margin:6px 0',
  "font-family:Consolas,'Courier New',monospace",
  'font-size:12px',
  'line-height:1.45',
  'white-space:pre-wrap',
  'overflow-wrap:anywhere',
].join(';');

/** Inline code, styled for the same reason: no stylesheet travels with the paste. */
const CODE_SPAN_STYLE = [
  'background:#eff1f3',
  'color:#1f2328',
  'border-radius:4px',
  'padding:1px 4px',
  "font-family:Consolas,'Courier New',monospace",
  'font-size:12px',
].join(';');

function codeBlock(text: string): string {
  return `<pre style="${CODE_BLOCK_STYLE}"><code>${escapeHtml(text)}</code></pre>`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only http(s) targets become links; anything else stays as plain text. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

/**
 * Inline markup, applied to already-escaped text. Order matters: code spans first, so
 * a `**` inside backticks isn't mistaken for bold.
 */
function inline(escaped: string): string {
  const codes: string[] = [];
  // Park code spans, restore them at the end.
  //
  // The sentinel wraps the index in angle brackets, which cannot occur in the input:
  // escapeHtml has already turned every `<` into `&lt;`. A numeric-only placeholder
  // like " 0 " would collide with the report's own prose — "Expected 0 diffs but got
  // 3" — and get swapped for the wrong code span.
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `<${codes.length - 1}>`;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    const href = safeHref(url);
    return href ? `<a href="${href}">${label}</a>` : match;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Underscore emphasis only when it wraps a whole span, so snake_case survives.
  out = out.replace(/(^|\s)_([^_]+)_(?=$|\s|[.,;:!?])/g, '$1<em>$2</em>');

  // Restore only bare `<digits>` — the tags added just above are `<a …>`, `<strong>`
  // and `<em>`, none of which match.
  return out.replace(
    /<(\d+)>/g,
    (_m, index: string) => `<code style="${CODE_SPAN_STYLE}">${codes[Number(index)]}</code>`,
  );
}

/**
 * Convert the app's own report Markdown to HTML.
 *
 * The wrapper carries inline styles rather than classes: the clipboard payload lands
 * in someone else's renderer, which knows nothing about our stylesheet.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let fence: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    // Joined with <br>, not a space: GitHub's comment renderer treats a single
    // newline as a hard break, and the report's metadata block ("**PR** …" /
    // "**Workflow** …" / "**Failed step** …") is written expecting that.
    html.push(`<p>${paragraph.map((line) => inline(escapeHtml(line))).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    html.push(`<ul>${list.map((item) => `<li>${inline(escapeHtml(item))}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    // Fenced code: collected verbatim, escaped, emitted as a <pre> block. Teams shows
    // it as preformatted text, which is the closest it has to a code block.
    if (line.trimStart().startsWith('```')) {
      if (fence === null) {
        flushAll();
        fence = [];
      } else {
        html.push(codeBlock(fence.join('\n')));
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  // An unterminated fence still has to reach the output rather than vanish.
  if (fence !== null && fence.length > 0) {
    html.push(codeBlock(fence.join('\n')));
  }
  flushAll();

  return `<div style="font-family:Segoe UI,system-ui,sans-serif;font-size:14px;line-height:1.45">${html.join(
    '',
  )}</div>`;
}

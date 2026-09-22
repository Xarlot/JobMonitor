/**
 * Claude's findings in a log, pinned back onto the lines they came from.
 *
 * What this buys over the local highlighter: `src/lib/logHighlight.ts` colours a line that
 * *looks* like a failure, one line at a time, with no idea which of the forty red lines in a
 * failed run is the one that matters. This pass reads the whole log and marks the handful of
 * places something actually went wrong, each with a sentence saying what it means — the
 * difference between colour and a map. The map is what the marker stripe and the
 * next/previous buttons in the log viewer navigate.
 *
 * **Findings are anchored by quoted text, not by line number.** A model counting lines in a
 * 60,000-character log gets it wrong, and it would be wrong here even if it counted
 * perfectly: the log handed to the model is trimmed in the middle (see `trimLog`), and the
 * viewer may be showing the whole-run log from `gh` rather than the job's own — so the two
 * texts do not share a numbering. Quoting a line is something a model does reliably, and a
 * quote can be *found*. A line number is accepted as a tie-breaker and never as the answer.
 *
 * A finding that cannot be located is dropped and counted, never guessed at: putting an
 * error marker on an innocent line is worse than showing one fewer marker, because the whole
 * point of the stripe is that a mark means something.
 */

import { highlightLogLine } from './logHighlight';

export type LogMarkSeverity = 'error' | 'warning' | 'notice';

/** One finding, before it has been located in the text on screen. */
export interface LogMarkRecord {
  /** Verbatim excerpt of the line it refers to — the anchor. */
  text: string;
  /** The model's own line number. A hint for disambiguation, nothing more. */
  line: number | null;
  severity: LogMarkSeverity;
  /** A few words for the stripe's tooltip and the finding list. */
  label: string;
  /** One sentence on what it means, when the model added one. */
  note: string | null;
}

/** A finding with a line of the displayed log behind it. */
export interface LogMark extends LogMarkRecord {
  /** 1-based line number **in the log being displayed**. */
  line: number;
}

export const MARKS_MARKER = '<<<MARKS>>>';

/**
 * Ceiling on findings. The brief asks for the decisive ones, so a reply with hundreds has
 * misunderstood the task — and a stripe with hundreds of ticks is the wall of colour the
 * highlighter deliberately avoids.
 */
const MAX_MARKS = 200;
/**
 * Shortest excerpt worth searching for. Anything shorter matches half the log — "at " or
 * "FAIL" would anchor to whichever line happened to be first, which is the one outcome
 * worse than no mark at all.
 */
const MIN_ANCHOR_CHARS = 6;
const MAX_LABEL_CHARS = 120;
const MAX_NOTE_CHARS = 300;

const SEVERITY_WORDS: Record<string, LogMarkSeverity> = {
  error: 'error',
  fail: 'error',
  failure: 'error',
  failed: 'error',
  fatal: 'error',
  critical: 'error',
  warning: 'warning',
  warn: 'warning',
  notice: 'notice',
  info: 'notice',
  note: 'notice',
  context: 'notice',
};

function normalizeSeverity(raw: string | undefined): LogMarkSeverity {
  if (!raw) return 'error';
  const word = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  return SEVERITY_WORDS[word] ?? 'error';
}

const FIELD_RE = /^\s*(?:[-*+]\s*)?\*{0,2}([A-Za-z][A-Za-z ]{0,20})\*{0,2}\s*:\s*(.*)$/;

interface Draft {
  text?: string;
  line?: string;
  severity?: string;
  label?: string;
  note?: string;
}

const FIELD_ALIASES: Record<string, keyof Draft> = {
  text: 'text',
  quote: 'text',
  excerpt: 'text',
  line: 'line',
  lineno: 'line',
  at: 'line',
  severity: 'severity',
  kind: 'severity',
  level: 'severity',
  label: 'label',
  what: 'label',
  title: 'label',
  note: 'note',
  why: 'note',
  detail: 'note',
};

/** Strip the decoration a model puts around a quoted line. */
function clean(value: string): string {
  return value
    .trim()
    .replace(/^\*{1,2}(.*)\*{1,2}$/s, '$1')
    .replace(/^`+(.*?)`+$/s, '$1')
    .replace(/^"(.*)"$/s, '$1')
    .trim();
}

function toRecord(draft: Draft): LogMarkRecord | null {
  const text = draft.text ? clean(draft.text) : '';
  const label = draft.label ? clean(draft.label) : '';
  // Without an anchor there is nothing to point at, and a label alone would have to be
  // placed by guesswork. The `label` fallback covers a model that quotes the line *as* its
  // label, which is a reasonable reading of the brief and still perfectly locatable.
  const anchor = text || label;
  if (!anchor) return null;
  const line = draft.line ? Number.parseInt(clean(draft.line).replace(/[^0-9]/g, ''), 10) : NaN;
  const note = draft.note ? clean(draft.note).slice(0, MAX_NOTE_CHARS) : '';
  return {
    text: anchor,
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
    severity: normalizeSeverity(draft.severity),
    label: (label || anchor).slice(0, MAX_LABEL_CHARS),
    note: note || null,
  };
}

/**
 * Read the reply into findings, in the order the model wrote them.
 *
 * Same record format and the same tolerance as `parseFailureCause` — see the note there
 * on why the tasks that return data take it back as lines rather than as JSON.
 */
export function parseLogMarks(reply: string): LogMarkRecord[] {
  const at = reply.indexOf(MARKS_MARKER);
  const body = at === -1 ? reply : reply.slice(at + MARKS_MARKER.length);

  const records: LogMarkRecord[] = [];
  let draft: Draft | null = null;

  const flush = () => {
    if (!draft) return;
    const record = toRecord(draft);
    if (record && records.length < MAX_MARKS) records.push(record);
    draft = null;
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) continue;
    const field = FIELD_RE.exec(line);
    const key = field ? field[1].trim().toLowerCase().replace(/\s+/g, '') : null;
    const target = key ? FIELD_ALIASES[key] : undefined;
    if (!target) {
      /*
       * A wrapped note continues; anything else closes the record. An unrecognised
       * `key: value` line lands here too, because that is what a wrapped sentence containing
       * a colon looks like.
       *
       * The quoted line is deliberately **not** continued: a half-line anchor still matches
       * the line it came from, whereas gluing the next line onto it would stop it matching
       * anything at all.
       */
      const text = line.trim();
      if (draft?.note && text && !/^[#>]/.test(text)) draft.note += ` ${text}`;
      else if (!text) flush();
      continue;
    }
    if (draft && target in draft) flush();
    draft = { ...(draft ?? {}), [target]: field![2] };
  }
  flush();
  return records;
}

/** Whitespace-insensitive, because a model reproduces the words and not the indentation. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface AnchoredMarks {
  /** Located findings, in log order. */
  marks: LogMark[];
  /**
   * How many findings referred to something not in this text.
   *
   * Surfaced rather than swallowed: on the whole-run log from `gh` it is normal for a
   * finding from the job's own log to be missing, and a viewer that quietly showed six of
   * eight marks would have the reader trusting a map with holes in it.
   */
  unanchored: number;
}

/**
 * Locate each finding in the log the viewer is showing.
 *
 * The text compared against is the line as **rendered** — timestamps and ANSI removed, via
 * the same `highlightLogLine` the renderer uses — so a model quoting what it saw matches
 * what the reader sees, and an anchor is never lost to an escape sequence.
 */
export function anchorLogMarks(records: readonly LogMarkRecord[], log: string): AnchoredMarks {
  if (records.length === 0 || !log) {
    return { marks: [], unanchored: records.length };
  }

  const lines = log.split(/\r?\n/).map((raw) => normalize(highlightLogLine(raw).text));
  const lower = lines.map((line) => line.toLowerCase());

  const marks: LogMark[] = [];
  let unanchored = 0;
  /** One mark per line: two findings about the same line would stack into one tick. */
  const taken = new Set<number>();

  for (const record of records) {
    const anchor = normalize(record.text);
    let index = -1;
    if (anchor.length >= MIN_ANCHOR_CHARS) {
      index = closest(lines, anchor, record.line, taken);
      // Case is the one thing a model routinely normalises when quoting; a case-insensitive
      // second pass rescues those without loosening the match into a fuzzy one.
      if (index === -1) index = closest(lower, anchor.toLowerCase(), record.line, taken);
    }
    if (index === -1) {
      unanchored += 1;
      continue;
    }
    taken.add(index);
    marks.push({ ...record, line: index + 1 });
  }

  marks.sort((a, b) => a.line - b.line);
  return { marks, unanchored };
}

/**
 * The line containing `anchor` nearest the model's own line number, skipping lines already
 * marked.
 *
 * Nearest rather than first: a build that ran the same failing command twice prints the same
 * assertion twice, and the hint — wrong as an absolute position but roughly right as an
 * ordering — is exactly what tells the two apart.
 */
function closest(
  lines: readonly string[],
  anchor: string,
  hint: number | null,
  taken: ReadonlySet<number>,
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lines.length; i += 1) {
    if (taken.has(i) || !lines[i].includes(anchor)) continue;
    if (hint === null) return i;
    const distance = Math.abs(i + 1 - hint);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

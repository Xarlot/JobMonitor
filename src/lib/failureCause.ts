/**
 * What actually failed, as Claude read it out of the run's own evidence.
 *
 * Why this exists: GitHub's answer to "what failed?" is a check-run annotation, and an
 * annotation describes the **step**. A sharded Gradle job reports `Gradle Tests Failed
 * (drawing-docs)` and `Process completed with exit code 1` — which names nothing anybody can
 * go and fix, and was exactly what the Failures tab used to lead with.
 *
 * Deliberately **not** "failing tests". Often it is tests, and then the specifics are in a
 * JUnit XML inside the run's artifacts. Often it is not: a compile error, a missing
 * dependency, a runner that died, a disk that filled, a step that timed out. A list that can
 * only hold tests would have to leave the second half of CI reality out, so an item here is
 * "one concrete thing that broke", whatever kind of thing that is.
 *
 * The reply is **records, not prose** — a one-line cause plus one record per item. Fields are
 * short and single-line (a name, a location, an assertion), which is what makes a
 * line-oriented format the right choice even though the rest of the app takes prose back from
 * Claude: `expected: <"a\tb">` survives `key: value` intact where a model escaping it into
 * JSON can lose the whole reply.
 *
 * Tolerant on purpose — a reply that misses a field, adds one, or wraps a long message onto
 * the next line still yields a usable list, because the alternative is discarding a slow and
 * billable call over a stray newline. Nothing here renders or escapes anything: this is data,
 * and `FailureCauseCard` (React) is what makes it safe to look at.
 */

/** What kind of thing broke, once mapped onto something we can label and colour. */
export type FailureItemKind =
  | 'test'
  | 'assertion'
  | 'error'
  | 'compile'
  | 'timeout'
  | 'crash'
  | 'infrastructure'
  | 'dependency'
  | 'lint'
  | 'skipped'
  | 'failure';

export interface FailureItem {
  /** The test, file, step or check that failed. The one field a record cannot omit. */
  what: string;
  kind: FailureItemKind;
  /** Suite, class, file or phase it belongs to — the grouping, when there is one. */
  group: string | null;
  /** `path:line`, or whatever locator the evidence carried. */
  where: string | null;
  /** The decisive line — the assertion diff, the exception, the runner's message. */
  message: string | null;
}

export interface FailureCause {
  /**
   * One line naming the cause, in Claude's words.
   *
   * The headline is the point of the whole task: a reader arriving at a red job wants a
   * sentence before a list, and "three pages differ in the PDF comparison" is worth more at
   * the top of the pane than twelve rows of test names are.
   */
  headline: string | null;
  items: FailureItem[];
  /** Where it read them: an artifact by name, the log, the annotations. */
  source: string | null;
  /**
   * How many things failed in total, when only some were listed.
   *
   * Kept apart from `items.length` because the two genuinely differ: a shard with 400
   * failures cascading from one root cause should be listed in part and counted in full, and
   * a list that silently showed 40 of 400 would be read as the whole truth.
   */
  total: number | null;
  /** Anything that bounds the list — "the report covers this shard only". */
  note: string | null;
}

export const FAILURES_MARKER = '<<<FAILURES>>>';

/**
 * The record block out of a reply that also carried prose.
 *
 * The quick read answers with the two prose sections *and* these records, and the three are
 * kept apart from there on: the prose goes into the bug report, the records into the card. This
 * returns the records verbatim — marker included, so the text stands on its own — for storing
 * beside the analysis and parsing at the point of use, which is what lets a result cached last
 * Tuesday be read by today's parser.
 *
 * Null when the marker is absent, and equally when nothing follows it: a model told to write
 * the marker and no records when the log names none does exactly that, and storing a lone
 * marker would have the card reporting an answer it does not have.
 */
export function failuresBlock(reply: string): string | null {
  const at = reply.indexOf(FAILURES_MARKER);
  if (at === -1) return null;
  const block = reply.slice(at).trim();
  return block.length > FAILURES_MARKER.length ? block : null;
}

/** Hard ceiling on records kept, so a runaway reply can't fill the pane or the cache. */
const MAX_ITEMS = 300;
/** Messages are meant to be one decisive line; anything longer is a pasted stack trace. */
const MAX_MESSAGE_CHARS = 400;
const MAX_HEADLINE_CHARS = 300;

/**
 * Vocabulary a model might use, mapped onto our kinds.
 *
 * Loose because the label is cosmetic — it colours a chip and nothing branches on it — so
 * guessing wrong is cheap, while insisting on exact words would throw away a good record.
 * Anything unrecognised lands on `failure`, which is always true.
 */
const KIND_WORDS: Record<string, FailureItemKind> = {
  test: 'test',
  testcase: 'test',
  spec: 'test',
  assert: 'assertion',
  assertion: 'assertion',
  assertionerror: 'assertion',
  comparison: 'assertion',
  diff: 'assertion',
  error: 'error',
  exception: 'error',
  runtime: 'error',
  compile: 'compile',
  compilation: 'compile',
  build: 'compile',
  syntax: 'compile',
  typeerror: 'compile',
  timeout: 'timeout',
  timedout: 'timeout',
  hang: 'timeout',
  crash: 'crash',
  segfault: 'crash',
  oom: 'crash',
  outofmemory: 'crash',
  infra: 'infrastructure',
  infrastructure: 'infrastructure',
  runner: 'infrastructure',
  network: 'infrastructure',
  disk: 'infrastructure',
  ratelimit: 'infrastructure',
  auth: 'infrastructure',
  dependency: 'dependency',
  dependencies: 'dependency',
  download: 'dependency',
  registry: 'dependency',
  lint: 'lint',
  style: 'lint',
  format: 'lint',
  skipped: 'skipped',
  ignored: 'skipped',
  failure: 'failure',
  failed: 'failure',
};

function normalizeKind(raw: string | undefined): FailureItemKind {
  if (!raw) return 'failure';
  const word = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  return KIND_WORDS[word] ?? 'failure';
}

/** `- key: value`, `key: value`, `**key**: value` — all the same record field. */
const FIELD_RE = /^\s*(?:[-*+]\s*)?\*{0,2}([A-Za-z][A-Za-z ]{0,20})\*{0,2}\s*:\s*(.*)$/;

interface Draft {
  what?: string;
  kind?: string;
  group?: string;
  where?: string;
  message?: string;
}

/**
 * Which key names map onto which field.
 *
 * The synonyms are not politeness: the brief names five keys, and a model that has just read
 * a JUnit XML reaches for `classname`, one that read a compiler's output reaches for `file`.
 * Accepting both costs a table entry and saves a re-run. Resolving the alias *before* looking
 * for a repeat is what lets `class:` end a record that already has a `group:`.
 */
const FIELD_ALIASES: Record<string, keyof Draft> = {
  what: 'what',
  test: 'what',
  name: 'what',
  case: 'what',
  method: 'what',
  item: 'what',
  step: 'what',
  kind: 'kind',
  type: 'kind',
  group: 'group',
  suite: 'group',
  class: 'group',
  classname: 'group',
  file: 'group',
  phase: 'group',
  where: 'where',
  at: 'where',
  location: 'where',
  message: 'message',
  detail: 'message',
  assertion: 'message',
  error: 'message',
  output: 'message',
};

/** Strip the decoration a model puts around a value: backticks, quotes, bold. */
function clean(value: string): string {
  return value
    .trim()
    .replace(/^\*{1,2}(.*)\*{1,2}$/s, '$1')
    .replace(/^`(.*)`$/s, '$1')
    .trim();
}

function toCount(value: string): number | null {
  const n = Number.parseInt(clean(value).replace(/[,\s]/g, ''), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A placeholder a model writes when it has no value, which must not become content. */
function isPlaceholder(value: string): boolean {
  return /^(?:n\/?a|none|unknown|-|\?)$/i.test(value);
}

function toItem(draft: Draft): FailureItem | null {
  const what = draft.what ? clean(draft.what) : '';
  if (!what) return null;
  const group = draft.group ? clean(draft.group) : '';
  const where = draft.where ? clean(draft.where) : '';
  const message = draft.message ? clean(draft.message).slice(0, MAX_MESSAGE_CHARS) : '';
  return {
    what,
    kind: normalizeKind(draft.kind),
    group: group && !isPlaceholder(group) ? group : null,
    // A model asked for a field it hasn't got tends to answer "n/a" rather than leaving the
    // line out, and "unknown" in a bug report reads as a location rather than an absence.
    where: where && !isPlaceholder(where) ? where : null,
    message: message && !isPlaceholder(message) ? message : null,
  };
}

/**
 * Read the model's reply.
 *
 * Returns null when the reply carries neither a cause nor a single item — which means the run
 * answered a different question than the one asked, and an empty "0 things failed" panel would
 * report that as a fact about the job rather than about the reply.
 */
export function parseFailureCause(reply: string): FailureCause | null {
  // Everything before the marker is preamble the brief asked for and didn't get. Dropping it
  // matters: a chatty opening sentence containing a colon would be read as a header field.
  const at = reply.indexOf(FAILURES_MARKER);
  const body = at === -1 ? reply : reply.slice(at + FAILURES_MARKER.length);

  const items: FailureItem[] = [];
  let headline: string | null = null;
  let source: string | null = null;
  let total: number | null = null;
  let note: string | null = null;
  let draft: Draft | null = null;

  const flush = () => {
    if (!draft) return;
    const item = toItem(draft);
    if (item && items.length < MAX_ITEMS) items.push(item);
    draft = null;
  };

  for (const line of body.split(/\r?\n/)) {
    // A fence around the records is harmless and common; the records inside it are what we
    // are reading, so the fence itself is simply skipped.
    if (/^\s*```/.test(line)) continue;

    const field = FIELD_RE.exec(line);
    const key = field ? field[1].trim().toLowerCase().replace(/\s+/g, '') : null;

    // The header fields, which belong to the answer rather than to any one item. Checked
    // before the record aliases so `cause:` cannot be mistaken for an item's field.
    switch (key) {
      case 'cause':
      case 'summary':
      case 'headline':
        headline = clean(field![2]).slice(0, MAX_HEADLINE_CHARS) || headline;
        continue;
      case 'source':
      case 'from':
        // Backticks stripped throughout, not only at the ends: this is shown as a chip, and
        // "JUnit XML from artifact `x`" is the shape a model actually writes.
        source = clean(field![2]).replace(/`/g, '') || source;
        continue;
      case 'failed':
      case 'total':
      case 'count':
      case 'totalfailed':
        total = toCount(field![2]) ?? total;
        continue;
      case 'note':
      case 'notes':
        note = clean(field![2]) || note;
        continue;
      default:
        break;
    }

    const target = key ? FIELD_ALIASES[key] : undefined;
    if (!target) {
      /*
       * Not a field this parser knows — which is most often a **wrapped message**, and the
       * reason an unrecognised `key: value` line is treated the same as an unkeyed one. An
       * assertion diff wraps as "but was: <41>", which parses as a field named "butwas" and
       * would otherwise be dropped: precisely the half of the comparison a reader needs. A
       * blank line ends the record; a heading or a quote is left alone.
       */
      const text = line.trim();
      if (draft?.message && text && !/^[#>]/.test(text)) draft.message += ` ${text}`;
      else if (!text) flush();
      continue;
    }
    // A field that repeats starts the next record. This is what separates two records written
    // without a blank line between them, which is most of them in practice.
    if (draft && target in draft) flush();
    draft = { ...(draft ?? {}), [target]: field![2] };
  }
  flush();

  if (!headline && items.length === 0) return null;
  return {
    headline,
    items,
    source,
    // Never report fewer than were listed: a model that miscounts its own list must not make
    // a complete list look partial in the other direction.
    total: total !== null && total >= items.length ? total : null,
    note,
  };
}

/** The items grouped under whatever they belong to, in first-seen order. */
export function groupItems(
  items: readonly FailureItem[],
): { group: string | null; items: FailureItem[] }[] {
  const groups: { group: string | null; items: FailureItem[] }[] = [];
  for (const item of items) {
    const existing = groups.find((g) => g.group === item.group);
    if (existing) existing.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }
  return groups;
}

/**
 * How many things failed, as well as the answer can say — the model's own total when it
 * listed fewer than it found, otherwise the length of the list.
 */
export function failureItemCount(cause: FailureCause): number {
  return cause.total ?? cause.items.length;
}

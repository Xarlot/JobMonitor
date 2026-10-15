/**
 * The brief that drafts a reply to a review comment, and the parser that cleans what comes back.
 *
 * The material is the thread itself — the diff hunk it was left on and the conversation so far —
 * which the app has already read, so this is one turn with no tools, the same shape as the pull
 * request write-up. The model sees exactly what the person replying sees.
 *
 * The result is a **draft**. It lands in an editable box and is posted only when the user presses
 * the button, because a reply goes out under the user's own name. The rules below exist for the
 * same reason: the model has no idea whether a fix was pushed, so it must never say one was.
 */

import type { ReviewThread } from '../api/reviewThreads';

/** Long hunks are cut from the top: the commented line is at the bottom of the hunk. */
const MAX_HUNK_LINES = 60;
/** Characters per comment; a review comment longer than this is an essay, and the gist is up top. */
const MAX_COMMENT_CHARS = 4_000;

const OUTPUT_CONTRACT = `Reply with the text of the comment only — no preamble, no sign-off, no quotation of the reviewer, no code fence around the whole reply.

Rules:
- You are replying as the author of the pull request. Be direct and brief: one to four sentences, or a short code suggestion if the reviewer asked for one.
- If the reviewer is right, agree and say what will change. If they are mistaken, explain why from the code shown, politely. If the comment is a question, answer it from the code shown. If you cannot tell, ask one precise question back.
- Never claim a change has already been made, pushed or tested. You cannot know that.
- Never invent an issue number, a URL, a commit SHA, a file path or a person's handle. No @mentions.
- Plain GitHub Markdown. Backticks for code. No headings, no tables.
- Do not thank the reviewer for the review, and do not apologise.`;

export interface ReviewReplyContext {
  repoSlug: string;
  prNumber: number;
  prTitle: string;
  thread: ReviewThread;
  /** The comment the user clicked, which the reply should answer. Defaults to the last one. */
  commentId?: string;
  /** The user's standing instructions from settings, appended verbatim. */
  extraInstructions?: string;
  /** Replaces the built-in brief entirely when non-empty. */
  promptOverride?: string;
}

function trimHunk(hunk: string): string {
  const lines = hunk.split('\n');
  if (lines.length <= MAX_HUNK_LINES) return hunk;
  return ['…', ...lines.slice(-MAX_HUNK_LINES)].join('\n');
}

function trimComment(body: string): string {
  return body.length <= MAX_COMMENT_CHARS ? body : `${body.slice(0, MAX_COMMENT_CHARS)}…`;
}

export function buildReviewReplyPrompt(context: ReviewReplyContext): string {
  const { thread, repoSlug, prNumber, prTitle } = context;
  const focus =
    thread.comments.find((c) => c.id === context.commentId) ?? thread.comments[thread.comments.length - 1] ?? null;

  const intro =
    context.promptOverride?.trim() ||
    `You are drafting a reply to a code review comment on pull request #${prNumber} ("${prTitle}") in ${repoSlug}.

You are given the code the comment was left on and the conversation so far. That is all the evidence there is; you have no tools and cannot look anything up.

${OUTPUT_CONTRACT}`;

  const where = thread.line != null ? `${thread.path}:${thread.line}` : thread.path;
  const parts = [intro, '', `File: ${where}${thread.isOutdated ? ' (the code has changed since)' : ''}`];
  if (thread.diffHunk.trim()) {
    parts.push('', 'Code under discussion (diff hunk; the comment is on its last line):', '```diff', trimHunk(thread.diffHunk), '```');
  }
  parts.push('', 'Conversation, oldest first:');
  for (const c of thread.comments) {
    const marker = focus && c.id === focus.id ? ' ← reply to this one' : '';
    parts.push('', `--- ${c.author?.login ?? 'ghost'}${marker}`, trimComment(c.body));
  }
  if (thread.commentsTruncated) parts.push('', '(later comments omitted)');

  const extra = context.extraInstructions?.trim();
  if (extra) parts.push('', 'Additional instructions from the user:', extra);

  return parts.join('\n');
}

/**
 * Clean a model reply into a comment body.
 *
 * Strips a fence around the whole reply (models add one despite being told not to). @mentions
 * are defused rather than removed, so the sentence still reads but nobody is notified by a
 * handle the model chose. Closing keywords are left alone: GitHub acts on them only in a pull
 * request's description and in commit messages, never in a review comment.
 */
export function parseReviewReply(reply: string): string {
  let text = reply.trim();
  const fenced = text.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/(^|[\s(])@([A-Za-z0-9-]+)/g, '$1`@$2`');
  return text.trim();
}

// ── The note that goes with resolving a conversation ────────────────────────────────────────────

/**
 * What Claude concluded about a conversation before writing the note. `unaddressed` is the one
 * the UI warns on: the note still says what is missing, and the user decides whether to resolve.
 */
export type ResolveVerdict = 'addressed' | 'obsolete' | 'settled' | 'unaddressed';
const VERDICTS: readonly ResolveVerdict[] = ['addressed', 'obsolete', 'settled', 'unaddressed'];

/** The file as it is now at the PR head: an excerpt, gone, or not read. */
export type CurrentCode =
  | { kind: 'excerpt'; text: string }
  | { kind: 'deleted' }
  | { kind: 'unavailable' };

/** Lines either side of the commented one. Enough for the surrounding method, not the file. */
const EXCERPT_RADIUS = 40;

/**
 * The current file around `line`, numbered. The line is the thread's — for an outdated thread
 * the original one, which may have moved — so the window is wide, and a short file goes whole.
 */
export function codeExcerpt(file: string, line: number | null, radius = EXCERPT_RADIUS): string {
  const lines = file.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const centre = line != null && line >= 1 ? Math.min(line, lines.length) : 1;
  const whole = lines.length <= radius * 2 + 1;
  const from = whole ? 1 : Math.max(1, centre - radius);
  const to = whole ? lines.length : Math.min(lines.length, centre + radius);
  const width = String(to).length;
  const out: string[] = [];
  if (from > 1) out.push('…');
  for (let n = from; n <= to; n++) out.push(`${String(n).padStart(width)}| ${lines[n - 1]}`);
  if (to < lines.length) out.push('…');
  return out.join('\n');
}

const RESOLVE_CONTRACT = `First decide which of these is true, from the evidence shown only:
- addressed: the current code does what the reviewer asked for.
- obsolete: the code the comment was about is gone or rewritten, so the comment no longer applies.
- settled: the conversation itself reached a conclusion — a question answered, a suggestion declined with a reason nobody disputed.
- unaddressed: none of the above, or you cannot tell.

Answer in exactly this shape:
VERDICT: <addressed|obsolete|settled|unaddressed>

<the note>

The note:
- One to three sentences, written as the author of the pull request to the reviewer.
- Say concretely why the conversation can be closed: what in the current code does what was asked (name the identifier or the line), why the comment no longer applies, or what the conversation concluded.
- If the verdict is unaddressed, say plainly what is still missing. The user decides whether to resolve anyway.
- Never claim anything the code shown does not show. Never invent an issue number, a URL, a commit SHA, a file path or a person's handle. No @mentions.
- Plain GitHub Markdown, backticks for code. No headings, no tables, no thanks, no apologies.`;

export interface ResolveNoteContext extends ReviewReplyContext {
  currentCode: CurrentCode;
}

export function buildResolveNotePrompt(context: ResolveNoteContext): string {
  const { thread, repoSlug, prNumber, prTitle, currentCode } = context;
  const intro =
    context.promptOverride?.trim() ||
    `You are writing the note that goes with resolving a code review conversation on pull request #${prNumber} ("${prTitle}") in ${repoSlug}. The author of the pull request is closing the conversation, and the note tells the reviewer why.

You are given the code the comment was left on, the conversation, and the same file as it is now at the head of the pull request. That is all the evidence there is; you have no tools and cannot look anything up.

${RESOLVE_CONTRACT}`;

  const where = thread.line != null ? `${thread.path}:${thread.line}` : thread.path;
  const parts = [
    intro,
    '',
    `File: ${where}${thread.isOutdated ? ' (GitHub marks this conversation outdated: the lines it was on have changed since)' : ''}`,
  ];
  if (thread.diffHunk.trim()) {
    parts.push('', 'Code when the comment was left (diff hunk; the comment is on its last line):', '```diff', trimHunk(thread.diffHunk), '```');
  }
  parts.push('', 'Conversation, oldest first:');
  for (const c of thread.comments) parts.push('', `--- ${c.author?.login ?? 'ghost'}`, trimComment(c.body));
  if (thread.commentsTruncated) parts.push('', '(later comments omitted)');

  parts.push('');
  if (currentCode.kind === 'excerpt') {
    parts.push(`The same file now, at the head of the pull request (line numbers on the left):`, '```', currentCode.text, '```');
  } else if (currentCode.kind === 'deleted') {
    parts.push(`The file ${thread.path} no longer exists at the head of the pull request.`);
  } else {
    parts.push('The current version of the file could not be read; judge from the conversation alone.');
  }

  const extra = context.extraInstructions?.trim();
  if (extra) parts.push('', 'Additional instructions from the user:', extra);
  return parts.join('\n');
}

/**
 * Split a reply into its verdict and the note. A reply without a recognisable verdict line is
 * all note, with `verdict: null` — the UI then shows no verdict rather than guessing one.
 */
export function parseResolveNote(reply: string): { verdict: ResolveVerdict | null; text: string } {
  const m = reply.trim().match(/^\**VERDICT\**:?\**\s*\**([a-z]+)\**[^\n]*(?:\n|$)/i);
  const word = m?.[1].toLowerCase() as ResolveVerdict | undefined;
  if (!m || !word || !VERDICTS.includes(word)) return { verdict: null, text: parseReviewReply(reply) };
  return { verdict: word, text: parseReviewReply(reply.trim().slice(m[0].length)) };
}

// ── Improving what the user typed ───────────────────────────────────────────────────────────────

export interface ImproveReplyContext extends ReviewReplyContext {
  /** What the user wrote — the content to keep. */
  draft: string;
  /** How they want it changed ("shorter", "more polite", "mention the null check"). Optional. */
  instruction?: string;
  /** The text goes out with the conversation being resolved. */
  resolving: boolean;
}

/**
 * Rewrite the user's own reply. Their draft is the content; the model fixes wording, grammar
 * and tone and follows the instruction, but adds no claims of its own — the reply is theirs.
 */
export function buildImproveReplyPrompt(context: ImproveReplyContext): string {
  const { thread, repoSlug, prNumber, prTitle } = context;
  const where = thread.line != null ? `${thread.path}:${thread.line}` : thread.path;
  const parts = [
    `You are improving a reply the author of pull request #${prNumber} ("${prTitle}") in ${repoSlug} wrote to a code review conversation${
      context.resolving ? ', posted as they resolve the conversation' : ''
    }.

Rewrite their draft so it reads well: clear, direct, correct English (or the language the draft is in), polite but not effusive. Keep its meaning and every fact in it. Do not add facts, promises or claims the draft does not make. Follow the user's instruction if there is one.

Reply with the rewritten text only — no preamble, no quotation marks, no code fence around the whole reply. Plain GitHub Markdown, backticks for code. No @mentions, no thanks, no apologies.`,
    '',
    `File: ${where}`,
    '',
    'Conversation, oldest first:',
  ];
  for (const c of thread.comments) parts.push('', `--- ${c.author?.login ?? 'ghost'}`, trimComment(c.body));
  parts.push('', 'The draft to improve:', '"""', context.draft.trim(), '"""');
  const instruction = context.instruction?.trim();
  if (instruction) parts.push('', 'How the user wants it changed:', instruction);
  const extra = context.extraInstructions?.trim();
  if (extra) parts.push('', 'Additional instructions from the user:', extra);
  return parts.join('\n');
}

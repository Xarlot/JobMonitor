/**
 * The brief that turns a branch's commits into a pull request's title and description,
 * and the fallback for when nothing is there to write one.
 *
 * The material is fetched by the app, not by the model: the commit subjects and the
 * changed-file list are already in hand from `compare`, so the task is one turn of
 * summarising supplied text rather than an investigation. That is why it needs no tools,
 * and why it can be cheap enough to run on a click without anyone thinking about it.
 *
 * As with the failure brief, the model writes **prose only**. It is told in as many words
 * not to invent issue numbers or handles, and the parser strips them anyway — a
 * hallucinated `Fixes #123` closes a real issue the moment the pull request merges, which
 * is a consequence outside this app's power to undo.
 */

import type { Comparison } from '../api/types';
import { BODY_MARKER, TITLE_MARKER, type ChangeSummary } from './featureBranch';

/** How many commit subjects to show the model. Past this it is describing a release. */
const MAX_SUBJECTS = 60;
/** How many changed files to list. Enough to see the shape of a change. */
const MAX_FILES = 40;

/**
 * Reduce a comparison to the parts worth spending prompt on.
 *
 * Commits come back **newest first**, which is the opposite of GitHub's order and
 * deliberate: the list is capped, and on a long-running branch the recent work is what the
 * pull request is about. Keeping the oldest sixty of four hundred would describe how the
 * branch started and miss what it became. Everything that consumes this — the prompt header
 * and the template body — has to say so rather than imply chronological order.
 */
export function summariseComparison(comparison: Comparison): ChangeSummary {
  return {
    subjects: comparison.commits
      .map((c) => c.commit.message.split('\n')[0]?.trim() ?? '')
      .filter(Boolean)
      .reverse()
      .slice(0, MAX_SUBJECTS),
    totalCommits: comparison.total_commits,
    files: (comparison.files ?? []).map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
    })),
    // GitHub stops at 300 files and omits the array past the first page of commits.
    filesTruncated: (comparison.files?.length ?? 0) >= 300,
  };
}

const OUTPUT_CONTRACT = `Reply with exactly two sections, introduced by these markers on their own lines, and nothing else — no preamble, no sign-off, no code fence around the markers:

${TITLE_MARKER}
One line. Under 80 characters. Say what the change does, in the imperative — "Add retry to the artifact download", not "This PR adds…". No branch name, no issue number, no prefix like "feat:" unless the commit subjects consistently use one.

${BODY_MARKER}
A short description for a reviewer who has not followed this branch. Two to five sentences, or a handful of bullets if the work splits into genuinely separate parts. Lead with what changed and why; mention anything a reviewer should look at closely. Do not restate the commit list — it is already on the pull request — and do not describe the process of making the change.

Rules:
- Never invent an issue number, a URL, a commit SHA, a person's handle or a file path. Everything you state must come from the material below. If you cannot tell why a change was made, describe what it does and stop.
- **Do not guess from the branch name, and do not write about the material itself.** If the commits and files below do not tell you enough to describe the change, leave the description section empty rather than filling it. "No commit information was provided, so specifics cannot be confirmed — a reviewer should check the diff" is worse than nothing: it takes up the space a reader scans and tells them less than a blank body would. Never speculate about what a change "appears to relate to".
- Write what the change does, never what you were able to work out. Nothing about your own confidence, the evidence available to you, or what someone should check.
- No "Fixes #…", "Closes #…" or any other closing keyword. You cannot know which issue this belongs to, and a wrong one closes somebody's issue on merge.
- No @mentions.
- Plain Markdown: no headings, no tables, no HTML. Backticks for code and short bullet lists are fine.
- Write plainly. Do not pad, do not editorialise, and do not claim the change is an improvement unless the material says what it improves.`;

export interface ComposeContext {
  branch: string;
  baseBranch: string;
  repoSlug: string;
  summary: ChangeSummary;
  /** The user's standing instructions from settings, appended verbatim. */
  extraInstructions?: string;
  /** Replaces the built-in brief entirely when non-empty. */
  promptOverride?: string;
}

/** Files as a compact list; the numbers show where the weight of the change is. */
function fileLines(summary: ChangeSummary): string[] {
  const shown = summary.files.slice(0, MAX_FILES);
  const lines = shown.map((f) => `  ${f.filename} (+${f.additions} −${f.deletions})`);
  if (summary.files.length > shown.length) {
    lines.push(`  …and ${summary.files.length - shown.length} more files`);
  }
  return lines;
}

export function buildComposePrompt(context: ComposeContext): string {
  const { branch, baseBranch, repoSlug, summary } = context;

  const intro =
    context.promptOverride?.trim() ||
    `You are writing the title and description of a pull request that merges the branch \`${branch}\` into \`${baseBranch}\` in ${repoSlug}.

You are given the commit subjects on the branch and the files it touches. That is all the evidence there is; you have no tools and cannot look anything up.

${OUTPUT_CONTRACT}`;

  // "Newest first", because that is what summariseComparison produces. Saying "oldest
  // first" over a reversed list makes the model read the branch's chronology backwards
  // when it decides what the change builds towards.
  const parts = [intro, '', `Commits (${summary.totalCommits} in total, newest first):`];
  if (summary.subjects.length === 0) {
    parts.push('  (none listed)');
  } else {
    for (const subject of summary.subjects) parts.push(`  ${subject}`);
    if (summary.totalCommits > summary.subjects.length) {
      parts.push(`  …and ${summary.totalCommits - summary.subjects.length} earlier commits`);
    }
  }

  parts.push('', `Files changed (${summary.files.length}${summary.filesTruncated ? '+' : ''}):`);
  const files = fileLines(summary);
  parts.push(files.length > 0 ? files.join('\n') : '  (none reported)');

  const extra = context.extraInstructions?.trim();
  if (extra) parts.push('', 'Additional instructions from the user:', extra);

  return parts.join('\n');
}

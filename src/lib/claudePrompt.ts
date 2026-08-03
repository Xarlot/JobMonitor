/**
 * The prompt that turns a failed CI job into something a developer can act on.
 *
 * Design decision worth knowing before editing: the model writes **prose only** —
 * the problem statement and the proposed fix. It does *not* write the report's
 * links, workflow names, commit SHAs or test list. Those are assembled by
 * `buildFailureReport` from data the app already fetched.
 *
 * The reason is bluntly practical: a bug report whose links are wrong is worse than
 * no bug report, and inventing plausible URLs and SHAs is exactly what a language
 * model does when the surrounding text calls for one. So the facts are supplied, and
 * the model is told in as many words not to make any up.
 *
 * The two prose parts come back separated by sentinel markers rather than as JSON:
 * the payload is multi-paragraph Markdown with backticks and newlines, which survives
 * a line-delimited split far more reliably than it survives being escaped into JSON
 * by a model.
 */

import type { Annotation } from '../api/types';
import { failureAnnotations } from './failureReport';
import type { FailureOrigin } from './failures';

export const PROBLEM_MARKER = '<<<PROBLEM>>>';
export const SOLUTION_MARKER = '<<<SOLUTION>>>';

/**
 * How hard to look.
 *
 * `quick` answers from the log that has already been fetched, with a one-minute budget
 * and no tools — for "what actually broke?" while you are still triaging. `deep` is the
 * agentic investigation: artifacts, the workflow file, the PR diff.
 */
/**
 * What to ask Claude for. Not strictly a "depth" any more — `log` is a different job
 * rather than a harder one — but it is the same pipeline (brief → CLI → cached result),
 * and the key it forms means the three results coexist per failure instead of
 * overwriting each other.
 */
export type ClaudeDepth = 'quick' | 'deep' | 'log' | 'blame';

/** What the model is allowed to know about the failure. */
export interface ClaudePromptInput {
  owner: string;
  repo: string;
  /** Actions run id, so the brief can name the exact commands to run. */
  runId: number | null;
  origin: FailureOrigin;
  jobName: string;
  failedStep: string | null;
  workflowFile: string | null;
  headRef: string;
  headSha: string;
  annotations: readonly Annotation[];
  /** Failed-step log text — the whole of it, trimmed by {@link trimLog}. */
  log: string;
  /**
   * Whether the CLI is being run with tools available. With tools it is briefed to go
   * and find the evidence; without, it can only reason over what is pasted in.
   */
  canInvestigate: boolean;
  depth: ClaudeDepth;
  /**
   * False when no log could be read at all, so the prompt says so instead of ending on
   * an empty log section. Undefined means a log is coming — the main process appends it.
   */
  hasLog?: boolean;
  /**
   * Replaces the built-in brief when non-empty. The facts, annotations, commands and log
   * are still appended and the output contract is still enforced — an override that
   * dropped those would yield a reply the app cannot parse.
   */
  promptOverride?: string;
  /** Standing context from settings, appended to whichever brief runs. */
  extraInstructions?: string;
}

/**
 * Ceiling on the log text handed to the model.
 *
 * A failed Actions log routinely runs to megabytes, most of it setup noise. The tail
 * holds the failure and the head holds what was being built, so both ends are kept
 * and the middle is dropped — cutting only the tail would lose the "what was this
 * even doing" context that makes the write-up readable.
 */
const MAX_LOG_CHARS = 60_000;
const HEAD_SHARE = 0.25;

export function trimLog(log: string, maxChars: number = MAX_LOG_CHARS): string {
  if (log.length <= maxChars) return log;
  const headChars = Math.floor(maxChars * HEAD_SHARE);
  const tailChars = maxChars - headChars;
  const dropped = log.length - maxChars;
  return [
    log.slice(0, headChars),
    `\n\n… ${dropped.toLocaleString('en-US')} characters omitted from the middle …\n\n`,
    log.slice(log.length - tailChars),
  ].join('');
}

function originLines(origin: FailureOrigin): string[] {
  if (origin.kind === 'pr') {
    return [
      `Context: pull request #${origin.prNumber} — ${origin.prTitle}`,
      `Merge direction: into ${origin.baseRef}`,
      `Pull request state: ${origin.prState}`,
    ];
  }
  return [
    `Context: scheduled/tracked flow "${origin.flowName}"`,
    `Run number: ${origin.runNumber}`,
    `Triggered by: ${origin.event}`,
  ];
}

/** The reply contract, shared by both briefs. */
const OUTPUT_CONTRACT = `Reply with exactly two sections, introduced by these markers on their own lines, and nothing else — no preamble, no sign-off, no code fence around the markers:

${PROBLEM_MARKER}
What actually went wrong, in prose, for a developer who knows this codebase but has not seen this failure. Aim for 2–5 sentences. Name the failing test (or file, or step) and quote the decisive line — the assertion, the exception, the diff — verbatim in backticks. If several things failed, lead with the root cause and say the rest look like consequences of it. If the evidence points at infrastructure rather than the code — a runner dying, a network or registry timeout, disk exhaustion, a rate limit, a flaky external service — say so plainly, because that changes who should pick this up.

${SOLUTION_MARKER}
The most likely fix, as concrete as the evidence supports: which file and what change, or the exact command that reproduces it locally. Commit to one recommendation rather than listing possibilities. Where the evidence genuinely does not determine the cause, say what to check next and which extra output would settle it — do not guess a cause to have something to say.

Rules:
- **Put each sentence on its own line.** Write one statement per line rather than a flowing paragraph — the reader sees this streamed live and then in a bug report, and short lines are scannable where a wall of prose is not. Do not add blank lines between them.
- Never invent a URL, issue number, commit SHA, file path, test name or line number. Everything you state must come from the input below or from output you actually obtained. The report around your text already carries the verified links and metadata, so do not restate them.
- Plain Markdown that renders both in a GitHub issue and in a Microsoft Teams message: no HTML, no headings, no tables, no nested collapsible blocks. Backticks for code and short bullet lists are fine.
- Do not apologise and do not hedge every sentence — state what the evidence shows and mark genuine uncertainty once. Keep your process out of these two sections: narrate while you work, conclude here.`;

/**
 * The brief used when the CLI has tools.
 *
 * The point of this version: without it, the model answers from the workflow's summary
 * annotation, which for a test failure says little more than "the step failed" — and it
 * then quite correctly replies that there is not enough evidence to name a cause and
 * lists what it would need. It has the means to go and get all of that, so it is told to.
 *
 * The *procedure* lives in the `failure-triage` skill, which the bridge installs into the
 * run's working directory (see electron/failureTriageSkill.cjs). Keeping it there rather
 * than here means the same steps are available to a developer running `claude` by hand.
 * What stays in the brief is the contract, the narration rule, and the two constraints
 * that most change whether the answer is useful — repeated deliberately, because they are
 * the ones a model drifts from and the skill may fail to install.
 */
export const CLAUDE_INVESTIGATION_BRIEF = `You are triaging a failed GitHub Actions job so that a developer can act on it without opening the logs themselves.

**You have tools, and you are expected to use them.** The summary below is a starting point, not the evidence: a workflow's annotation for a failing test suite usually says nothing more than that the step failed. Go and get the real output. "There is not enough evidence to name a cause" is only an acceptable answer after you have actually tried, and then you must say what you tried and what stopped you.

**Follow the \`failure-triage\` skill.** It is installed in your working directory and holds the procedure: how far to look, when a neighbouring job is worth opening, what to do when a download fails, and when to stop. Use it. If it is not available, work through the exact commands under COMMANDS below, cheapest first, and stop as soon as you can name the failing test and quote its assertion.

Two things it is worth repeating here, because they decide whether the answer is useful:

- **Triage the job you were given, not the pull request.** Look at another job only when this one structurally cannot answer — an aggregator that failed because a \`needs:\` job did — and then say which job you ended up in.
- **Aim for two to four tool calls.** Stop when you can name the cause and quote the line that proves it. Reading everything first is not thoroughness; it is a slower answer of the same quality.

**Narrate as you go, in English.** Before each command, say in one short sentence what you are about to look at and why — "Pulling the run's artifacts to find the JUnit report." The developer watches this happen live in two panes: the commands themselves on top, and these sentences underneath. One sentence per step, plain English, no lists and no restating the command you are about to run. This is the only place you should describe your own process; the final answer below must not.

${OUTPUT_CONTRACT}`;

/**
 * The fast pass: name what broke, now.
 *
 * Explicitly time-boxed, and the bridge backs that up — no tools, a single turn, and a
 * short timeout — because "be quick" in a prompt is a request, not a guarantee. The
 * point of this mode is a first read while you are still deciding whether the failure
 * is even yours, so a thorough answer that arrives in three minutes is the wrong trade.
 */
export const CLAUDE_QUICK_BRIEF = `You are giving a developer a fast first read on a failed GitHub Actions job.

**Budget: about one minute.** Answer from the facts and log below — do not investigate, do not fetch anything, do not ask for more. If the log does not say what broke, say exactly that in one line and name the single most useful thing to look at next. A short answer now is the whole point; a thorough one later is what the deep analysis is for.

Keep it to a few lines. Name the failing test, file or step and quote the decisive line if it is there. Say whether this looks like a code failure or an infrastructure one — a runner dying, a timeout, a rate limit — because that decides who picks it up.

${OUTPUT_CONTRACT}`;

/** The brief used when no tools are available — reason over what was pasted in. */
/**
 * Rewrite the log so it can be read.
 *
 * A failed CI log is mostly setup noise around a few decisive lines, and finding them is
 * the tedious part of triage. This asks for the log *itself* back — reordered, trimmed and
 * annotated — rather than a verdict about it. Deliberately not a summary: the point is to
 * keep the reader looking at real log text, with the search already done.
 *
 * Colour is not asked for here. Highlighting is mechanical and is done locally
 * (`src/lib/logHighlight.ts`) — spending a model call on it would be slow, costly and
 * non-deterministic for something a regex settles.
 */
export const CLAUDE_LOG_BRIEF = `You are making a failed GitHub Actions log readable for a developer who has to fix it.

Return the **log itself**, cleaned up — not a report about it. Keep real log text; do not paraphrase lines into your own words.

Do this:
1. **Lead with what failed.** Put the decisive lines first: the failing test and its assertion, the exception and its message, the step that exited non-zero. Quote them exactly as they appear.
2. **Cut the noise.** Drop dependency downloads, cache hits, "Compiling…" chatter, progress bars, environment dumps and anything else that says nothing about the failure. Say how many lines you dropped.
3. **Keep the shape.** Group what remains under short \`##\` headings that name the phase it came from — the step name or the \`##[group]\` title — in the order they ran.
4. **Annotate sparingly.** After a line that needs it, add one short italic sentence explaining what it means. Only where a developer would otherwise have to guess; a log where every line is annotated is no easier to read than the original.
5. **Say what is missing.** If the log stops mid-run, or the real error is clearly in another job, say so at the end under \`## What this log does not show\`.

Format:
- Markdown. \`##\` for headings, fenced code blocks for log text, \`*italics*\` for your annotations.
- Put log lines in fenced blocks verbatim, including their indentation. Never invent a line, a path, a test name or a number that is not in the log.
- Write your annotations in English, one sentence each.
- No preamble and no closing summary. Start with the first heading.`;

/**
 * The blame pass: when did this start failing, and what caused it.
 *
 * Like the log task it returns a document rather than the two marked sections — a verdict,
 * a boundary, suspects and a flaky-test table do not fit "problem / suggested fix", and
 * forcing them into it would lose the structure that makes the answer usable.
 *
 * The procedure lives in the `flow-blame` skill. What stays here is the framing and the one
 * rule the model most needs held in front of it: rule out a flake and infrastructure before
 * naming anybody's commit.
 */
export const CLAUDE_BLAME_BRIEF = `You are working out **who broke a CI flow** — which commit, and which author — not why a single run failed.

Several commits often land between two runs of a flow. When they do, your job is to work out which of them is responsible from **what each one changed**, and to say how confident you are in each: a likelihood per candidate, justified by the evidence, never a number you cannot defend.

**Follow the \`flow-blame\` skill.** It is installed in your working directory and holds the procedure: how to find the boundary between the last good run and the first bad one, how to tell an intermittent failure from a consistent one, how to weigh several candidate commits against the failing test, how to gather flaky-test evidence from the merge-gated branches, and what the answer must contain.

The rule worth repeating outside it: **rule out a flaky test and an infrastructure failure before you name anyone.** On a branch that is only written through a merge gate, code has already passed this very workflow — so an unreliable test and a dead runner are both likelier than a bad commit, and attributing someone else's flake to a developer is the mistake that makes this feature worse than useless.

**Narrate as you go, in English.** Before each command, say in one short sentence what you are about to look at and why — "Listing the last 30 runs on main to find where it turned red." The developer watches this live in two panes: the commands on top, these sentences underneath. One sentence per step, no lists, and do not restate the command you are about to run.

Answer in Markdown, using the sections the skill specifies. No preamble — start with the first heading. Never invent a URL, a SHA, an author, a run number or a test name: everything you state comes from output you actually obtained.`;

export const CLAUDE_OFFLINE_BRIEF = `You are triaging a failed GitHub Actions job so that a developer can act on it without opening the logs themselves.

You have no tools on this run, so work only from the facts and the log below. If they do not determine the cause, say what to check next and which extra output would settle it.

${OUTPUT_CONTRACT}`;

/**
 * Exact commands for this failure, so the model runs the right thing instead of
 * reconstructing an owner/repo/run id from prose and getting one wrong.
 */
function commandLines(input: ClaudePromptInput): string[] {
  const slug = `${input.owner}/${input.repo}`;
  const lines: string[] = [];
  if (input.runId != null) {
    lines.push(`Raw failed-step log:  gh run view ${input.runId} --log-failed --repo ${slug}`);
    lines.push(`Full log (all steps): gh run view ${input.runId} --log --repo ${slug}`);
    lines.push(`List artifacts:       gh api repos/${slug}/actions/runs/${input.runId}/artifacts`);
    lines.push(
      `Download artifacts:   gh run download ${input.runId} --repo ${slug} --dir ./artifacts`,
    );
    lines.push(`Job list + steps:     gh run view ${input.runId} --repo ${slug} --json jobs`);
  }
  if (input.workflowFile) {
    lines.push(
      `Workflow source:      gh api repos/${slug}/contents/.github/workflows/${input.workflowFile}` +
        `?ref=${input.headSha} --jq .content | base64 -d`,
    );
  }
  if (input.origin.kind === 'pr') {
    lines.push(`What the PR changed:  gh pr diff ${input.origin.prNumber} --repo ${slug}`);
    lines.push(`Files it touches:     gh pr view ${input.origin.prNumber} --repo ${slug} --json files`);
  }
  lines.push(
    `Any file at this commit: gh api repos/${slug}/contents/<PATH>?ref=${input.headSha} --jq .content | base64 -d`,
  );
  return lines;
}

/** Assemble the full prompt: instructions, then the verified facts, then the log. */
/**
 * What to send when picking an unfinished run back up.
 *
 * Short on purpose: `--resume` replays the whole prior conversation, so the facts, the log
 * and the brief are all still there. Re-sending them would cost context and invite the
 * model to start the investigation over — the one thing continuing is meant to avoid.
 */
export const CLAUDE_RESUME_PROMPT = `You were interrupted by a time limit — you were not asked to wrap up. **You now have a full fresh budget, so continue the investigation from exactly where it stopped.**

Pick up the next thing you said you were about to do and do it. Everything you already established still stands: do not repeat work, do not re-summarise what you have found, do not start over.

**Do not conclude early just because you were interrupted.** If you were missing a piece of evidence — a patch you had not read, an artifact you had not fetched, a history you had not checked — go and get it now. Declining to reach a verdict because you ran out of time the first time is the one outcome this continuation exists to prevent: an unread diff is not an unknowable one.

Write the final answer only once the evidence is actually in. If you run short again, say specifically what is still outstanding and what it would settle — not that you lacked time.`;

export function buildClaudePrompt(input: ClaudePromptInput): string {
  const failures = failureAnnotations(input.annotations);
  const facts = [
    `Repository: ${input.owner}/${input.repo}`,
    ...originLines(input.origin),
    `Branch: ${input.headRef || '(unknown)'}`,
    `Commit: ${input.headSha}`,
    input.workflowFile ? `Workflow file: ${input.workflowFile}` : null,
    `Failed job: ${input.jobName}`,
    input.failedStep ? `Failed step: ${input.failedStep}` : null,
  ].filter(Boolean);

  const annotationBlock =
    failures.length > 0
      ? failures
          .map((a) => {
            const where = a.path ? `${a.path}${a.start_line ? `:${a.start_line}` : ''}` : 'unknown';
            const what = [a.title, a.message].filter(Boolean).join(' — ');
            return `- ${where}: ${what}`;
          })
          .join('\n')
      : '(GitHub reported no failure annotations for this job.)';

  const builtIn =
    input.depth === 'log'
      ? CLAUDE_LOG_BRIEF
      : input.depth === 'blame'
        ? CLAUDE_BLAME_BRIEF
        : input.depth === 'quick'
          ? CLAUDE_QUICK_BRIEF
          : input.canInvestigate
            ? CLAUDE_INVESTIGATION_BRIEF
            : CLAUDE_OFFLINE_BRIEF;

  // A custom brief replaces the wording, never the contract: the markers are re-stated
  // after it so a well-meaning override can't produce a reply that fails to parse. The
  // log task returns a document instead, so it has no contract to restate.
  // The log and blame tasks return whole documents, so there is no marker contract to
  // restate after an override — imposing one would ask for sections they do not produce.
  const returnsDocument = input.depth === 'log' || input.depth === 'blame';
  const brief = input.promptOverride?.trim()
    ? returnsDocument
      ? input.promptOverride.trim()
      : `${input.promptOverride.trim()}\n\n${OUTPUT_CONTRACT}`
    : builtIn;

  const extra = input.extraInstructions?.trim();

  return [
    brief,
    ...(extra ? ['', '--- ADDITIONAL INSTRUCTIONS FROM THE USER ---', extra] : []),
    '',
    '--- FAILURE FACTS ---',
    facts.join('\n'),
    '',
    '--- REPORTED FAILURES (from the check-run annotations) ---',
    annotationBlock,
    ...((input.depth === 'deep' || input.depth === 'blame') && input.canInvestigate
      ? ['', '--- COMMANDS ---', ...commandLines(input)]
      : []),
    '',
    // Said explicitly rather than left as an empty section: a bare header with nothing
    // under it invites the model to treat the absence as its own failure to look, or to
    // describe a log it never saw. Some check runs simply have no job log to fetch.
    ...(input.hasLog === false
      ? [
          '--- LOG ---',
          'No log could be read for this job, so there is none below. Work from the reported failures above and say plainly that you had no log — do not describe log contents you were not given.',
        ]
      : [
          input.depth === 'deep'
            ? '--- LOG OF THE FAILED STEP(S), ALREADY FETCHED (start here, then dig deeper) ---'
            : input.depth === 'log'
              ? '--- LOG TO REWRITE ---'
              : input.depth === 'blame'
                ? '--- LOG OF THE RUN YOU WERE ASKED ABOUT (context; the history matters more) ---'
                : '--- LOG OF THE FAILED STEP(S) ---',
          trimLog(input.log),
        ]),
  ].join('\n');
}

/**
 * Abbreviations that end in a full stop without ending a sentence. Without these,
 * "e.g. Foo" and "vs. Bar" would each be split in two.
 */
const ABBREVIATIONS = [
  'e.g.',
  'i.e.',
  'etc.',
  'cf.',
  'vs.',
  'approx.',
  'no.',
  'fig.',
  'al.',
  'resp.',
];

/** Lines that carry their own structure and must not be broken up. */
function isStructuralLine(line: string): boolean {
  return /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/.test(line);
}

/**
 * Put each sentence on its own line.
 *
 * The brief asks the model for this directly, but the streamed text is shown live and a
 * single run-on paragraph is unreadable — so the output is normalised too rather than
 * trusting compliance. Applied to what is displayed *and* to what the report carries,
 * so the preview and the copied text stay identical.
 *
 * Deliberately conservative. It only breaks after `.`/`!`/`?` followed by whitespace
 * and something that looks like a new sentence, and it leaves alone:
 *  - text inside backticks, so `a.b()` and log fragments survive;
 *  - version numbers and decimals, which have no space after the dot;
 *  - the abbreviations above;
 *  - bullets, numbered items, headings and quotes, whose prefix only applies to the
 *    first line.
 */
export function splitIntoSentenceLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (isStructuralLine(line) ? line : splitLine(line)))
    .join('\n');
}

function splitLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let inCode = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    current += char;
    if (char === '`') {
      inCode = !inCode;
      continue;
    }
    if (inCode || !'.!?'.includes(char)) continue;

    // Consume the run of closing punctuation/quotes that belongs to this sentence.
    let end = i + 1;
    while (end < line.length && '"\')]}»”’*_'.includes(line[end])) {
      current += line[end];
      end += 1;
    }
    const rest = line.slice(end);
    if (!/^\s/.test(rest)) {
      i = end - 1;
      continue;
    }
    const next = rest.trimStart();
    // A new sentence starts with a capital, a digit, or Markdown/code punctuation.
    if (!/^[A-ZÀ-ÖØ-Þ0-9`*_[(]/.test(next)) {
      i = end - 1;
      continue;
    }
    const lower = current.toLowerCase();
    if (ABBREVIATIONS.some((abbr) => lower.endsWith(abbr))) {
      i = end - 1;
      continue;
    }

    out.push(current.trim());
    current = '';
    i = end - 1 + (rest.length - next.length);
  }

  if (current.trim()) out.push(current.trim());
  return out.join('\n');
}

export interface ClaudeAnalysis {
  problem: string;
  solution: string;
}

/**
 * Split the model's reply on the markers.
 *
 * Tolerant on purpose: a model that ignores the "nothing else" instruction and adds a
 * preamble, or emits only one section, should still yield something usable rather than
 * throwing away a slow and costly call. Returns null only when neither marker appears,
 * which means the output bears no relation to what was asked for.
 */
export function parseClaudeAnalysis(reply: string): ClaudeAnalysis | null {
  const problemAt = reply.indexOf(PROBLEM_MARKER);
  const solutionAt = reply.indexOf(SOLUTION_MARKER);
  if (problemAt === -1 && solutionAt === -1) return null;

  const problem =
    problemAt === -1
      ? ''
      : reply
          .slice(problemAt + PROBLEM_MARKER.length, solutionAt === -1 ? undefined : solutionAt)
          .trim();
  const solution = solutionAt === -1 ? '' : reply.slice(solutionAt + SOLUTION_MARKER.length).trim();

  if (!problem && !solution) return null;
  return {
    problem: splitIntoSentenceLines(problem),
    solution: splitIntoSentenceLines(solution),
  };
}

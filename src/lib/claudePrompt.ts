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
import { FAILURES_MARKER } from './failureCause';
import { highlightLogLine, type LogLineKind } from './logHighlight';
import { failureAnnotations } from './failureReport';
import type { FailureOrigin } from './failures';
import { MARKS_MARKER } from './logMarks';

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
export type ClaudeDepth = 'quick' | 'deep' | 'log' | 'blame' | 'cause' | 'marks';

/**
 * Which tasks answer with a whole document rather than the two marked sections.
 *
 * Asked as a function because three places have to agree about it — the prompt builder (a
 * document task has no marker contract to restate after a custom prompt), the hook (which
 * would otherwise run the reply through the marker parser and reject every one), and the
 * dialog. When they disagreed, adding a task produced a run that succeeded and then reported
 * "Claude's reply didn't contain the expected sections".
 *
 * The two data tasks count as documents: their replies are records rather than prose, parsed
 * by `parseFailureCause` and `parseLogMarks` at the point of use. Storing the reply verbatim is
 * what lets a week-old cached result be re-parsed by newer code — and re-anchored against a
 * different log, which is the trick the marker stripe depends on.
 */
export function returnsDocument(depth: ClaudeDepth): boolean {
  return depth === 'log' || depth === 'blame' || depth === 'cause' || depth === 'marks';
}

/**
 * Which prose task is also asked for the `<<<FAILURES>>>` records.
 *
 * A function beside {@link returnsDocument} for the same reason: the brief, the custom-prompt
 * path and the test all have to agree about which contract a task is held to, and a boolean
 * spelt out in three places drifts.
 */
export function returnsFailureRecords(depth: ClaudeDepth): boolean {
  return depth === 'quick';
}

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

/**
 * How much of the budget is held back for lines rescued out of the dropped middle.
 *
 * "The tail holds the failure" is true of a step that died on one exception and false of a test
 * task, which prints each failure as it happens and then thousands of lines of other output
 * after them. A blind head/tail cut then hands the model a summary line saying the task failed
 * and nothing naming what — and the reader is told "the log doesn't say which tests failed"
 * when the log said so plainly, a few hundred thousand characters above the cut.
 */
const RESCUE_SHARE = 0.25;
/**
 * Lines kept after each rescued one. An assertion is often two lines — `expected: <0>` then
 * `but was: <3>` — and half a comparison is worse than none of it.
 */
const RESCUE_TRAILING_LINES = 2;

/**
 * The failure lines out of a stretch of log that is about to be thrown away.
 *
 * Reuses the highlighter's classification rather than keeping a second failure vocabulary here:
 * it is the same judgement — does this line name a failure? — it is deliberately conservative,
 * and one definition means a line the reader sees coloured red is a line the model was shown.
 *
 * Runs are kept in log order with an ellipsis where they are not adjacent, so what arrives is
 * still a log rather than a bag of lines.
 */
function rescueFailureLines(middle: string, budget: number): { text: string; lines: number } {
  const lines = middle.split('\n');
  // Classified once. The middle of an over-long log is most of it, and this runs on a click.
  const kinds = lines.map((line) => highlightLogLine(line).kind);

  const keep = new Set<number>();
  let used = 0;
  /**
   * Fill the budget with one kind of line, in log order, stopping when it runs out.
   *
   * Called for `failure` before `error` so the budget buys test names before it buys anything
   * that merely says "Error:". They are not equal evidence, and a log whose middle opens with a
   * page of retryable download errors would otherwise spend the whole allowance before reaching
   * the assertions — which is the one outcome that leaves this no better than the blind cut.
   */
  const take = (wanted: LogLineKind) => {
    for (let i = 0; i < lines.length; i += 1) {
      if (kinds[i] !== wanted) continue;
      const last = Math.min(i + RESCUE_TRAILING_LINES, lines.length - 1);
      for (let j = i; j <= last; j += 1) {
        if (keep.has(j) || !lines[j].trim()) continue;
        if (used + lines[j].length + 1 > budget) return;
        keep.add(j);
        used += lines[j].length + 1;
      }
    }
  };
  take('failure');
  take('error');

  const out: string[] = [];
  let kept = 0;
  let previous = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    // The separators are the only thing outside the budget above — two characters per gap in the
    // text, against a tail sized from the whole reservation, so the arithmetic below still holds.
    if (kept > 0 && index !== previous + 1) out.push('…');
    out.push(lines[index]);
    previous = index;
    kept += 1;
  }
  return { text: out.join('\n'), lines: kept };
}

export function trimLog(log: string, maxChars: number = MAX_LOG_CHARS): string {
  if (log.length <= maxChars) return log;
  const headChars = Math.floor(maxChars * HEAD_SHARE);
  const rescueBudget = Math.floor(maxChars * RESCUE_SHARE);
  // Sized against the provisional tail so the three slices are disjoint: a rescued line that
  // also appeared in the tail would read as the failure having happened twice.
  const rescued = rescueFailureLines(
    log.slice(headChars, log.length - (maxChars - headChars - rescueBudget)),
    rescueBudget,
  );
  // With nothing rescued the held-back budget goes back to the tail, which is the plain
  // head/tail cut this started as — no log pays for the rescue unless it got one.
  const tailChars = rescued.lines > 0 ? maxChars - headChars - rescueBudget : maxChars - headChars;
  const dropped = log.length - headChars - tailChars - rescued.text.length;
  return [
    log.slice(0, headChars),
    `\n\n… ${dropped.toLocaleString('en-US')} characters omitted from the middle`,
    rescued.lines > 0
      ? `, except for the ${rescued.lines} line${rescued.lines === 1 ? '' : 's'} below that name a failure …\n\n${rescued.text}\n\n… end of the omitted section …\n\n`
      : ` …\n\n`,
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

/**
 * The record-shaped third section, asked for by the quick read.
 *
 * Same format as the `cause` task returns — see src/lib/failureCause.ts — so one parser and one
 * card serve both. The terms are much tighter, though, because this pass has no tools: the log
 * pasted below is the whole of its evidence, so it lists what that log names and nothing else.
 *
 * Why the quick read carries it at all: it is the pass people actually run first, the log is
 * already in its prompt, and "which tests failed" costs it one more section rather than another
 * call. Before this, a reader who pressed the fastest button got prose about a failure whose
 * test list sat unread two paragraphs above it in the same log.
 *
 * No `cause:` line, unlike the cause task: the problem statement above already is that sentence,
 * and asking for it twice only invites two slightly different versions of it.
 */
const FAILURES_SECTION = `${FAILURES_MARKER}
One record per concrete thing that broke, **read out of the log below**, in the order the log gives them. This is the list the reader sees without opening anything, so it is the failing tests with their assertions, the compile errors with their file and line, the step that timed out, the runner that died — never a restatement of the step that reported them.

- kind: assertion
  what: exportsRotatedPage
  group: com.example.reporting.ExportToPdfTests
  where: testing/exporttopdf/ExportToPdfTests.java:88
  message: Expected 0 diffs but got 3

- kind: error
  what: keepsFormFields
  group: com.example.reporting.ExportToPdfTests
  message: NullPointerException: Cannot invoke "Form.fields()" because "form" is null`;

/** The record rules, kept out of the prose rules because they govern a different shape. */
const FAILURES_RULES = `For the \`${FAILURES_MARKER}\` records:
- \`what:\` is the only required key, and every record needs one — the test, the file, the step or the check that broke.
- \`kind:\` is one of \`test\`, \`assertion\`, \`error\`, \`compile\`, \`timeout\`, \`crash\`, \`infrastructure\`, \`dependency\`, \`lint\`, \`skipped\`.
- \`group:\` is the suite, class or file the item belongs to. \`where:\` is \`path:line\`. \`message:\` is **one line** — the decisive assertion, exception or runner message, verbatim and trimmed, never a stack trace.
- Leave a key **out** when the log does not carry it. Never write "unknown", "n/a" or a placeholder, and never invent a name, a path, a line number or a message.
- Add \`source: the job log\` and, where the log states a total you did not list in full, \`failed: <that total>\`. List at most 60 records.
- **If the log does not name the individual failures, write the marker and nothing under it.** That is a real answer and a common one: a Gradle task prints no per-test output by default, so all that reaches the log is \`There were failing tests. See the report at: …\`. Say so in the problem statement and **name the report file the log points at**, so the reader knows where the names are — never promote the step's own exit code into a record to have something to list.`;

/**
 * The reply contract, shared by the prose briefs.
 *
 * `withFailures` adds the third section. Only the quick read takes it: the deep read has tools
 * and the `cause` task is the one briefed to spend them on this question, so asking a
 * tool-using pass for a log-only list would be asking it for the weaker answer.
 */
function outputContract(withFailures: boolean): string {
  return `Reply with exactly ${withFailures ? 'three' : 'two'} sections, in this order, introduced by these markers on their own lines, and nothing else — no preamble, no sign-off, no code fence around the markers:

${PROBLEM_MARKER}
What actually went wrong, in prose, for a developer who knows this codebase but has not seen this failure. Aim for 2–5 sentences. Name the failing test (or file, or step) and quote the decisive line — the assertion, the exception, the diff — verbatim in backticks. If several things failed, lead with the root cause and say the rest look like consequences of it. If the evidence points at infrastructure rather than the code — a runner dying, a network or registry timeout, disk exhaustion, a rate limit, a flaky external service — say so plainly, because that changes who should pick this up.

${SOLUTION_MARKER}
The most likely fix, as concrete as the evidence supports: which file and what change, or the exact command that reproduces it locally. Commit to one recommendation rather than listing possibilities. Where the evidence genuinely does not determine the cause, say what to check next and which extra output would settle it — do not guess a cause to have something to say.
${withFailures ? `\n${FAILURES_SECTION}\n` : ''}
Rules:
- **Put each sentence on its own line** in the prose sections. Write one statement per line rather than a flowing paragraph — the reader sees this streamed live and then in a bug report, and short lines are scannable where a wall of prose is not. Do not add blank lines between them.
- Never invent a URL, issue number, commit SHA, file path, test name or line number. Everything you state must come from the input below or from output you actually obtained. The report around your text already carries the verified links and metadata, so do not restate them.
- Plain Markdown that renders both in a GitHub issue and in a Microsoft Teams message: no HTML, no headings, no tables, no nested collapsible blocks. Backticks for code and short bullet lists are fine.
- Do not apologise and do not hedge every sentence — state what the evidence shows and mark genuine uncertainty once. Keep your process out of the answer: narrate while you work, conclude here.
${withFailures ? `\n${FAILURES_RULES}\n` : ''}`;
}

const OUTPUT_CONTRACT = outputContract(false);

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

Keep the prose to a few lines. Name the failing test, file or step and quote the decisive line if it is there. Say whether this looks like a code failure or an infrastructure one — a runner dying, a timeout, a rate limit — because that decides who picks it up.

**Then list what broke, one record each.** The log often carries the individual failures — a run of \`FAILED\` lines, a pytest short summary, a compiler's errors — and reading them out is most of the value of this pass: the reader sees them without opening the log at all. List only what the log actually names, and when it names none, say so and write no records.

${outputContract(true)}`;

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

/**
 * Name the cause, and list what actually broke.
 *
 * The task exists because GitHub's own answer is useless. A check run's failure annotations
 * describe the *step*: `Gradle Tests Failed (drawing-docs)` and `Process completed with exit
 * code 1`, which names nothing anyone can fix. The specifics are in the log, or — for tests —
 * in a JUnit report inside the run's artifacts, a download and a parse away.
 *
 * Deliberately **not** "which tests failed". Half of CI failures are not tests at all: a
 * compile error, a missing dependency, a dead runner, a full disk, a step that timed out. A
 * brief that asked for tests would either come back empty on those or bend them into the shape
 * of a test, and both are worse than a list that says what kind of thing each item is.
 *
 * One line of cause, then records. It is told not to diagnose *beyond* that line, because the
 * quick and deep reads already answer "why", and what makes this answer useful is that the
 * body stays a list — something to group, count and paste. Records rather than prose: see
 * src/lib/failureCause.ts for why the shape is lines and not JSON.
 */
export const CLAUDE_CAUSE_BRIEF = `You are working out **what actually failed** in a GitHub Actions job, so a developer sees it without reading the log.

The failure annotations below almost certainly do not tell you. A workflow reports the *step* that failed — "Gradle Tests Failed", "Process completed with exit code 1" — not the thing that broke inside it. Find the real items.

**It is often not tests.** Look for whatever actually went wrong, and say which kind of thing each one is:
- failing **tests** — with the assertion, from the log's own failure list (Gradle's \`FAILED\` lines, pytest's short summary, \`dotnet test\`'s \`Failed X [12 ms]\`, Jest's \`● Test\` blocks) or from the run's test-report artifact (\`TEST-*.xml\`, \`*surefire*\`, a TRX, a JSON reporter output), which has the exact names and messages;
- **compile** and lint errors — file, line and the compiler's message;
- **infrastructure** — a runner that died, a network or registry timeout, a rate limit, a full disk, an out-of-memory kill;
- **dependency** failures — a package or image that could not be fetched;
- a step that **timed out** or a process that **crashed**.

Where to look, cheapest first: the log below; then, if it points at a test report you have not seen, the run's artifacts. Nothing else — do not read the workflow, the diff or another job.

**Do not diagnose beyond the one \`cause:\` line.** No root cause analysis, no suggested fix, no commentary — other tasks do that, and prose here is dropped. Take the names and the messages as the evidence states them.

Reply with **records only**, starting with the marker on its own line and no preamble:

${FAILURES_MARKER}
cause: three pages differ in the PDF comparison, so ExportToPdfTests fails on a real assertion
source: JUnit XML from artifact \`test-results-exporttopdf\`
failed: 3
note: the report covers the exporttopdf shard only

- kind: assertion
  what: exportsRotatedPage
  group: com.example.reporting.ExportToPdfTests
  where: testing/exporttopdf/ExportToPdfTests.java:88
  message: Expected 0 diffs but got 3

- kind: infrastructure
  what: Download artifacts step
  where: .github/workflows/java.yml:71
  message: Error: The operation was canceled — the runner lost connection

Rules:
- \`cause:\` is **one line** naming what broke, in your own words, for someone who has not seen this failure. Lead with the root cause when several things failed. Say plainly when it is infrastructure rather than the code, because that changes who picks it up.
- One record per concrete item, in the order the evidence gives them. \`what:\` is the only required key.
- \`kind:\` is one of \`test\`, \`assertion\`, \`error\`, \`compile\`, \`timeout\`, \`crash\`, \`infrastructure\`, \`dependency\`, \`lint\`, \`skipped\`.
- \`group:\` is the suite, class, file or phase the item belongs to — leave it out when there isn't one.
- \`message:\` is **one line**: the decisive assertion, exception or runner message, verbatim and trimmed. Not a stack trace, not your summary of it.
- Leave a key **out** when the evidence does not carry it. Never write "unknown", "n/a" or a placeholder.
- \`source:\` says where you read them — name the artifact, or say "the job log".
- \`failed:\` is the true total. List at most 60 records; if there are more, list the first 60 and let \`failed:\` carry the real number.
- \`note:\` is for what bounds the list — a report covering one shard, a truncated log, a suite that never finished.
- Never invent a name, a file, a line number or a message. Everything you write must appear in output you actually read.
- If the evidence genuinely does not say what broke, reply with the marker, a \`cause:\` line saying so, a \`source:\` naming where you looked, and **no records**. That is a real answer.`;

/**
 * Find the places in the log worth jumping to.
 *
 * Not the same job as the highlighter. `src/lib/logHighlight.ts` decides, line by line and
 * with no context, whether a line *looks* like a failure — which in a failed run is forty
 * lines, of which one matters. This pass reads the whole log and says which handful to look
 * at, in order, with a sentence each; the viewer turns them into a marker stripe you can walk
 * with two buttons. Restraint is therefore the point, and the brief says so: a map with fifty
 * pins on it is the wall of colour the highlighter exists to avoid.
 *
 * Anchoring is by quoted text — see src/lib/logMarks.ts for why a line number the model
 * counted cannot be trusted even when it is right.
 */
export const CLAUDE_MARKS_BRIEF = `You are marking up a failed GitHub Actions log so a developer can jump straight to what matters.

The log is below. Find the places where something actually went wrong, and the few lines that explain them. The app already colours anything that looks like an error, so listing every red line helps nobody — what it cannot do is tell the one decisive line from the thirty consequences of it. That judgement is the whole job.

Reply with **records only**, starting with the marker on its own line and no preamble:

${MARKS_MARKER}
- text: FAILED com.devexpress.drawing.docs.PdfExportTest > exportsRotatedPage
  line: 4821
  severity: error
  label: PdfExportTest.exportsRotatedPage failed
  note: The first real failure; the shard summary further down is reporting this same test.

- text: Execution failed for task ':devexpress-drawing-tests:test'
  line: 5104
  severity: warning
  label: Gradle reports the task failed
  note: A consequence of the test above, not a separate problem.

Rules:
- \`text:\` is a **verbatim excerpt of one line of the log below**, copied exactly. This is how the app finds the line, so copy enough of it to be unique — a dozen characters or more — and never span two lines. Do not add quotes, ellipses or backticks of your own.
- \`line:\` is that line's number in the log below, if you can count it. It is only used to tell two identical lines apart, so an approximation is fine and a wrong number costs nothing.
- \`severity:\` is \`error\` for something that broke, \`warning\` for something that may explain it or is a consequence of it, \`notice\` for context worth jumping to — the start of the failing step, a summary line, the point where output stops.
- \`label:\` is a few words naming what the line is. It is shown on the marker.
- \`note:\` is one sentence, and only where the line does not speak for itself. Say when something is a consequence of an earlier failure — that is the most useful thing you can add.
- **Between one and twenty findings**, in the order they appear in the log. Mark the decisive lines and the lines that explain them; leave the rest alone.
- Never invent a line. If nothing in the log shows a failure, reply with the marker and no records.`;

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

/**
 * Which tasks the bridge runs with tools, and which therefore get the exact commands.
 *
 * Mirrors `USES_TOOLS` in electron/claudeBridge.cjs — the bridge is the authority, since it is
 * what actually passes `--allowedTools`, and this side only decides whether to spell the
 * commands out. Listing a task here that has no tools would hand it a recipe it cannot run.
 */
const TOOL_TASKS: ReadonlySet<ClaudeDepth> = new Set(['deep', 'blame', 'cause']);

/**
 * What the log section is called, per task.
 *
 * The heading is doing real work: it says what the log *is for* in this run. The same megabyte
 * is the evidence for the deep pass, the input for the rewrite, mere context for blame, and the
 * thing being annotated for the marker pass.
 */
const LOG_HEADER: Partial<Record<ClaudeDepth, string>> = {
  deep: '--- LOG OF THE FAILED STEP(S), ALREADY FETCHED (start here, then dig deeper) ---',
  log: '--- LOG TO REWRITE ---',
  blame: '--- LOG OF THE RUN YOU WERE ASKED ABOUT (context; the history matters more) ---',
  cause: '--- LOG OF THE FAILED STEP(S) (read what broke out of this, then the run’s artifacts if it points at a test report) ---',
  marks: '--- LOG TO MARK UP ---',
};

/**
 * The brief per task, as a table.
 *
 * A table rather than the ternary chain this used to be: the chain was four deep, and the
 * failure mode of adding a task to it is silent — the new depth falls through to the
 * investigation brief and answers a question nobody asked.
 */
const BRIEF_BY_DEPTH: Partial<Record<ClaudeDepth, string>> = {
  quick: CLAUDE_QUICK_BRIEF,
  log: CLAUDE_LOG_BRIEF,
  blame: CLAUDE_BLAME_BRIEF,
  cause: CLAUDE_CAUSE_BRIEF,
  marks: CLAUDE_MARKS_BRIEF,
};

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
    BRIEF_BY_DEPTH[input.depth] ??
    (input.canInvestigate ? CLAUDE_INVESTIGATION_BRIEF : CLAUDE_OFFLINE_BRIEF);

  // A custom brief replaces the wording, never the contract: the markers are re-stated
  // after it so a well-meaning override can't produce a reply that fails to parse. The
  // document tasks return prose or records with their own shape, so there is no marker
  // contract to restate — imposing one would ask for sections they do not produce.
  const brief = input.promptOverride?.trim()
    ? returnsDocument(input.depth)
      ? input.promptOverride.trim()
      : `${input.promptOverride.trim()}\n\n${outputContract(returnsFailureRecords(input.depth))}`
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
    ...(TOOL_TASKS.has(input.depth) && input.canInvestigate
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
          LOG_HEADER[input.depth] ?? '--- LOG OF THE FAILED STEP(S) ---',
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
 * Where a section ends: at the next marker that follows it, or at the end of the reply.
 *
 * Computed rather than assumed, because the sections no longer arrive in a fixed pair. The
 * quick read appends a third, record-shaped section, and taking "the solution runs to the end
 * of the reply" on trust put a page of `kind:`/`what:` lines into the suggested fix — in the
 * pane, and then in the bug report.
 */
function sectionEnd(from: number, markers: readonly number[]): number | undefined {
  let end: number | undefined;
  for (const at of markers) {
    if (at > from && (end === undefined || at < end)) end = at;
  }
  return end;
}

/**
 * Split the model's reply on the markers.
 *
 * Tolerant on purpose: a model that ignores the "nothing else" instruction and adds a
 * preamble, or emits only one section, should still yield something usable rather than
 * throwing away a slow and costly call. Returns null only when neither prose marker appears,
 * which means the output bears no relation to what was asked for.
 *
 * The records are not read here — {@link parseFailureCause} owns that format, and this returns
 * only the two prose parts the report is built from.
 */
export function parseClaudeAnalysis(reply: string): ClaudeAnalysis | null {
  const problemAt = reply.indexOf(PROBLEM_MARKER);
  const solutionAt = reply.indexOf(SOLUTION_MARKER);
  if (problemAt === -1 && solutionAt === -1) return null;
  const failuresAt = reply.indexOf(FAILURES_MARKER);
  const markers = [problemAt, solutionAt, failuresAt].filter((at) => at !== -1);

  const problem =
    problemAt === -1
      ? ''
      : reply.slice(problemAt + PROBLEM_MARKER.length, sectionEnd(problemAt, markers)).trim();
  const solution =
    solutionAt === -1
      ? ''
      : reply.slice(solutionAt + SOLUTION_MARKER.length, sectionEnd(solutionAt, markers)).trim();

  if (!problem && !solution) return null;
  return {
    problem: splitIntoSentenceLines(problem),
    solution: splitIntoSentenceLines(solution),
  };
}

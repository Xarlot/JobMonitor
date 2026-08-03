/**
 * Classify GitHub Actions log lines so they can be coloured.
 *
 * Done locally rather than by asking a model to "colour the log": the structure is
 * documented and mechanical — workflow commands (`##[error]`, `##[group]`), ANSI SGR
 * sequences from the tools themselves, and the failure vocabulary of common test runners.
 * A local pass is instant, free, offline, and identical every time, which is what you
 * want from syntax colour. The model's job is the *explaining*, which is the part that
 * actually needs judgement.
 *
 * Everything here is classification only — no HTML, no escaping — so the renderer stays
 * responsible for output safety and this stays testable.
 */

/** What a line is, in rendering terms. */
export type LogLineKind =
  | 'group' // ##[group] — a collapsible section header
  | 'endgroup'
  | 'error' // ##[error] or a runner-level failure line
  | 'warning'
  | 'notice'
  | 'command' // the shell line a step actually ran
  | 'failure' // a test runner naming a failed test
  | 'success'
  | 'stack' // a stack-trace frame
  | 'section' // a build tool's own progress header, e.g. "> Task :app:test"
  | 'plain';

export interface HighlightedLine {
  kind: LogLineKind;
  /** Timestamp prefix, if the line carried one — rendered dimmed and separately. */
  timestamp: string | null;
  /** The line's text, with the timestamp, workflow-command marker and ANSI removed. */
  text: string;
}

// Matches CSI sequences: colour (SGR) plus the cursor moves and erases that progress
// bars emit. eslint-disable because the escape character is the whole point.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const TS_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/s;

/** `##[error]Process completed…` — the runner's own annotations. */
const WORKFLOW_COMMAND_RE = /^##\[(\w+)\](.*)$/s;

/**
 * Failure vocabulary, deliberately conservative.
 *
 * These have to be anchored or specific enough not to fire on ordinary prose: a log line
 * mentioning "error handling" is not an error, and colouring it as one trains the reader
 * to ignore the colour. False negatives just look plain; false positives make the whole
 * scheme untrustworthy.
 */
const FAILURE_RE =
  new RegExp(
    [
      // Gradle/JUnit/pytest
      String.raw`\bFAILED\b`,
      String.raw`\bFAIL\b`,
      'AssertionError',
      'AssertionFailedError',
      String.raw`\bexpected:? .*\bbut\b`,
      String.raw`Tests? run:.*Failures: [1-9]`,
      String.raw`\b\d+ (?:test|spec)s? failed\b`,
      // `dotnet test` / MSTest / xunit: "  Failed SomeTests.Method [12 ms]". Anchored at
      // line start so ordinary prose mentioning a failure is not caught — the whole point
      // of keeping these tight.
      String.raw`^\s*Failed\s+\S`,
      // `dotnet test` summary line
      String.raw`^\s*Failed!`,
      '✗',
      '✕',
    ].join('|'),
    'm',
  );
const ERROR_RE =
  /(^|\s)(?:Error|ERROR|Exception|FATAL|error|panic):|^\s*(?:Caused by|Error:)|\bUnhandledPromiseRejection\b|\bsegmentation fault\b/;
const SUCCESS_RE = /(BUILD SUCCESSFUL|\bPASSED\b|\bOK\b \(|✓|✔|\ball tests passed\b)/i;
/** A stack frame: `at com.foo.Bar(Bar.java:12)`, `  File "x.py", line 3`, `#4 0x…`. */
const STACK_RE = /^\s*(?:at\s+\S|File ".*", line \d|#\d+\s+0x|\.{3} \d+ more$)/;
/** Gradle/Maven/MSBuild progress headers. */
const SECTION_RE = /^\s*(?:>\s+Task\s|\[INFO\] -{5,}|-{5,}|={5,}|Build succeeded|Restored )/;
/** The command a step ran, as echoed by `set -x` or the runner. */
const COMMAND_RE = /^\s*[+$]\s+\S/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function classify(text: string): LogLineKind {
  // Order matters: the runner's own annotation wins over anything the text looks like,
  // because it is authoritative rather than inferred.
  if (STACK_RE.test(text)) return 'stack';
  if (FAILURE_RE.test(text)) return 'failure';
  if (ERROR_RE.test(text)) return 'error';
  if (COMMAND_RE.test(text)) return 'command';
  if (SECTION_RE.test(text)) return 'section';
  if (SUCCESS_RE.test(text)) return 'success';
  return 'plain';
}

/** Map a workflow command name onto a kind, or null if it isn't one we colour. */
function kindOfWorkflowCommand(name: string): LogLineKind | null {
  switch (name.toLowerCase()) {
    case 'group':
      return 'group';
    case 'endgroup':
      return 'endgroup';
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'notice':
      return 'notice';
    default:
      return null;
  }
}

export function highlightLogLine(raw: string): HighlightedLine {
  const withoutAnsi = stripAnsi(raw);
  const ts = TS_RE.exec(withoutAnsi);
  const timestamp = ts ? ts[1] : null;
  const body = ts ? ts[2] : withoutAnsi;

  const command = WORKFLOW_COMMAND_RE.exec(body);
  if (command) {
    const kind = kindOfWorkflowCommand(command[1]);
    // An unrecognised `##[…]` keeps its marker: hiding it would silently drop text.
    if (kind) return { kind, timestamp, text: command[2] };
    return { kind: 'plain', timestamp, text: body };
  }

  return { kind: classify(body), timestamp, text: body };
}

export function highlightLog(log: string): HighlightedLine[] {
  return log.split(/\r?\n/).map(highlightLogLine);
}

/**
 * Whether a log looks worth colouring at all.
 *
 * A log with no recognisable structure gets no colour rather than a page of guesses —
 * uniform colour is the same as no colour, but it costs the reader trust in it.
 */
export function hasRecognisableStructure(lines: readonly HighlightedLine[]): boolean {
  return lines.some((l) => l.kind !== 'plain');
}

/**
 * Where the test runner put the names, when it kept them out of the log.
 *
 * The case this exists for: a Gradle test task prints no per-test output by default. What reaches
 * the log is `Execution failed for task ':x:test'` and `There were failing tests. See the report
 * at: file:///…/build/reports/tests/test/index.html` — a summary, a path, and not one test name.
 * Every other part of the app then reports what it can see: the check-run annotations say
 * `Process completed with exit code 1`, and the quick read correctly answers that the log does not
 * name the failures. All true, and all useless to somebody asking which test broke.
 *
 * So the *runner's own sentence* is read. It is mechanical, it is documented output, and it says
 * exactly where the answer is — which turns "there are no failing tests here" into "they are in
 * the run's test report, and the artifact pass can read it". Done locally rather than by asking a
 * model, for the same reason the highlighter is: it is a fixed string match, and spending a slow
 * billable call on one would be worse in every dimension.
 *
 * Deliberately narrow. Only runners that are *known* to withhold the names are matched: a pytest
 * or Jest log carries its own failures, and claiming their details are elsewhere would send a
 * reader after an artifact they do not need.
 */

/** A runner's statement that the details live somewhere other than this log. */
export interface TestReportHint {
  /** The tool that said so — the subject of "Gradle wrote them to …". */
  tool: string;
  /** The path it named, shortened to the part worth reading. */
  where: string;
}

/**
 * Patterns, each anchored on wording that only appears when results were written elsewhere.
 *
 * Gradle's line is the one that matters in practice; Maven's and VSTest's are here because they
 * are the same sentence in a different accent, and a reader hitting one of those would otherwise
 * meet the identical dead end.
 */
const PATTERNS: { tool: string; re: RegExp }[] = [
  // Gradle: "There were failing tests. See the report at: file:///…/index.html"
  { tool: 'Gradle', re: /There were failing tests\.\s*See the report at:\s*(\S+)/i },
  // Maven Surefire: "Please refer to /…/surefire-reports for the individual test results."
  { tool: 'Maven', re: /Please refer to (\S+) for the individual test results/i },
  // VSTest / `dotnet test`: the TRX holds the per-test detail the console summarises.
  { tool: 'dotnet test', re: /Results File:\s*(\S+\.trx)/i },
];

/**
 * Directory names that mark the start of the interesting part of a path.
 *
 * A runner prints an absolute path on the runner's own disk, and its first two thirds
 * (`/home/runner/work/<repo>/<repo>/…`) say nothing a reader wants. Cutting at the build
 * directory keeps the part that identifies *which* module's report it is.
 */
const PATH_ROOTS = ['build', 'target', 'TestResults', 'test-results'];

function shortenPath(raw: string): string {
  const withoutScheme = raw.replace(/^file:\/+/i, '/').replace(/\\/g, '/');
  const segments = withoutScheme.split('/').filter(Boolean);
  const at = segments.findIndex((s) => PATH_ROOTS.includes(s));
  // The module directory above the build root is what tells two shards' reports apart, so it is
  // kept when there is one.
  const from = at > 0 ? at - 1 : at === 0 ? 0 : Math.max(0, segments.length - 3);
  return segments.slice(from).join('/');
}

/**
 * Read the hint out of a log, or its tail.
 *
 * Takes lines rather than one string because the caller already has the failing step's tail — the
 * runner says this at the end, so the tail is where it is, and no extra fetch is needed to find it.
 */
export function testReportHint(lines: readonly string[]): TestReportHint | null {
  for (const line of lines) {
    for (const { tool, re } of PATTERNS) {
      const match = re.exec(line);
      if (match) return { tool, where: shortenPath(match[1]) };
    }
  }
  return null;
}

/**
 * The sentence the card and the report both say, so the two cannot drift apart.
 *
 * Careful about what it claims: the runner said where it *wrote* the report, which is a fact, not
 * that the workflow uploaded it, which is a guess — plenty of pipelines write a report and upload
 * nothing. So it names the place to look rather than promising what is there.
 */
export function describeTestReportHint(hint: TestReportHint): string {
  return `The log doesn’t name the failing tests — ${hint.tool} wrote them to ${hint.where} instead. Look for that report in the run’s artifacts.`;
}

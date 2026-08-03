/**
 * Turns a failed job into (a) a stable fingerprint of *what* failed and (b) a
 * Markdown document ready to paste into a GitHub issue or a Teams message.
 *
 * The fingerprint serves two callers: the report footer, so two bug reports about
 * the same breakage are comparable at a glance, and the auto-rerun engine, which
 * gives up when a failure repeats identically rather than retrying a deterministic
 * break. Both need "the same failure" to mean the same thing, hence one function.
 */

import type { Annotation } from '../api/types';
import type { FailureOrigin } from './failures';
import { fnv1aHex } from './hash';

/** What a failure *is*, stripped of everything that varies between attempts. */
export interface FailureSignature {
  /** Failed jobs, each with the step that broke (when known). */
  jobs: { name: string; failedStep: string | null }[];
  /** Annotation messages gathered across those jobs. */
  messages: string[];
}

/**
 * Remove the parts of a message that change between attempts of the *same*
 * commit, so a rerun of an unchanged break fingerprints identically.
 *
 * Note the asymmetry this is tuned for: over-normalising can only make two
 * different failures look the same (we stop retrying — cheap, recoverable), while
 * under-normalising makes the same failure look new (we retry forever — the
 * failure mode worth avoiding). Line numbers are deliberately kept: within one
 * commit they're stable, and they distinguish two failures in the same file.
 */
export function normalizeFailureText(text: string): string {
  return text
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<ts>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hex>')
    .replace(/(?:\/tmp|\/var\/folders|[A-Z]:\\Temp)\S*/gi, '<tmp>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A short, stable id for "this exact failure".
 *
 * Built from annotation messages plus the failed job/step names — not raw log
 * text. Annotations *are* the failure content (test name plus message) with far
 * less noise, and downloading logs for every failed job on every poll would be far
 * too heavy for a background loop. When a repo emits no annotations the
 * fingerprint degrades to job/step names, which is coarse but never wrong in the
 * dangerous direction; the attempt ceiling is the backstop there.
 *
 * Returns null when there is nothing to fingerprint, which callers must read as
 * "unknown" rather than "same as last time".
 */
export function failureFingerprint(sig: FailureSignature): string | null {
  const jobs = sig.jobs
    .map((j) => `${normalizeFailureText(j.name)}#${normalizeFailureText(j.failedStep ?? '')}`)
    .sort();
  const messages = sig.messages
    .map(normalizeFailureText)
    .filter(Boolean)
    .sort();
  if (jobs.length === 0 && messages.length === 0) return null;
  return fnv1aHex([...jobs, '--', ...messages].join('\n'));
}

/** Annotations that represent an actual failure, as opposed to a warning/notice. */
export function failureAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return annotations.filter((a) => a.annotation_level === 'failure');
}

/** Build a signature from one job's annotations. */
export function signatureFromAnnotations(
  jobName: string,
  failedStep: string | null,
  annotations: readonly Annotation[],
): FailureSignature {
  return {
    jobs: [{ name: jobName, failedStep }],
    messages: failureAnnotations(annotations).map(
      (a) => `${a.path ?? ''}:${a.start_line ?? ''} ${a.title ?? ''} ${a.message ?? ''}`,
    ),
  };
}

/** Merge several signatures (a run's failed jobs) into one. */
export function mergeSignatures(parts: readonly FailureSignature[]): FailureSignature {
  return {
    jobs: parts.flatMap((p) => p.jobs),
    messages: parts.flatMap((p) => p.messages),
  };
}

export type ReportFormat = 'github' | 'teams';

export interface FailureReportInput {
  jobName: string;
  failedStep: string | null;
  /** Which PR or flow this failure belongs to — drives the context line. */
  origin: FailureOrigin;
  headRef: string;
  headSha: string;
  /** Workflow file name, when it could be resolved. */
  workflowFile: string | null;
  runUrl: string | null;
  runNumber: number | null;
  runAttempt: number | null;
  jobUrl: string | null;
  completedAt: string | null;
  annotations: readonly Annotation[];
  /** Already-trimmed tail of the failing step's log. */
  logTail: readonly string[];
  fingerprint: string | null;
  format: ReportFormat;
  appVersion: string;
  generatedAt: Date;
  /**
   * Prose from the local Claude CLI, when the developer asked for it. The problem
   * statement leads the report (it is what a human actually reads); the proposed fix
   * goes last and collapsed, because it is a suggestion rather than a fact.
   */
  analysis?: { problem: string; solution: string } | null;
  /**
   * The blame verdict, when the reader has chosen to include it — see {@link blameVerdict}.
   * Placed above the problem statement: when a commit and an author are known, that is the
   * most actionable line in the document.
   */
  blame?: string | null;
}

function link(text: string, url: string | null): string {
  return url ? `[${text}](${url})` : text;
}

/** `path:line — title: message`, skipping the parts that are absent. */
function annotationLine(a: Annotation): string {
  const where = a.path ? `\`${a.path}${a.start_line ? `:${a.start_line}` : ''}\`` : null;
  const what = [a.title, a.message]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(' — ')
    .replace(/\s*\n\s*/g, ' ');
  return ['-', where, where && what ? '—' : null, what].filter(Boolean).join(' ');
}

function utc(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * One document per failed job — a matrix worker is a job, so this is the
 * "one per worker" unit.
 *
 * `teams` differs from `github` only where Teams' renderer would mangle the
 * output: it has no <details> support, so the log block is emitted flat — and
 * therefore shorter, because a chat message has no way to fold it away and
 * eighty lines of runner output buries the part someone needs to read.
 */
/**
 * How many log lines the Teams format shows inline.
 *
 * Small on purpose: Teams has no collapsible, so every line here is a line the reader
 * scrolls past to reach the metadata and the suggested fix. The tail is what holds the
 * failure, and the full log is one link away.
 */
export const TEAMS_LOG_LINES = 20;

/**
 * The verdict, lifted out of a blame report for use in a bug report.
 *
 * Only the `Summary` block: that is the part written to be read at a glance, and the rest —
 * the boundary, the suspect table, the flaky-test list — is the working that produced it.
 * A bug report wants the conclusion; anyone who needs the working can open the analysis.
 *
 * Falls back to the whole document when there is no Summary heading, since a verdict in an
 * unexpected shape is still better than silently adding nothing.
 */
export function blameVerdict(document: string): string {
  const start = document.search(/^#{1,6}\s+Summary\s*$/im);
  if (start === -1) return document.trim();
  const rest = document.slice(start);
  const nextHeading = rest.search(/\n#{1,6}\s+\S/);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  // Drop the "Summary" heading itself — the report supplies its own.
  return section.replace(/^#{1,6}\s+Summary\s*\n/i, '').trim();
}

export function buildFailureReport(input: FailureReportInput): string {
  const {
    jobName, failedStep, origin, headRef, headSha,
    workflowFile, runUrl, runNumber, runAttempt, jobUrl, completedAt,
    annotations, logTail, fingerprint, format, appVersion, generatedAt, analysis, blame,
  } = input;

  const failures = failureAnnotations(annotations);
  const warnings = annotations.filter((a) => a.annotation_level === 'warning');

  const out: string[] = [];

  out.push(`### \`${jobName}\` failed`);
  out.push('');

  // Above even the problem statement: when a commit and an author are known, that is the
  // single most actionable line in the document and the reason most people open it.
  if (blame?.trim()) {
    out.push(`**Who broke it**`);
    out.push('');
    out.push(blame.trim());
    out.push('');
  }

  // Leads the report: someone skimming this in Teams should understand the failure
  // before meeting any metadata.
  if (analysis?.problem) {
    out.push(analysis.problem);
    out.push('');
  }

  // The context line differs by origin: a PR wants its branch pair and open/merged
  // state, a flow wants its name and what triggered the run.
  if (origin.kind === 'pr') {
    out.push(
      `**PR** ${link(`#${origin.prNumber} ${origin.prTitle}`, origin.prUrl)}` +
        ` · \`${headRef}\` → \`${origin.baseRef}\` · ${origin.prState}`,
    );
  } else {
    const bits = [
      `**Flow** ${origin.flowName}`,
      headRef ? `\`${headRef}\`` : null,
      origin.event,
    ].filter(Boolean);
    out.push(bits.join(' · '));
  }

  const runBits = [
    workflowFile ? `\`${workflowFile}\`` : null,
    runNumber != null
      ? link(`run #${runNumber}${runAttempt && runAttempt > 1 ? `, attempt ${runAttempt}` : ''}`, runUrl)
      : runUrl
        ? link('run', runUrl)
        : null,
    jobUrl ? link('job log', jobUrl) : null,
  ].filter(Boolean);
  if (runBits.length) out.push(`**Workflow** ${runBits.join(' · ')}`);

  const stepBits = [
    failedStep ? `\`${failedStep}\`` : null,
    `commit \`${headSha.slice(0, 7)}\``,
    utc(completedAt) ? `finished ${utc(completedAt)}` : null,
  ].filter(Boolean);
  out.push(`**Failed step** ${stepBits.join(' · ')}`);
  out.push('');

  if (failures.length > 0) {
    out.push(`#### Failed tests (${failures.length})`);
    out.push(...failures.map(annotationLine));
    out.push('');
  } else {
    // Say so explicitly rather than leaving a gap: an empty section reads like a
    // bug in the report, whereas "no annotations" is a real and useful fact.
    out.push('#### Failed tests');
    out.push('- _No failure annotations were reported — see the log below._');
    out.push('');
  }

  if (warnings.length > 0) {
    out.push(`#### Warnings (${warnings.length})`);
    out.push(...warnings.slice(0, 10).map(annotationLine));
    if (warnings.length > 10) out.push(`- _…and ${warnings.length - 10} more._`);
    out.push('');
  }

  if (logTail.length > 0) {
    if (format === 'github') {
      const heading = `Log tail — step "${failedStep ?? jobName}" (last ${logTail.length} lines)`;
      out.push(`<details><summary>${heading}</summary>`);
      out.push('');
      out.push('```');
      out.push(...logTail);
      out.push('```');
      out.push('');
      out.push('</details>');
    } else {
      // Trimmed for Teams. GitHub can fold eighty lines away behind a summary; a chat
      // message cannot, and an unfoldable wall of runner output buries the two lines that
      // matter — and pushes the metadata and the suggested fix off the screen entirely.
      const shown = logTail.slice(-TEAMS_LOG_LINES);
      const dropped = logTail.length - shown.length;
      out.push(`**Log tail — step "${failedStep ?? jobName}" (last ${shown.length} lines)**`);
      out.push('```');
      out.push(...shown);
      out.push('```');
      if (dropped > 0) {
        // Said rather than silently cut, with somewhere to go for the rest.
        out.push(
          jobUrl
            ? `_${dropped} earlier ${dropped === 1 ? 'line' : 'lines'} omitted — [see the full log](${jobUrl})._`
            : `_${dropped} earlier ${dropped === 1 ? 'line' : 'lines'} omitted._`,
        );
      }
    }
    out.push('');
  }

  // Last and folded away: a suggestion, clearly separated from what the log proves.
  // Teams renders no <details>, so there it becomes a plain trailing section.
  if (analysis?.solution) {
    const heading = 'Suggested fix (generated — review before trusting)';
    if (format === 'github') {
      out.push(`<details><summary>${heading}</summary>`);
      out.push('');
      out.push(analysis.solution);
      out.push('');
      out.push('</details>');
    } else {
      out.push(`**${heading}**`);
      out.push('');
      out.push(analysis.solution);
    }
    out.push('');
  }

  out.push(
    `_Job Monitor v${appVersion} · generated ${utc(generatedAt.toISOString())}` +
      `${fingerprint ? ` · fingerprint \`${fingerprint}\`` : ''}_`,
  );

  return out.join('\n');
}

/** Join several reports for a multi-selection copy. */
export function joinReports(reports: readonly string[]): string {
  return reports.join('\n\n---\n\n');
}

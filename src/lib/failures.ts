/**
 * Flattens what the dashboard knows into a list of individual failing jobs — the
 * unit a bug gets filed against.
 *
 * Two sources feed it and they carry different evidence:
 *  - **Pull requests** expose *check-runs*, which already carry their own
 *    check-run id (so annotations need no extra resolution) and encode the Actions
 *    run + job ids in `details_url`.
 *  - **Flows** expose *runs* whose *jobs* must be fetched, and a job reaches its
 *    check-run id the long way round, via `check_run_url`.
 * Everything downstream — the report, the detail loader, the list — works off the
 * normalized {@link FailedJobRef}, so neither has to care which it came from.
 *
 * Pure, and deliberately structural about its input so lib/ doesn't depend on
 * hooks/: any object with a `pr` and its `checkRuns` will do, which `PrEntry`
 * already is.
 */

import type { CheckRun, Job, PullRequest, RunConclusion, WorkflowRun } from '../api/types';
import { checkRunIdFromUrl, jobIdFromUrl, runIdFromUrl } from '../api/endpoints';
import { statusToOverall } from './status';
import { workflowBasename } from './workflow';

export type PrFailureState = 'open' | 'merged';

/**
 * How far back the Failures tab looks.
 *
 * A week, matching the cache TTL, and for the same reason: a failure older than
 * that is history rather than something to act on, and scanning it costs requests
 * (job lists, annotations) for a bug nobody is about to file. It also bounds the
 * work when a repo has a long tail of stale open PRs.
 */
export const SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** True when a failure finished recently enough to still be worth showing. */
export function withinScanWindow(completedAtMs: number, now: number): boolean {
  // A missing timestamp (0) is kept: it means "unknown when", not "ancient", and
  // dropping it would silently hide a failure.
  return completedAtMs === 0 || now - completedAtMs <= SCAN_WINDOW_MS;
}

/**
 * Step-level "this is what broke".
 *
 * Deliberately *not* expressed via `RETRYABLE_CONCLUSIONS` from lib/autoRerun.ts,
 * even though the two sets happen to coincide today: that one is run-level retry
 * *policy*, and narrowing or widening it must not silently change which step a
 * report and a fingerprint blame.
 */
const BROKEN_STEP_CONCLUSIONS: ReadonlySet<RunConclusion> = new Set<RunConclusion>([
  'failure',
  'timed_out',
]);

/**
 * Name of the step that failed, or null when none did (or the job carries no
 * steps). Both the bug report and the failure fingerprint attribute blame with
 * this, so it must be one definition — two copies drifting would make the
 * fingerprint in a report disagree with the one the rerun engine compares.
 */
export function failedStepName(job: Job): string | null {
  const step = job.steps?.find(
    (s) => s.status === 'completed' && BROKEN_STEP_CONCLUSIONS.has(s.conclusion),
  );
  return step?.name ?? null;
}

/**
 * Where a failure came from. Discriminated rather than a bag of optional fields,
 * so the report and the list can't read a PR field off a flow failure.
 */
export type FailureOrigin =
  | {
      kind: 'pr';
      prNumber: number;
      prTitle: string;
      prUrl: string;
      prState: PrFailureState;
      baseRef: string;
    }
  | {
      kind: 'flow';
      /** Resolved flow id — for a regex flow this is the per-match derived id. */
      flowId: string;
      flowName: string;
      runUrl: string;
      runNumber: number;
      /** What triggered the run (`schedule`, `push`, …). */
      event: string;
    };

/** Enough to render a row, fetch its detail, and write a report about it. */
export interface FailedJobRef {
  /** Stable across polls, so selection and prefetch survive a refresh. */
  key: string;
  origin: FailureOrigin;
  /**
   * Repo the failure lives in. Carried per-failure because a flow may override
   * owner/repo, so it is not always the configured upstream.
   */
  owner: string;
  repo: string;
  headSha: string;
  /** Branch: the PR's head ref, or the run's head branch. */
  headRef: string;
  /** The check-run behind this job, when known — annotations are keyed by it. */
  checkRunId: number | null;
  /** Actions job id, for logs. Null for a check-run that isn't an Actions job. */
  jobId: number | null;
  /** Actions run id, for the run link and the workflow file. */
  runId: number | null;
  jobName: string;
  url: string | null;
  completedAt: string | null;
  /** Parsed once here so sorting doesn't re-parse inside the comparator. */
  completedAtMs: number;
  /**
   * Workflow file, run number and attempt — known up front for a flow failure,
   * whose run object we already hold. Null for a PR failure, where a check-run
   * carries no workflow identity and the run has to be read separately.
   */
  workflowFile: string | null;
  runNumber: number | null;
  runAttempt: number | null;
}

/** The subset of a PR entry this module reads. */
export interface FailureSource {
  pr: PullRequest;
  checkRuns: readonly CheckRun[];
}

/** One tracked flow's latest run plus the jobs of it that were fetched. */
export interface FlowFailureSource {
  flowId: string;
  flowName: string;
  owner: string;
  repo: string;
  run: WorkflowRun;
  jobs: readonly Job[];
}

function msOf(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) || 0 : 0;
}

function prRef(source: FailureSource, check: CheckRun, prState: PrFailureState, owner: string, repo: string): FailedJobRef {
  const { pr } = source;
  // details_url carries the Actions run + job ids (.../actions/runs/{id}/job/{id});
  // html_url is the generic /runs/{check_run_id} page, so it is only a fallback.
  const detail = check.details_url ?? check.html_url;
  return {
    key: `pr:${pr.number}:${check.id}`,
    origin: {
      kind: 'pr',
      prNumber: pr.number,
      prTitle: pr.title,
      prUrl: pr.html_url,
      prState,
      baseRef: pr.base.ref,
    },
    owner,
    repo,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    checkRunId: check.id,
    jobId: jobIdFromUrl(detail),
    runId: runIdFromUrl(detail),
    jobName: check.name,
    url: check.html_url ?? check.details_url,
    completedAt: check.completed_at,
    completedAtMs: msOf(check.completed_at),
    workflowFile: null,
    runNumber: null,
    runAttempt: null,
  };
}

function flowRef(source: FlowFailureSource, job: Job): FailedJobRef {
  const { run } = source;
  return {
    key: `flow:${source.flowId}:${job.id}`,
    origin: {
      kind: 'flow',
      flowId: source.flowId,
      flowName: source.flowName,
      runUrl: run.html_url,
      runNumber: run.run_number,
      event: run.event,
    },
    owner: source.owner,
    repo: source.repo,
    headSha: run.head_sha,
    headRef: run.head_branch ?? '',
    checkRunId: checkRunIdFromUrl(job.check_run_url),
    jobId: job.id,
    runId: run.id,
    // Prefix with the workflow so a bare job name like "test" still says what broke.
    jobName: run.path ? `${workflowBasename(run.path)} / ${job.name}` : job.name,
    url: job.html_url,
    completedAt: job.completed_at,
    completedAtMs: msOf(job.completed_at),
    workflowFile: run.path ? workflowBasename(run.path) : null,
    runNumber: run.run_number,
    runAttempt: run.run_attempt,
  };
}

/** Most recently finished first; those with no timestamp sink to the bottom. */
function byRecency(a: FailedJobRef, b: FailedJobRef): number {
  return b.completedAtMs - a.completedAtMs;
}

/** True for a check-run that finished badly. */
function isFailingCheck(check: CheckRun): boolean {
  return statusToOverall(check.status, check.conclusion) === 'failure';
}

/** True for a job that finished badly. */
export function isFailingJob(job: Job): boolean {
  return statusToOverall(job.status, job.conclusion) === 'failure';
}

/** True for a run that finished badly — the gate on fetching its jobs at all. */
export function isFailingRun(run: WorkflowRun): boolean {
  return statusToOverall(run.status, run.conclusion) === 'failure';
}

/**
 * Every failing check-run across the tracked PRs, open ones first, then the flow
 * failures.
 *
 * "Failing" is `statusToOverall(...) === 'failure'`, which covers `failure`,
 * `timed_out`, `startup_failure` and `action_required` — wider than what the
 * auto-rerun engine retries, and rightly so: all of them are worth a look even
 * where an unattended retry would be wrong.
 */
export function collectFailedJobs(
  open: readonly FailureSource[],
  merged: readonly FailureSource[] = [],
  flows: readonly FlowFailureSource[] = [],
  upstream: { owner: string; repo: string } = { owner: '', repo: '' },
  now: number = Date.now(),
): FailedJobRef[] {
  const recent = (refs: FailedJobRef[]): FailedJobRef[] =>
    refs.filter((r) => withinScanWindow(r.completedAtMs, now)).sort(byRecency);

  const pick = (sources: readonly FailureSource[], state: PrFailureState): FailedJobRef[] =>
    recent(
      sources.flatMap((source) =>
        source.checkRuns
          .filter(isFailingCheck)
          .map((c) => prRef(source, c, state, upstream.owner, upstream.repo)),
      ),
    );

  const flowRefs = recent(
    flows.flatMap((source) => source.jobs.filter(isFailingJob).map((job) => flowRef(source, job))),
  );

  return [...pick(open, 'open'), ...pick(merged, 'merged'), ...flowRefs];
}

/** A group of failures that share an origin, for the list's headings. */
export interface FailureGroup {
  /** Stable grouping key. */
  id: string;
  kind: FailureOrigin['kind'];
  title: string;
  url: string;
  /** Short qualifier for the heading: `open`/`merged`, or the run's trigger. */
  badge: string;
  jobs: FailedJobRef[];
}

function groupOf(f: FailedJobRef): Omit<FailureGroup, 'jobs'> {
  if (f.origin.kind === 'pr') {
    return {
      id: `pr:${f.origin.prNumber}`,
      kind: 'pr',
      title: `#${f.origin.prNumber} ${f.origin.prTitle}`,
      url: f.origin.prUrl,
      badge: f.origin.prState,
    };
  }
  return {
    id: `flow:${f.origin.flowId}`,
    kind: 'flow',
    title: f.origin.flowName,
    url: f.origin.runUrl,
    badge: f.origin.event,
  };
}

/** A top-level section: pull requests or flows, each holding its groups. */
export interface FailureSection {
  kind: FailureOrigin['kind'];
  title: string;
  groups: FailureGroup[];
  /** Failing jobs across the whole section. */
  count: number;
}

/**
 * Split the groups into a **Pull requests** and a **Flows** section, so flows aren't
 * interleaved with PRs in one flat list. Order is fixed (PRs first) rather than
 * data-driven, so the list doesn't reshuffle between polls. Empty sections are
 * dropped.
 */
export function sectionFailures(groups: readonly FailureGroup[]): FailureSection[] {
  const order: { kind: FailureOrigin['kind']; title: string }[] = [
    { kind: 'pr', title: 'Pull requests' },
    { kind: 'flow', title: 'Flows' },
  ];
  return order
    .map(({ kind, title }) => {
      const own = groups.filter((g) => g.kind === kind);
      return {
        kind,
        title,
        groups: own,
        count: own.reduce((n, g) => n + g.jobs.length, 0),
      };
    })
    .filter((section) => section.groups.length > 0);
}

/** Group failures by their origin, preserving the incoming order. */
export function groupFailures(failures: readonly FailedJobRef[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const f of failures) {
    const head = groupOf(f);
    let group = groups.get(head.id);
    if (!group) {
      group = { ...head, jobs: [] };
      groups.set(head.id, group);
    }
    group.jobs.push(f);
  }
  return [...groups.values()];
}

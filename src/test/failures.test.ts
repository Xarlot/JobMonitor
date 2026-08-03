import { describe, expect, it } from 'vitest';
import {
  collectFailedJobs,
  groupFailures,
  SCAN_WINDOW_MS,
  sectionFailures,
  withinScanWindow,
  type FailureSource,
  type FlowFailureSource,
} from '../lib/failures';
import type { CheckRun, Job, PullRequest, RunConclusion, WorkflowRun } from '../api/types';

const SLUG = 'o/r';

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: number,
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/${SLUG}/pull/${number}`,
    state: 'open',
    draft: false,
    user: null,
    created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-07-31T00:00:00Z',
    auto_merge: null,
    merged_at: null,
    head: { sha: 'abc1234', ref: 'feature', label: 'o:feature', user: null },
    base: { ref: 'main', repo: { full_name: SLUG } },
    ...over,
  };
}

function check(over: Partial<CheckRun> & { id: number }): CheckRun {
  return {
    name: `check-${over.id}`,
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-07-31T09:00:00Z',
    completed_at: '2026-07-31T09:30:00Z',
    html_url: `https://github.com/${SLUG}/runs/${over.id}`,
    details_url: `https://github.com/${SLUG}/actions/runs/500/job/${over.id}`,
    app: { slug: 'github-actions', name: 'GitHub Actions' },
    ...over,
  };
}

function source(prNumber: number, checkRuns: CheckRun[], over: Partial<PullRequest> = {}): FailureSource {
  return { pr: pr(prNumber, over), checkRuns };
}

describe('collectFailedJobs', () => {
  it('returns one entry per failing check-run', () => {
    const failures = collectFailedJobs([
      source(1, [
        check({ id: 10, conclusion: 'failure' }),
        check({ id: 11, conclusion: 'success' }),
      ]),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      key: 'pr:1:10',
      origin: { kind: 'pr', prNumber: 1, prState: 'open' },
      checkRunId: 10,
      jobId: 10,
      runId: 500,
    });
  });

  it('ignores everything that is not a failure', () => {
    const quiet: RunConclusion[] = ['success', 'neutral', 'skipped', 'cancelled', 'stale'];
    const failures = collectFailedJobs([
      source(1, quiet.map((conclusion, i) => check({ id: 10 + i, conclusion }))),
    ]);
    expect(failures).toEqual([]);
  });

  /** Wider than the auto-rerun set on purpose: all of these deserve a look. */
  it('counts timed_out, startup_failure and action_required as failures', () => {
    const bad: RunConclusion[] = ['failure', 'timed_out', 'startup_failure', 'action_required'];
    const failures = collectFailedJobs([
      source(1, bad.map((conclusion, i) => check({ id: 10 + i, conclusion }))),
    ]);
    expect(failures).toHaveLength(4);
  });

  it('ignores checks that have not finished', () => {
    const failures = collectFailedJobs([
      source(1, [check({ id: 10, status: 'in_progress', conclusion: null })]),
    ]);
    expect(failures).toEqual([]);
  });

  it('marks merged PRs and puts them after the open ones', () => {
    const failures = collectFailedJobs(
      [source(1, [check({ id: 10 })])],
      [source(2, [check({ id: 20 })], { state: 'closed', merged_at: '2026-07-31T08:00:00Z' })],
    );
    expect(
      failures.map((f) => [
        f.origin.kind === 'pr' ? f.origin.prNumber : null,
        f.origin.kind === 'pr' ? f.origin.prState : null,
      ]),
    ).toEqual([
      [1, 'open'],
      [2, 'merged'],
    ]);
  });

  it('sorts most recently finished first within a group', () => {
    const failures = collectFailedJobs([
      source(1, [
        check({ id: 10, completed_at: '2026-07-31T08:00:00Z' }),
        check({ id: 11, completed_at: '2026-07-31T10:00:00Z' }),
        check({ id: 12, completed_at: '2026-07-31T09:00:00Z' }),
      ]),
    ]);
    expect(failures.map((f) => f.checkRunId)).toEqual([11, 12, 10]);
  });

  it('sinks checks with no completion time to the bottom', () => {
    const failures = collectFailedJobs([
      source(1, [
        check({ id: 10, completed_at: null }),
        check({ id: 11, completed_at: '2026-07-31T10:00:00Z' }),
      ]),
    ]);
    expect(failures.map((f) => f.checkRunId)).toEqual([11, 10]);
  });

  /**
   * details_url carries the run + job ids; html_url is the generic check-run page,
   * so it must only be a fallback.
   */
  it('prefers details_url when resolving run and job ids', () => {
    const [failure] = collectFailedJobs([
      source(1, [
        check({
          id: 10,
          details_url: 'https://github.com/o/r/actions/runs/777/job/888',
          html_url: 'https://github.com/o/r/runs/10',
        }),
      ]),
    ]);
    expect(failure).toMatchObject({ runId: 777, jobId: 888 });
  });

  it('survives a check-run that is not an Actions job', () => {
    const [failure] = collectFailedJobs([
      source(1, [
        check({ id: 10, details_url: 'https://example.com/external-ci', html_url: null }),
      ]),
    ]);
    expect(failure).toMatchObject({ checkRunId: 10, jobId: null, runId: null });
  });

  it('carries the PR context a report needs', () => {
    const [failure] = collectFailedJobs([
      source(7, [check({ id: 10, name: 'java / test (ubuntu, 21)' })], {
        title: 'visual tests refactoring',
        head: { sha: 'deadbeef', ref: 'vt-refactor', label: 'o:vt-refactor', user: null },
        base: { ref: '2026.1', repo: { full_name: SLUG } },
      }),
    ]);
    expect(failure).toMatchObject({
      headSha: 'deadbeef',
      headRef: 'vt-refactor',
      jobName: 'java / test (ubuntu, 21)',
      origin: {
        kind: 'pr',
        prTitle: 'visual tests refactoring',
        prUrl: 'https://github.com/o/r/pull/7',
        baseRef: '2026.1',
      },
    });
  });

  /** Keys must be stable so selection and prefetch survive a poll. */
  it('produces stable keys across repeated collection', () => {
    const build = () => collectFailedJobs([source(1, [check({ id: 10 })])]);
    expect(build()[0].key).toBe(build()[0].key);
  });

  it('keys are unique when two PRs share a check-run id', () => {
    const failures = collectFailedJobs([
      source(1, [check({ id: 10 })]),
      source(2, [check({ id: 10 })]),
    ]);
    expect(new Set(failures.map((f) => f.key)).size).toBe(2);
  });

  it('handles no input at all', () => {
    expect(collectFailedJobs([])).toEqual([]);
    expect(collectFailedJobs([], [])).toEqual([]);
  });
});

function job(over: Partial<Job> & { id: number }): Job {
  return {
    run_id: 900,
    name: `job-${over.id}`,
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-07-31T09:00:00Z',
    completed_at: '2026-07-31T09:30:00Z',
    html_url: `https://github.com/${SLUG}/actions/runs/900/job/${over.id}`,
    check_run_url: `https://api.github.com/repos/${SLUG}/check-runs/${over.id + 5000}`,
    steps: [],
    ...over,
  };
}

function flowRun(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 900,
    name: 'java-cron',
    display_title: 'Nightly',
    head_branch: 'main',
    head_sha: 'cafe123',
    run_number: 42,
    run_attempt: 1,
    event: 'schedule',
    status: 'completed',
    conclusion: 'failure',
    html_url: `https://github.com/${SLUG}/actions/runs/900`,
    created_at: '2026-07-31T09:00:00Z',
    updated_at: '2026-07-31T09:30:00Z',
    run_started_at: '2026-07-31T09:00:00Z',
    path: '.github/workflows/java-cron.yml',
    workflow_id: 46,
    ...over,
  };
}

function flowSource(over: Partial<FlowFailureSource> = {}): FlowFailureSource {
  return {
    flowId: 'flow-java-cron',
    flowName: 'java-cron',
    owner: 'o',
    repo: 'r',
    run: flowRun(),
    jobs: [job({ id: 1 }), job({ id: 2, conclusion: 'success' })],
    ...over,
  };
}

describe('collectFailedJobs — flows', () => {
  it('returns one entry per failing job of a flow run', () => {
    const failures = collectFailedJobs([], [], [flowSource()]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      key: 'flow:flow-java-cron:1',
      origin: {
        kind: 'flow',
        flowId: 'flow-java-cron',
        flowName: 'java-cron',
        runNumber: 42,
        event: 'schedule',
      },
      jobId: 1,
      runId: 900,
      headSha: 'cafe123',
      headRef: 'main',
    });
  });

  /** A flow job's check-run id comes the long way round, via check_run_url. */
  it('resolves the check-run id from the job', () => {
    const [failure] = collectFailedJobs([], [], [flowSource()]);
    expect(failure.checkRunId).toBe(5001);
  });

  it('leaves the check-run id null when the job has no check-run link', () => {
    const [failure] = collectFailedJobs([], [], [
      flowSource({ jobs: [job({ id: 1, check_run_url: undefined })] }),
    ]);
    expect(failure.checkRunId).toBeNull();
  });

  /** The run is already in hand, so no extra read is needed to name the workflow. */
  it('carries the run identity so the report needs no extra fetch', () => {
    const [failure] = collectFailedJobs([], [], [flowSource()]);
    expect(failure).toMatchObject({
      workflowFile: 'java-cron.yml',
      runNumber: 42,
      runAttempt: 1,
    });
  });

  /** A PR check-run says nothing about its workflow, so these stay unknown. */
  it('leaves the run identity unknown for a PR failure', () => {
    const [failure] = collectFailedJobs([source(1, [check({ id: 10 })])]);
    expect(failure).toMatchObject({
      workflowFile: null,
      runNumber: null,
      runAttempt: null,
    });
  });

  /** A bare job name like "test" says nothing on its own in a mixed list. */
  it('prefixes the job name with its workflow file', () => {
    const [failure] = collectFailedJobs([], [], [
      flowSource({ jobs: [job({ id: 1, name: 'test' })] }),
    ]);
    expect(failure.jobName).toBe('java-cron.yml / test');
  });

  it('falls back to the bare job name when the run has no path', () => {
    const [failure] = collectFailedJobs([], [], [
      flowSource({ run: flowRun({ path: undefined }), jobs: [job({ id: 1, name: 'test' })] }),
    ]);
    expect(failure.jobName).toBe('test');
  });

  /** Flows may point at another repo, so the repo travels with the failure. */
  it('carries the flow\'s own owner/repo', () => {
    const [failure] = collectFailedJobs([], [], [
      flowSource({ owner: 'other', repo: 'elsewhere' }),
    ]);
    expect(failure).toMatchObject({ owner: 'other', repo: 'elsewhere' });
  });

  it('puts flow failures after the pull-request ones', () => {
    const failures = collectFailedJobs(
      [source(1, [check({ id: 10 })])],
      [],
      [flowSource()],
    );
    expect(failures.map((f) => f.origin.kind)).toEqual(['pr', 'flow']);
  });

  it('keeps PR and flow keys distinct even on colliding ids', () => {
    const failures = collectFailedJobs(
      [source(1, [check({ id: 1 })])],
      [],
      [flowSource({ flowId: '1' })],
    );
    expect(new Set(failures.map((f) => f.key)).size).toBe(2);
  });
});

describe('groupFailures', () => {
  it('groups failures under their PR, keeping order', () => {
    const failures = collectFailedJobs(
      [source(1, [check({ id: 10 }), check({ id: 11 })])],
      [source(2, [check({ id: 20 })], { merged_at: '2026-07-31T08:00:00Z' })],
    );
    const groups = groupFailures(failures);
    expect(groups.map((g) => [g.id, g.jobs.length, g.badge])).toEqual([
      ['pr:1', 2, 'open'],
      ['pr:2', 1, 'merged'],
    ]);
  });

  it('groups a flow separately, badged by its trigger', () => {
    const groups = groupFailures(collectFailedJobs([], [], [flowSource()]));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'flow:flow-java-cron',
      kind: 'flow',
      title: 'java-cron',
      badge: 'schedule',
    });
  });

  it('keeps PR and flow groups apart', () => {
    const groups = groupFailures(
      collectFailedJobs([source(1, [check({ id: 10 })])], [], [flowSource()]),
    );
    expect(groups.map((g) => g.kind)).toEqual(['pr', 'flow']);
  });

  it('returns nothing for no failures', () => {
    expect(groupFailures([])).toEqual([]);
  });
});

describe('withinScanWindow', () => {
  const now = Date.parse('2026-07-31T12:00:00Z');

  it('keeps a failure from within the last week', () => {
    expect(withinScanWindow(now - 6 * 24 * 3600_000, now)).toBe(true);
  });

  it('drops one older than the window', () => {
    expect(withinScanWindow(now - SCAN_WINDOW_MS - 1000, now)).toBe(false);
  });

  /** Unknown-when must not be read as ancient, or a failure would vanish. */
  it('keeps a failure with no timestamp', () => {
    expect(withinScanWindow(0, now)).toBe(true);
  });
});

describe('collectFailedJobs — scan window', () => {
  const now = Date.parse('2026-07-31T12:00:00Z');
  const old = new Date(now - SCAN_WINDOW_MS - 3600_000).toISOString();
  const fresh = new Date(now - 3600_000).toISOString();

  it('drops PR failures older than a week', () => {
    const failures = collectFailedJobs(
      [source(1, [check({ id: 10, completed_at: old }), check({ id: 11, completed_at: fresh })])],
      [],
      [],
      { owner: 'o', repo: 'r' },
      now,
    );
    expect(failures.map((f) => f.checkRunId)).toEqual([11]);
  });

  it('drops flow failures older than a week', () => {
    const failures = collectFailedJobs(
      [],
      [],
      [flowSource({ jobs: [job({ id: 1, completed_at: old })] })],
      { owner: 'o', repo: 'r' },
      now,
    );
    expect(failures).toEqual([]);
  });

  it('drops merged-PR failures older than a week', () => {
    const failures = collectFailedJobs(
      [],
      [source(2, [check({ id: 20, completed_at: old })], { merged_at: old })],
      [],
      { owner: 'o', repo: 'r' },
      now,
    );
    expect(failures).toEqual([]);
  });
});

describe('sectionFailures', () => {
  const prGroups = () => groupFailures(collectFailedJobs([source(1, [check({ id: 10 })])]));
  const flowGroups = () => groupFailures(collectFailedJobs([], [], [flowSource()]));

  it('puts pull requests before flows, whatever order they arrive in', () => {
    const groups = [...flowGroups(), ...prGroups()];
    expect(sectionFailures(groups).map((s) => s.title)).toEqual(['Pull requests', 'Flows']);
  });

  it('omits a section with nothing in it', () => {
    expect(sectionFailures(prGroups()).map((s) => s.kind)).toEqual(['pr']);
    expect(sectionFailures(flowGroups()).map((s) => s.kind)).toEqual(['flow']);
  });

  it('counts every failing job in the section, not just its groups', () => {
    const groups = groupFailures(
      collectFailedJobs([source(1, [check({ id: 10 }), check({ id: 11 })]), source(2, [check({ id: 20 })])]),
    );
    const [prs] = sectionFailures(groups);
    expect(prs.groups).toHaveLength(2);
    expect(prs.count).toBe(3);
  });

  it('returns nothing when there are no groups', () => {
    expect(sectionFailures([])).toEqual([]);
  });
});

/** Static-ish fixtures for mock mode. One run/PR flips state over time to make polling visible. */

import type {
  ArtifactsResponse,
  CheckRun,
  CheckRunsResponse,
  CombinedStatus,
  Comparison,
  GitRef,
  Job,
  JobsResponse,
  PullRequest,
  Repository,
  WorkflowRun,
  WorkflowRunsResponse,
  WorkflowsResponse,
} from '../api/types';
import type { Flow, MonitorConfig } from '../storage/configStore';
import { workflowBasename } from '../lib/workflow';

const BOOT = Date.now();
/** ~20s after load, the "running" fixtures flip to a terminal state. */
export function flipped(): boolean {
  return Date.now() - BOOT > 20_000;
}

const OWNER = 'devexpress';
const REPO = 'reporting';
const SLUG = `${OWNER}/${REPO}`;
const BRANCH = '2026.1';

/** A flow that watches one concrete workflow (no regex expansion). */
const ONE_WORKFLOW: Flow['match'] = { pattern: '', by: 'name', caseSensitive: false, maxMatches: 12 };

export const MOCK_CONFIG: MonitorConfig = {
  version: 1,
  upstream: { owner: OWNER, repo: REPO },
  // A distinct fork repo name, so the feature-branch tab addresses two different
  // repositories offline — with both names equal, the branch intersection would compare a
  // list against itself and appear to work whatever it did.
  fork: { owner: OWNER, repo: `${REPO}-fork`, branch: null },
  prAuthor: '',
  polling: { prListSeconds: 180, checksSeconds: 60, flowRunsSeconds: 180, hiddenSeconds: 240 },
  notifications: { pr: false, flow: false, autoRerun: false },
  // Armed for the workflow behind PR #37977's failing check, so mock mode
  // exercises the whole auto-rerun loop offline.
  prAutoRerun: {
    enabled: true,
    workflowFiles: ['check-pull-request-java.yml'],
    maxAttempts: 10,
    maxIdenticalFailures: 5,
    maxRunAgeHours: 72,
  },
  mergedPrs: { count: 10 },
  failureReports: { prefetchAnnotations: true, logTailLines: 80, format: 'github' },
  autoMerge: { mergeMethod: 'squash' },
  // On in mock mode: the tab is one of the things worth being able to look at offline.
  diagnostics: { showLogTab: true, tailKB: 512, followSeconds: 3 },
  // On too, for the same reason — and because the actions behind it write to a real
  // repository, so mock mode is the only place to exercise them safely.
  featureBranches: { enabled: true, prefix: 'feature/' },
  ai: {
    enabled: true,
    extraInstructions: '',
    quick: { model: 'sonnet', effort: 'medium', prompt: '' },
    deep: { model: 'opus', effort: 'high', prompt: '' },
    log: { model: 'sonnet', effort: 'low', prompt: '' },
    blame: { model: 'opus', effort: 'medium', prompt: '' },
    pr: { model: 'sonnet', effort: 'medium', prompt: '' },
  },
  autoUpdate: true,
  rateLimitWarnAt: 50,
  flows: [
    {
      id: 'flow-java',
      name: 'java',
      owner: OWNER,
      repo: REPO,
      workflowFile: 'check-pull-request-java.yml',
      branches: [BRANCH],
      events: ['workflow_dispatch', 'push'],
      maxRuns: 5,
      emptyFilter: { enabled: false, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
      match: ONE_WORKFLOW,
    },
    {
      id: 'flow-wpf',
      name: 'wpf-tests',
      owner: OWNER,
      repo: REPO,
      workflowFile: 'wpf-tests.yml',
      branches: [BRANCH],
      events: ['push'],
      maxRuns: 5,
      emptyFilter: { enabled: false, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
      match: ONE_WORKFLOW,
    },
    {
      id: 'flow-visualtests',
      name: 'visualtests',
      owner: OWNER,
      repo: REPO,
      workflowFile: 'visualtests.yml',
      branches: [BRANCH],
      events: ['pull_request'],
      maxRuns: 5,
      emptyFilter: { enabled: false, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
      match: ONE_WORKFLOW,
    },
    {
      id: 'flow-java-cron',
      name: 'java-cron',
      owner: OWNER,
      repo: REPO,
      workflowFile: 'java-cron.yml',
      branches: [BRANCH],
      events: ['workflow_dispatch'],
      maxRuns: 5,
      emptyFilter: { enabled: false, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
      match: ONE_WORKFLOW,
    },
    {
      id: 'flow-publish',
      name: 'publish-artifacts',
      owner: OWNER,
      repo: REPO,
      workflowFile: 'publish.yml',
      branches: [BRANCH],
      events: ['workflow_dispatch'],
      maxRuns: 5,
      emptyFilter: { enabled: false, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
      match: ONE_WORKFLOW,
    },
    {
      // No runs in the mock; its own filter hides it — demonstrates per-flow empty filtering.
      id: 'flow-docs',
      name: 'docs',
      owner: OWNER,
      repo: REPO,
      workflowFile: 'docs.yml',
      branches: [BRANCH],
      events: [],
      maxRuns: 5,
      emptyFilter: { enabled: true, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
      match: ONE_WORKFLOW,
    },
    {
      // Regex flow: expands into one card per matching workflow (nightly-*.yml).
      id: 'flow-nightly',
      name: 'nightly',
      owner: OWNER,
      repo: REPO,
      workflowFile: '',
      branches: [BRANCH],
      events: [],
      maxRuns: 5,
      emptyFilter: { enabled: false, mode: 'hide', by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
      match: { pattern: '^nightly-', by: 'file', caseSensitive: false, maxMatches: 12 },
    },
  ],
  groups: [
    {
      id: 'grp-pr',
      name: 'Pull request checks',
      flowIds: ['flow-java', 'flow-wpf', 'flow-visualtests'],
      collapsed: false,
    },
    { id: 'grp-sched', name: 'Scheduled', flowIds: ['flow-java-cron'], collapsed: false },
    // Listing the regex flow's own id puts all of its matches in this group.
    { id: 'grp-nightly', name: 'Nightly', flowIds: ['flow-nightly'], collapsed: false },
  ],
  ungroupedOrder: [],
};

const SHA_OK = 'aaaa111';
const SHA_FAIL = 'bbbb222';
const SHA_RUN = 'cccc333';

function user(login: string): PullRequest['user'] {
  return {
    login,
    avatar_url: `https://avatars.githubusercontent.com/${login}`,
    html_url: `https://github.com/${login}`,
  };
}

/** Auto-merge armed, as GitHub reports it on the list endpoint. */
const AUTO_MERGE: PullRequest['auto_merge'] = {
  enabled_by: user('a-petrova'),
  merge_method: 'squash',
  commit_title: null,
  commit_message: null,
};

export const MOCK_PULLS: PullRequest[] = [
  {
    id: 1,
    node_id: 'PR_kwDOmock1',
    number: 37977,
    title: 'visual tests refactoring',
    html_url: `https://github.com/${SLUG}/pull/37977`,
    state: 'open',
    draft: false,
    user: user('a-petrova'),
    created_at: new Date(BOOT - 3 * 86400_000).toISOString(),
    // Failing checks *and* auto-merge armed: the exact shape the auto-rerun
    // engine acts on, so mock mode exercises it without a real PR.
    auto_merge: AUTO_MERGE,
    merged_at: null,
    updated_at: new Date(BOOT - 3600_000).toISOString(),
    head: { sha: SHA_FAIL, ref: 'visualtests-refactoring', label: `${OWNER}:visualtests-refactoring`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
  {
    id: 2,
    node_id: 'PR_kwDOmock2',
    number: 37663,
    title: 'space handling',
    html_url: `https://github.com/${SLUG}/pull/37663`,
    state: 'open',
    draft: false,
    user: user('m-litvinov'),
    created_at: new Date(BOOT - 2 * 86400_000).toISOString(),
    auto_merge: null,
    merged_at: null,
    updated_at: new Date(BOOT - 1800_000).toISOString(),
    head: { sha: SHA_RUN, ref: 'space-handling', label: `${OWNER}:space-handling`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
  {
    id: 3,
    node_id: 'PR_kwDOmock3',
    number: 37901,
    title: 'JBR: Implement ComboBox Support in Report Designer Property Grid',
    html_url: `https://github.com/${SLUG}/pull/37901`,
    state: 'open',
    draft: false,
    user: user('jbr-team'),
    created_at: new Date(BOOT - 86400_000).toISOString(),
    auto_merge: null,
    merged_at: null,
    updated_at: new Date(BOOT - 300_000).toISOString(),
    head: { sha: SHA_OK, ref: 'jbr-combobox-property-grid', label: `${OWNER}:jbr-combobox-property-grid`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
];

export function mockCheckRuns(sha: string): CheckRunsResponse {
  const base = (over: Partial<CheckRun> & { id: number }) => ({
    started_at: new Date(BOOT - 600_000).toISOString(),
    completed_at: new Date(BOOT - 300_000).toISOString(),
    // Mirror real GitHub: html_url is the generic /runs/{check_run_id} page,
    // while details_url carries the Actions run + job id (.../actions/runs/{id}/job/{id}).
    html_url: `https://github.com/${SLUG}/runs/${over.id}`,
    details_url: `https://github.com/${SLUG}/actions/runs/1002/job/${over.id}`,
    app: { slug: 'github-actions', name: 'GitHub Actions' },
    ...over,
  });
  const at = (offsetMs: number) => new Date(BOOT - offsetMs).toISOString();
  if (sha === SHA_OK) {
    return {
      total_count: 2,
      check_runs: [
        base({ id: 11, name: 'compile', status: 'completed', conclusion: 'success', started_at: at(600_000), completed_at: at(480_000) }),
        base({ id: 12, name: 'unit-tests', status: 'completed', conclusion: 'success', started_at: at(480_000), completed_at: at(300_000) }),
      ] as CheckRunsResponse['check_runs'],
    };
  }
  if (sha === SHA_FAIL) {
    return {
      total_count: 2,
      check_runs: [
        base({ id: 21, name: 'compile', status: 'completed', conclusion: 'success', started_at: at(600_000), completed_at: at(470_000) }),
        base({ id: 22, name: 'compare-exporttopdf-pdfs', status: 'completed', conclusion: 'failure', started_at: at(470_000), completed_at: at(300_000) }),
      ] as CheckRunsResponse['check_runs'],
    };
  }
  // SHA_RUN: starts in progress, flips to success.
  const done = flipped();
  return {
    total_count: 2,
    check_runs: [
      base({ id: 31, name: 'compile', status: 'completed', conclusion: 'success', started_at: at(600_000), completed_at: at(450_000) }),
      base({
        id: 32,
        name: 'visual-tests',
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? 'success' : null,
        started_at: at(450_000),
        completed_at: done ? new Date().toISOString() : null,
      }),
    ] as CheckRunsResponse['check_runs'],
  };
}

export function mockCombinedStatus(sha: string): CombinedStatus {
  const state = sha === SHA_FAIL ? 'failure' : sha === SHA_RUN && !flipped() ? 'pending' : 'success';
  return { state, total_count: state === 'success' ? 0 : 1, sha, statuses: [] };
}

function run(over: Partial<WorkflowRun> & { id: number }): WorkflowRun {
  return {
    name: 'java',
    display_title: 'Java',
    head_branch: BRANCH,
    head_sha: 'deadbeef',
    run_number: over.id,
    run_attempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/${SLUG}/actions/runs/${over.id}`,
    created_at: new Date(BOOT - 7200_000).toISOString(),
    updated_at: new Date(BOOT - 7000_000).toISOString(),
    run_started_at: new Date(BOOT - 7200_000).toISOString(),
    path: '.github/workflows/check-pull-request-java.yml',
    workflow_id: 42,
    ...over,
  };
}

/**
 * Repo-wide recent runs across several workflows / branches / events — feeds the
 * "browse recent workflows" picker in the flow editor. Spans the full day so the
 * 24h window is visible, plus one run >24h old. Honors the GitHub `created`
 * filter (e.g. ">=<iso>") so mock mode mirrors the real server-side windowing.
 */
export function mockRepoRuns(created?: string | null): WorkflowRunsResponse {
  // created_at + run_started_at both set so the `created` filter behaves like GitHub.
  const at = (h: number) => {
    const iso = new Date(BOOT - h * 3600_000).toISOString();
    return { created_at: iso, run_started_at: iso } as const;
  };
  const runs: WorkflowRun[] = [
    run({ id: 2004, name: 'Publish', display_title: 'Publish 24.1', path: '.github/workflows/publish.yml', workflow_id: 45, event: 'workflow_dispatch', head_branch: 'release/24.1', status: 'in_progress', conclusion: null, ...at(0.2) }),
    run({ id: 2001, name: 'java', display_title: 'CI', path: '.github/workflows/check-pull-request-java.yml', workflow_id: 42, event: 'pull_request', head_branch: 'feature/embedded-fonts', conclusion: 'success', ...at(1) }),
    run({ id: 2002, name: 'WPF Tests', display_title: 'WPF Tests', path: '.github/workflows/wpf-tests.yml', workflow_id: 43, event: 'push', head_branch: 'main', conclusion: 'failure', ...at(4) }),
    run({ id: 2005, name: 'java', display_title: 'CI', path: '.github/workflows/check-pull-request-java.yml', workflow_id: 42, event: 'push', head_branch: 'main', conclusion: 'success', ...at(9) }),
    run({ id: 2003, name: 'Visual Tests', display_title: 'Visual Tests', path: '.github/workflows/visualtests.yml', workflow_id: 44, event: 'schedule', head_branch: 'main', conclusion: 'success', ...at(15) }),
    run({ id: 2006, name: 'java-cron', display_title: 'Nightly Java', path: '.github/workflows/java-cron.yml', workflow_id: 46, event: 'schedule', head_branch: 'main', conclusion: 'success', ...at(22) }),
    // Older than the 24h window — must be filtered out by `created`.
    run({ id: 2007, name: 'Docs', display_title: 'Publish docs', path: '.github/workflows/docs.yml', workflow_id: 47, event: 'schedule', head_branch: 'main', conclusion: 'success', ...at(30) }),
  ];

  let filtered = runs;
  if (created && created.startsWith('>=')) {
    const cutoff = Date.parse(created.slice(2));
    if (!Number.isNaN(cutoff)) filtered = runs.filter((r) => Date.parse(r.created_at) >= cutoff);
  }
  return { total_count: filtered.length, workflow_runs: filtered };
}

/**
 * Runs that a POST to rerun-failed-jobs has already been accepted for.
 *
 * GitHub answers a re-run by bumping `run_attempt` and putting the run back
 * in_progress. Mirroring that here is what makes the auto-rerun loop observable
 * offline — and what stops it looping, since the engine keys idempotency on the
 * attempt number.
 */
const mockRerunAttempts = new Map<number, number>();

export function recordMockRerun(runId: number): void {
  mockRerunAttempts.set(runId, (mockRerunAttempts.get(runId) ?? 1) + 1);
}

/** Apply any re-run that has been requested for this run. */
function withRerun(r: WorkflowRun): WorkflowRun {
  const attempt = mockRerunAttempts.get(r.id);
  if (attempt === undefined) return r;
  return {
    ...r,
    run_attempt: attempt,
    status: 'in_progress',
    conclusion: null,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Workflow runs for one commit — how a PR is mapped to its runs (the `head_sha`
 * query). PR #37977's head has a failing `check-pull-request-java.yml` run, which
 * is what the auto-rerun engine is armed for in MOCK_CONFIG.
 */
export function mockRunsForSha(sha: string): WorkflowRunsResponse {
  const at = (h: number) => {
    const iso = new Date(BOOT - h * 3600_000).toISOString();
    return { created_at: iso, run_started_at: iso } as const;
  };
  const bySha: Record<string, WorkflowRun[]> = {
    [SHA_FAIL]: [
      run({
        id: 1002, name: 'java', display_title: 'visual tests refactoring',
        path: '.github/workflows/check-pull-request-java.yml', workflow_id: 42,
        event: 'pull_request', head_branch: 'visualtests-refactoring', head_sha: SHA_FAIL,
        status: 'completed', conclusion: 'failure', ...at(1),
      }),
      run({
        id: 1005, name: 'Visual Tests', display_title: 'visual tests refactoring',
        path: '.github/workflows/visualtests.yml', workflow_id: 44,
        event: 'pull_request', head_branch: 'visualtests-refactoring', head_sha: SHA_FAIL,
        status: 'completed', conclusion: 'success', ...at(1),
      }),
    ],
    [SHA_RUN]: [
      run({
        id: 1003, name: 'java', display_title: 'space handling',
        path: '.github/workflows/check-pull-request-java.yml', workflow_id: 42,
        event: 'pull_request', head_branch: 'space-handling', head_sha: SHA_RUN,
        status: 'in_progress', conclusion: null, ...at(0.3),
      }),
    ],
    [SHA_OK]: [
      run({
        id: 1004, name: 'java', display_title: 'JBR: ComboBox support',
        path: '.github/workflows/check-pull-request-java.yml', workflow_id: 42,
        event: 'pull_request', head_branch: 'jbr-combobox-property-grid', head_sha: SHA_OK,
        status: 'completed', conclusion: 'success', ...at(2),
      }),
    ],
  };
  const runs = (bySha[sha] ?? []).map(withRerun);
  return { total_count: runs.length, workflow_runs: runs };
}

/** One run by id, across every fixture set that defines runs. */
export function mockSingleRun(runId: number): WorkflowRun {
  for (const sha of [SHA_FAIL, SHA_RUN, SHA_OK]) {
    const hit = mockRunsForSha(sha).workflow_runs.find((r) => r.id === runId);
    if (hit) return hit;
  }
  const fromRepo = mockRepoRuns().workflow_runs.find((r) => r.id === runId);
  return fromRepo ?? withRerun(run({ id: runId }));
}

/**
 * Recently-merged PRs. The first one merged with a failing check, so the Failures
 * tab has a merged example to show alongside the open ones.
 */
export const MOCK_MERGED_PULLS: PullRequest[] = [
  {
    id: 11,
    node_id: 'PR_kwDOmock11',
    number: 37820,
    title: 'fix font metrics on Linux',
    html_url: `https://github.com/${SLUG}/pull/37820`,
    state: 'closed',
    draft: false,
    user: user('a-petrova'),
    created_at: new Date(BOOT - 6 * 86400_000).toISOString(),
    auto_merge: null,
    merged_at: new Date(BOOT - 2 * 3600_000).toISOString(),
    updated_at: new Date(BOOT - 2 * 3600_000).toISOString(),
    head: { sha: SHA_FAIL, ref: 'font-metrics-linux', label: `${OWNER}:font-metrics-linux`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
  {
    id: 12,
    node_id: 'PR_kwDOmock12',
    number: 37744,
    title: 'bump toolchain to 21',
    html_url: `https://github.com/${SLUG}/pull/37744`,
    state: 'closed',
    draft: false,
    user: user('m-litvinov'),
    created_at: new Date(BOOT - 8 * 86400_000).toISOString(),
    auto_merge: null,
    merged_at: new Date(BOOT - 26 * 3600_000).toISOString(),
    updated_at: new Date(BOOT - 26 * 3600_000).toISOString(),
    head: { sha: SHA_OK, ref: 'toolchain-21', label: `${OWNER}:toolchain-21`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
  // Closed without merging — must be filtered out by `merged_at`.
  {
    id: 13,
    node_id: 'PR_kwDOmock13',
    number: 37700,
    title: 'abandoned experiment',
    html_url: `https://github.com/${SLUG}/pull/37700`,
    state: 'closed',
    draft: false,
    user: user('jbr-team'),
    created_at: new Date(BOOT - 9 * 86400_000).toISOString(),
    auto_merge: null,
    merged_at: null,
    updated_at: new Date(BOOT - 48 * 3600_000).toISOString(),
    head: { sha: SHA_RUN, ref: 'experiment', label: `${OWNER}:experiment`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
];

export function mockArtifacts(runId: number): ArtifactsResponse {
  if (runId === 1001) {
    return {
      total_count: 2,
      artifacts: [
        { id: runId * 10 + 1, name: 'test-summary', size_in_bytes: 1_048_576, expired: false },
        { id: runId * 10 + 2, name: 'build-logs', size_in_bytes: 245_760, expired: false },
      ],
    };
  }
  if (runId === 1002) {
    const names: [string, number][] = [
      ['exporttopdf-pdfs', 8_734_208],
      ['coverage-report', 524_288],
      ['unit-test-results', 1_310_720],
      ['junit-xml', 98_304],
      ['screenshots-linux', 6_291_456],
      ['screenshots-windows', 5_767_168],
      ['build-logs', 245_760],
    ];
    return {
      total_count: names.length,
      artifacts: names.map(([name, size_in_bytes], i) => ({
        id: runId * 10 + i + 1,
        name,
        size_in_bytes,
        expired: false,
      })),
    };
  }
  if (runId === 1003) {
    return {
      total_count: 2,
      artifacts: [
        { id: runId * 10 + 1, name: 'diff-screenshots', size_in_bytes: 3_145_728, expired: false },
        { id: runId * 10 + 2, name: 'old-logs', size_in_bytes: 131_072, expired: true },
      ],
    };
  }
  return { total_count: 0, artifacts: [] };
}

/**
 * The repository itself. `permissions.push` is the Write-role half of the
 * token-capability check, so it is `true` here to keep the write-gated features
 * (re-run failed jobs) reachable in mock mode.
 */
export function mockRepository(owner: string, repo: string): Repository {
  return {
    name: repo,
    full_name: `${owner}/${repo}`,
    private: true,
    permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    default_branch: BRANCH,
    // Every repository reports itself as a fork of the upstream, so the fork-parent check
    // passes and the sync action is reachable offline. The mock config points fork and
    // upstream at the same owner, which in reality would fail that check.
    fork: true,
    parent: { full_name: SLUG },
    allow_auto_merge: true,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: false,
  };
}

/* --------------------------------------------------------------- feature branches ---- */

/**
 * Two shared feature branches, plus one that exists only upstream.
 *
 * The odd one out is the point: it must not appear in the tab, since a branch the fork
 * does not have cannot be pulled into it.
 */
const FEATURE_REFS: Record<string, { name: string; sha: string }[]> = {
  [OWNER]: [
    { name: 'feature/reporting-v2', sha: 'f1a2b3c' },
    { name: 'feature/print-preview', sha: 'd4e5f60' },
    { name: 'feature/upstream-only', sha: '9988776' },
  ],
  fork: [
    { name: 'feature/reporting-v2', sha: 'f1a2b3c' },
    // Behind the upstream's copy, so "Pull into my fork" has something to do.
    { name: 'feature/print-preview', sha: '0000aaa' },
  ],
};

export function mockMatchingRefs(repo: string, prefix: string): GitRef[] {
  const refs = FEATURE_REFS[repo === REPO ? OWNER : 'fork'] ?? [];
  return refs
    .filter((r) => r.name.startsWith(prefix))
    .map((r) => ({ ref: `refs/heads/${r.name}`, object: { sha: r.sha, type: 'commit' } }));
}

/**
 * An offer from the fork into the upstream's copy of the same branch — the third leg of the
 * loop, and the only cross-fork pull request the app opens. Head and base carry the same
 * branch name; the head *owner* is what tells them apart.
 */
export const MOCK_FEATURE_PULLS: PullRequest[] = [
  {
    id: 900,
    node_id: 'PR_kwDOmockFB1',
    number: 38100,
    title: 'Reporting v2: server-side grouping',
    html_url: `https://github.com/${SLUG}/pull/38100`,
    state: 'open',
    draft: false,
    body: 'Moves grouping to the server so the client stops re-sorting the whole dataset.',
    user: user('a-petrova'),
    created_at: new Date(BOOT - 2 * 86400_000).toISOString(),
    updated_at: new Date(BOOT - 3600_000).toISOString(),
    auto_merge: AUTO_MERGE,
    merged_at: null,
    mergeable: true,
    mergeable_state: 'blocked',
    head: {
      sha: SHA_RUN,
      ref: 'feature/reporting-v2',
      label: `${OWNER}:feature/reporting-v2`,
      user: user(OWNER),
    },
    base: { ref: 'feature/reporting-v2', repo: { full_name: SLUG } },
  },
];

/**
 * What `compare` answers — used both for the pull-request write-up and for the fork's
 * standing against the upstream.
 *
 * `ahead` with a non-zero `ahead_by` reads, for the standing, as "your fork is 3 commits
 * behind": the base of that comparison is the fork and the head is the upstream.
 */
/**
 * A feature branch trailing the default branch.
 *
 * The fork comparison and the default-branch comparison hit the same endpoint, so the mock has to
 * tell them apart or every branch reads as up to date with `2026.1` — which would make the one part
 * of the row that warns about drift the one part that never fires.
 */
export function mockBehindDefault(): Comparison {
  return {
    status: 'behind',
    ahead_by: 0,
    behind_by: 47,
    total_commits: 47,
    commits: [],
    files: [],
  };
}

export function mockComparison(): Comparison {
  return {
    status: 'ahead',
    ahead_by: 3,
    behind_by: 0,
    total_commits: 3,
    commits: [
      { sha: 'c3', commit: { message: 'Group on the server\n\nlong body', author: { name: 'A' } } },
      { sha: 'c2', commit: { message: 'Add a grouping endpoint', author: { name: 'A' } } },
      { sha: 'c1', commit: { message: 'Extract the sort comparator', author: { name: 'A' } } },
    ],
    files: [
      { filename: 'src/grouping.ts', status: 'modified', additions: 120, deletions: 40 },
      { filename: 'src/api/report.ts', status: 'modified', additions: 18, deletions: 2 },
    ],
  };
}

/** The repo's workflow list — also what regex (pattern) flows are matched against. */
export const MOCK_WORKFLOWS: WorkflowsResponse['workflows'] = [
  { id: 42, name: 'java', path: '.github/workflows/check-pull-request-java.yml', state: 'active' },
  { id: 43, name: 'WPF Tests', path: '.github/workflows/wpf-tests.yml', state: 'active' },
  { id: 44, name: 'Visual Tests', path: '.github/workflows/visualtests.yml', state: 'active' },
  { id: 45, name: 'Publish', path: '.github/workflows/publish.yml', state: 'active' },
  { id: 46, name: 'java-cron', path: '.github/workflows/java-cron.yml', state: 'active' },
  { id: 47, name: 'Docs', path: '.github/workflows/docs.yml', state: 'active' },
  { id: 51, name: 'Nightly Linux', path: '.github/workflows/nightly-linux.yml', state: 'active' },
  { id: 52, name: 'Nightly Windows', path: '.github/workflows/nightly-windows.yml', state: 'active' },
  { id: 53, name: 'Nightly macOS', path: '.github/workflows/nightly-macos.yml', state: 'active' },
];

export function mockWorkflows(): WorkflowsResponse {
  return { total_count: MOCK_WORKFLOWS.length, workflows: MOCK_WORKFLOWS };
}

/**
 * Resolve a workflow reference (file name or numeric id) to its file name —
 * regex-derived flows query by numeric id, so the runs fixtures need both.
 */
export function workflowFileFor(ref: string): string {
  const byId = MOCK_WORKFLOWS.find((w) => String(w.id) === ref.trim());
  return byId ? workflowBasename(byId.path) : ref;
}

/** Which terminal state the *latest* run of each flow lands in, keyed by workflow file. */
const FLOW_LATEST: Record<string, 'success' | 'failure' | 'running'> = {
  'check-pull-request-java.yml': 'success',
  'wpf-tests.yml': 'success',
  'visualtests.yml': 'failure',
  'java-cron.yml': 'failure',
  'publish.yml': 'running',
  'nightly-linux.yml': 'success',
  'nightly-windows.yml': 'failure',
  'nightly-macos.yml': 'running',
};

/** True for workflows the mock serves runs for. Others stay empty (demos the empty-flow filter). */
export function flowHasRuns(wf: string): boolean {
  return Object.prototype.hasOwnProperty.call(FLOW_LATEST, workflowFileFor(wf));
}

const RUN_TITLES = [
  'Remove unnecessary references (#37986)',
  'DevExpress dependencies Update DevExpress (#37990)',
  'Add additional tests for using embedded fonts (#37981)',
  'JBR: Implement ComboBox Support in Report Designer Property Grid (#37901)',
  'add lw-tests to wpf-tests (#37960)',
];

export function mockWorkflowRuns(ref = 'check-pull-request-java.yml'): WorkflowRunsResponse {
  const file = workflowFileFor(ref);
  const latest = FLOW_LATEST[file] ?? 'success';
  const done = flipped();
  const ago = (h: number) => new Date(BOOT - h * 3600_000).toISOString();
  // Each flow's runs must carry *their own* workflow path: it names the workflow in
  // a failure report and prefixes the job name in the Failures list, so inheriting
  // the builder's default would attribute every flow's jobs to one workflow.
  const wf = MOCK_WORKFLOWS.find((w) => workflowBasename(w.path) === file);
  const path = wf?.path ?? `.github/workflows/${file}`;
  const workflow_id = wf?.id;

  const latestRun =
    latest === 'running'
      ? run({
          id: 1001,
          path,
          workflow_id,
          display_title: RUN_TITLES[0],
          event: 'workflow_dispatch',
          head_sha: SHA_RUN,
          status: done ? 'completed' : 'in_progress',
          conclusion: done ? 'success' : null,
          run_started_at: new Date(BOOT - 120_000).toISOString(),
          updated_at: new Date().toISOString(),
        })
      : latest === 'failure'
        ? run({ id: 1003, path, workflow_id, display_title: RUN_TITLES[0], event: 'workflow_dispatch', head_sha: SHA_FAIL, conclusion: 'failure', run_started_at: ago(3) })
        : run({ id: 1002, path, workflow_id, display_title: RUN_TITLES[0], head_sha: SHA_OK, conclusion: 'success', run_started_at: ago(3) });

  // For a failing flow the recent history is mostly red (mirrors a broken cron);
  // otherwise it's green.
  const restConclusions: WorkflowRun['conclusion'][] =
    latest === 'failure' ? ['failure', 'failure', 'success', 'success'] : ['success', 'success', 'success', 'success'];

  const rest = restConclusions.map((conclusion, i) =>
    run({
      id: 1010 + i,
      path,
      workflow_id,
      display_title: RUN_TITLES[i + 1] ?? RUN_TITLES[1],
      conclusion,
      run_started_at: ago(7 + i * 4),
    }),
  );

  return { total_count: 5, workflow_runs: [latestRun, ...rest] };
}

/** Timestamped job log whose lines fall inside the mock steps' time windows. */
export function mockJobLog(jobId: number): string {
  const t = (offsetMs: number) => new Date(BOOT - offsetMs).toISOString();
  const lines: string[] = [
    // step 1 "Set up job"  (window BOOT-120000 .. BOOT-118000)
    `${t(119500)} Current runner version: '2.335.1'`,
    `${t(119000)} ##[group]Operating System`,
    `${t(119000)} Ubuntu 24.04.1 LTS`,
    `${t(119000)} ##[endgroup]`,
    // step 2 "Run build"  (window BOOT-118000 .. BOOT-70000)
    `${t(110000)} ##[group]Run ./gradlew test`,
    `${t(110000)} + ./gradlew test`,
  ];
  if (jobId === 90032) {
    lines.push(
      `${t(100000)} > Task :reporting:compareExportToPdf`,
      `${t(99000)} ExportToPdfTests > compareExportToPdfPdfs FAILED`,
      `${t(99000)}     Expected 0 diffs but got 3`,
      `${t(98000)} ##[error]Process completed with exit code 1.`,
    );
  } else {
    lines.push(`${t(100000)} Compiling sources...`, `${t(80000)} BUILD SUCCESSFUL in 20s`);
  }
  lines.push(
    `${t(72000)} ##[endgroup]`,
    // step 3 "Complete job"  (window BOOT-70000 .. BOOT-60000)
    `${t(65000)} Cleaning up orphan processes`,
    `${t(61000)} Job completed`,
  );
  return lines.join('\n');
}

/** A single job (for PR-check Summary/Logs, fetched from the check-run's job id). */
export function mockSingleJob(jobId: number): Job {
  const names: Record<number, string> = {
    11: 'compile',
    12: 'unit-tests',
    21: 'compile',
    22: 'compare-exporttopdf-pdfs',
    31: 'compile',
    32: 'visual-tests',
  };
  const failing = jobId === 22;
  const start = BOOT - 480_000;
  const end = BOOT - 300_000;
  const setupEnd = start + 6_000;
  const workEnd = end - 4_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: jobId,
    run_id: 1002,
    name: names[jobId] ?? `check ${jobId}`,
    status: 'completed',
    conclusion: failing ? 'failure' : 'success',
    created_at: iso(start - 9_000),
    started_at: iso(start),
    completed_at: iso(end),
    html_url: `https://github.com/${SLUG}/actions/runs/1002/job/${jobId}`,
    check_run_url: `https://api.github.com/repos/${SLUG}/check-runs/${jobId}`,
    steps: [
      { name: 'Set up job', number: 1, status: 'completed', conclusion: 'success', started_at: iso(start), completed_at: iso(setupEnd) },
      { name: 'Run tests', number: 2, status: 'completed', conclusion: failing ? 'failure' : 'success', started_at: iso(setupEnd), completed_at: iso(workEnd) },
      { name: 'Complete job', number: 3, status: 'completed', conclusion: 'success', started_at: iso(workEnd), completed_at: iso(end) },
    ],
  };
}

export function mockAnnotations(checkRunId: number): import('../api/types').Annotation[] {
  if (checkRunId === 22) {
    return [
      {
        path: 'testing/exporttopdf/ExportToPdfTests.java',
        start_line: 88,
        end_line: 88,
        annotation_level: 'failure',
        title: 'Test failed',
        message: 'Expected 0 diffs but got 3 in export-to-pdf comparison.',
        raw_details: null,
      },
    ];
  }
  if (checkRunId === 90032) {
    return [
      {
        path: 'testing/exporttopdf/ExportToPdfTests.java',
        start_line: 88,
        end_line: 88,
        annotation_level: 'failure',
        title: 'compare-exporttopdf-pdfs failed',
        message: 'Process completed with exit code 1.\n  Expected 0 diffs but got 3',
        raw_details: null,
      },
      {
        path: '.github/workflows/java-cron.yml',
        start_line: 40,
        end_line: 40,
        annotation_level: 'warning',
        title: null,
        message: 'The `set-output` command is deprecated.',
        raw_details: null,
      },
    ];
  }
  return [];
}

export function mockJobs(runId: number): JobsResponse {
  const done = flipped();
  const mk = (over: Partial<Job> & { id: number; name: string }): Job => {
    const startMs = over.started_at ? Date.parse(over.started_at) : BOOT - 120_000;
    const running = over.completed_at === null;
    const endMs = running
      ? Date.now()
      : over.completed_at
        ? Date.parse(over.completed_at)
        : BOOT - 60_000;
    const setupEnd = Math.min(startMs + 6_000, endMs); // ~6s runner setup
    const workEnd = Math.max(setupEnd, endMs - 4_000);
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      run_id: runId,
      status: 'completed',
      conclusion: 'success',
      created_at: iso(startMs - 9_000), // ~9s queued before a runner was allocated
      started_at: iso(startMs),
      completed_at: running ? null : iso(endMs),
      html_url: `https://github.com/${SLUG}/actions/runs/${runId}/job/${over.id}`,
      check_run_url: `https://api.github.com/repos/${SLUG}/check-runs/${over.id}`,
      steps: [
        { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, started_at: iso(startMs), completed_at: iso(setupEnd) },
        { name: 'Run build', status: 'completed', conclusion: 'success', number: 2, started_at: iso(setupEnd), completed_at: iso(workEnd) },
        { name: 'Complete job', status: 'completed', conclusion: 'success', number: 3, started_at: iso(workEnd), completed_at: running ? null : iso(endMs) },
      ],
      ...over,
    };
  };
  const at = (offsetMs: number) => new Date(BOOT - offsetMs).toISOString();
  if (runId === 1001) {
    return {
      total_count: 2,
      jobs: [
        // build runs first, integration-tests starts after build (staggered offsets)
        mk({ id: 90011, name: 'compile', started_at: at(300_000), completed_at: at(220_000) }),
        mk({
          id: 90012,
          name: 'visual-tests',
          started_at: at(220_000),
          status: done ? 'completed' : 'in_progress',
          conclusion: done ? 'success' : null,
          completed_at: done ? new Date().toISOString() : null,
        }),
      ],
    };
  }
  if (runId === 1003) {
    return {
      total_count: 2,
      jobs: [
        mk({ id: 90031, name: 'compile', started_at: at(300_000), completed_at: at(200_000) }),
        mk({ id: 90032, name: 'compare-exporttopdf-pdfs', conclusion: 'failure', started_at: at(200_000), completed_at: at(60_000) }),
      ],
    };
  }
  return { total_count: 1, jobs: [mk({ id: 90021, name: 'compile' })] };
}

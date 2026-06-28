/** Static-ish fixtures for mock mode. One run/PR flips state over time to make polling visible. */

import type {
  ArtifactsResponse,
  CheckRun,
  CheckRunsResponse,
  CombinedStatus,
  Job,
  JobsResponse,
  PullRequest,
  WorkflowRun,
  WorkflowRunsResponse,
  WorkflowsResponse,
} from '../api/types';
import type { MonitorConfig } from '../storage/configStore';

const BOOT = Date.now();
/** ~20s after load, the "running" fixtures flip to a terminal state. */
export function flipped(): boolean {
  return Date.now() - BOOT > 20_000;
}

const OWNER = 'devexpress';
const REPO = 'reporting';
const SLUG = `${OWNER}/${REPO}`;
const BRANCH = '2026.1';

export const MOCK_CONFIG: MonitorConfig = {
  version: 1,
  upstream: { owner: OWNER, repo: REPO },
  fork: { owner: OWNER, branch: null },
  prAuthor: '',
  polling: { prListSeconds: 180, checksSeconds: 60, flowRunsSeconds: 180, hiddenSeconds: 240 },
  notifications: { pr: false, flow: false },
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
      emptyFilter: { enabled: false, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
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
      emptyFilter: { enabled: false, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
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
      emptyFilter: { enabled: false, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
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
      emptyFilter: { enabled: false, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
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
      emptyFilter: { enabled: false, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
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
      emptyFilter: { enabled: true, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
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
  ],
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

export const MOCK_PULLS: PullRequest[] = [
  {
    id: 1,
    number: 37977,
    title: 'visual tests refactoring',
    html_url: `https://github.com/${SLUG}/pull/37977`,
    state: 'open',
    draft: false,
    user: user('a-petrova'),
    created_at: new Date(BOOT - 3 * 86400_000).toISOString(),
    updated_at: new Date(BOOT - 3600_000).toISOString(),
    head: { sha: SHA_FAIL, ref: 'visualtests-refactoring', label: `${OWNER}:visualtests-refactoring`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
  {
    id: 2,
    number: 37663,
    title: 'space handling',
    html_url: `https://github.com/${SLUG}/pull/37663`,
    state: 'open',
    draft: false,
    user: user('m-litvinov'),
    created_at: new Date(BOOT - 2 * 86400_000).toISOString(),
    updated_at: new Date(BOOT - 1800_000).toISOString(),
    head: { sha: SHA_RUN, ref: 'space-handling', label: `${OWNER}:space-handling`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
  {
    id: 3,
    number: 37901,
    title: 'JBR: Implement ComboBox Support in Report Designer Property Grid',
    html_url: `https://github.com/${SLUG}/pull/37901`,
    state: 'open',
    draft: false,
    user: user('jbr-team'),
    created_at: new Date(BOOT - 86400_000).toISOString(),
    updated_at: new Date(BOOT - 300_000).toISOString(),
    head: { sha: SHA_OK, ref: 'jbr-combobox-property-grid', label: `${OWNER}:jbr-combobox-property-grid`, user: user(OWNER) },
    base: { ref: BRANCH, repo: { full_name: SLUG } },
  },
];

export function mockCheckRuns(sha: string): CheckRunsResponse {
  const base = (over: Partial<CheckRun> & { id: number }) => ({
    started_at: new Date(BOOT - 600_000).toISOString(),
    completed_at: new Date(BOOT - 300_000).toISOString(),
    // details_url carries the job id (.../job/{id}) — enables per-check Summary/Logs.
    html_url: `https://github.com/${SLUG}/actions/runs/1002/job/${over.id}`,
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
    ...over,
  };
}

export function mockArtifacts(runId: number): ArtifactsResponse {
  if (runId === 1001) {
    return {
      total_count: 1,
      artifacts: [{ id: 1, name: 'test-summary', size_in_bytes: 1_048_576, expired: false }],
    };
  }
  return { total_count: 0, artifacts: [] };
}

export function mockWorkflows(): WorkflowsResponse {
  return {
    total_count: 1,
    workflows: [{ id: 42, name: 'java', path: '.github/workflows/check-pull-request-java.yml', state: 'active' }],
  };
}

/** Which terminal state the *latest* run of each flow lands in, keyed by workflow file. */
const FLOW_LATEST: Record<string, 'success' | 'failure' | 'running'> = {
  'check-pull-request-java.yml': 'success',
  'wpf-tests.yml': 'success',
  'visualtests.yml': 'failure',
  'java-cron.yml': 'failure',
  'publish.yml': 'running',
};

/** True for workflows the mock serves runs for. Others stay empty (demos the empty-flow filter). */
export function flowHasRuns(wf: string): boolean {
  return wf === '42' || Object.prototype.hasOwnProperty.call(FLOW_LATEST, wf);
}

const RUN_TITLES = [
  'Remove unnecessary references (#37986)',
  'DevExpress dependencies Update DevExpress (#37990)',
  'Add additional tests for using embedded fonts (#37981)',
  'JBR: Implement ComboBox Support in Report Designer Property Grid (#37901)',
  'add lw-tests to wpf-tests (#37960)',
];

export function mockWorkflowRuns(wf = 'check-pull-request-java.yml'): WorkflowRunsResponse {
  const latest = FLOW_LATEST[wf] ?? 'success';
  const done = flipped();
  const ago = (h: number) => new Date(BOOT - h * 3600_000).toISOString();

  const latestRun =
    latest === 'running'
      ? run({
          id: 1001,
          display_title: RUN_TITLES[0],
          event: 'workflow_dispatch',
          head_sha: SHA_RUN,
          status: done ? 'completed' : 'in_progress',
          conclusion: done ? 'success' : null,
          run_started_at: new Date(BOOT - 120_000).toISOString(),
          updated_at: new Date().toISOString(),
        })
      : latest === 'failure'
        ? run({ id: 1003, display_title: RUN_TITLES[0], event: 'workflow_dispatch', head_sha: SHA_FAIL, conclusion: 'failure', run_started_at: ago(3) })
        : run({ id: 1002, display_title: RUN_TITLES[0], head_sha: SHA_OK, conclusion: 'success', run_started_at: ago(3) });

  // For a failing flow the recent history is mostly red (mirrors a broken cron);
  // otherwise it's green.
  const restConclusions: WorkflowRun['conclusion'][] =
    latest === 'failure' ? ['failure', 'failure', 'success', 'success'] : ['success', 'success', 'success', 'success'];

  const rest = restConclusions.map((conclusion, i) =>
    run({
      id: 1010 + i,
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

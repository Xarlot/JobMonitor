/** Static-ish fixtures for mock mode. One run/PR flips state over time to make polling visible. */

import type {
  ArtifactsResponse,
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

export const MOCK_CONFIG: MonitorConfig = {
  version: 1,
  upstream: { owner: 'acme', repo: 'rocket' },
  fork: { owner: 'octodev', branch: null },
  prAuthor: 'octodev',
  polling: { prListSeconds: 180, checksSeconds: 60, flowRunsSeconds: 180, hiddenSeconds: 240 },
  rateLimitWarnAt: 50,
  flows: [
    {
      id: 'mock-flow-ci',
      name: 'CI',
      owner: 'acme',
      repo: 'rocket',
      workflowFile: 'ci.yml',
      branches: ['main'],
      events: ['workflow_dispatch', 'push'],
      maxRuns: 5,
      emptyFilter: { enabled: false, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
    },
    {
      // No runs in the mock; its own filter hides it — demonstrates per-flow empty filtering.
      id: 'mock-flow-docs',
      name: 'Docs',
      owner: 'acme',
      repo: 'rocket',
      workflowFile: 'docs.yml',
      branches: ['main'],
      events: [],
      maxRuns: 5,
      emptyFilter: { enabled: true, by: 'no_runs', minArtifactKB: 0, jobName: '', jobState: 'skipped' },
    },
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
    number: 101,
    title: 'Add booster telemetry',
    html_url: 'https://github.com/acme/rocket/pull/101',
    state: 'open',
    draft: false,
    user: user('octodev'),
    created_at: new Date(BOOT - 3 * 86400_000).toISOString(),
    updated_at: new Date(BOOT - 3600_000).toISOString(),
    head: { sha: SHA_OK, ref: 'feature/telemetry', label: 'octodev:feature/telemetry', user: user('octodev') },
    base: { ref: 'main', repo: { full_name: 'acme/rocket' } },
  },
  {
    id: 2,
    number: 102,
    title: 'Fix fuel mixture calc',
    html_url: 'https://github.com/acme/rocket/pull/102',
    state: 'open',
    draft: false,
    user: user('octodev'),
    created_at: new Date(BOOT - 2 * 86400_000).toISOString(),
    updated_at: new Date(BOOT - 1800_000).toISOString(),
    head: { sha: SHA_FAIL, ref: 'fix/fuel', label: 'octodev:fix/fuel', user: user('octodev') },
    base: { ref: 'main', repo: { full_name: 'acme/rocket' } },
  },
  {
    id: 3,
    number: 103,
    title: 'Refactor guidance loop',
    html_url: 'https://github.com/acme/rocket/pull/103',
    state: 'open',
    draft: true,
    user: user('octodev'),
    created_at: new Date(BOOT - 86400_000).toISOString(),
    updated_at: new Date(BOOT - 300_000).toISOString(),
    head: { sha: SHA_RUN, ref: 'refactor/guidance', label: 'octodev:refactor/guidance', user: user('octodev') },
    base: { ref: 'main', repo: { full_name: 'acme/rocket' } },
  },
];

export function mockCheckRuns(sha: string): CheckRunsResponse {
  const base = (over: object) => ({
    started_at: new Date(BOOT - 600_000).toISOString(),
    completed_at: new Date(BOOT - 300_000).toISOString(),
    html_url: `https://github.com/acme/rocket/runs/x`,
    details_url: null,
    app: { slug: 'github-actions', name: 'GitHub Actions' },
    ...over,
  });
  if (sha === SHA_OK) {
    return {
      total_count: 2,
      check_runs: [
        base({ id: 11, name: 'build', status: 'completed', conclusion: 'success' }),
        base({ id: 12, name: 'test', status: 'completed', conclusion: 'success' }),
      ] as CheckRunsResponse['check_runs'],
    };
  }
  if (sha === SHA_FAIL) {
    return {
      total_count: 2,
      check_runs: [
        base({ id: 21, name: 'build', status: 'completed', conclusion: 'success' }),
        base({ id: 22, name: 'test', status: 'completed', conclusion: 'failure' }),
      ] as CheckRunsResponse['check_runs'],
    };
  }
  // SHA_RUN: starts in progress, flips to success.
  const done = flipped();
  return {
    total_count: 2,
    check_runs: [
      base({ id: 31, name: 'build', status: 'completed', conclusion: 'success' }),
      base({
        id: 32,
        name: 'integration',
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? 'success' : null,
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
    name: 'CI',
    display_title: 'CI',
    head_branch: 'main',
    head_sha: 'deadbeef',
    run_number: over.id,
    run_attempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/acme/rocket/actions/runs/${over.id}`,
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
      artifacts: [{ id: 1, name: 'build-output', size_in_bytes: 1_048_576, expired: false }],
    };
  }
  return { total_count: 0, artifacts: [] };
}

export function mockWorkflows(): WorkflowsResponse {
  return {
    total_count: 1,
    workflows: [{ id: 42, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }],
  };
}

export function mockWorkflowRuns(): WorkflowRunsResponse {
  const done = flipped();
  return {
    total_count: 3,
    workflow_runs: [
      run({
        id: 1001,
        display_title: 'Add booster telemetry',
        event: 'workflow_dispatch',
        head_sha: SHA_RUN,
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? 'success' : null,
        run_started_at: new Date(BOOT - 120_000).toISOString(),
        updated_at: new Date().toISOString(),
      }),
      run({ id: 1002, display_title: 'Fix fuel mixture calc', head_sha: SHA_OK, conclusion: 'success' }),
      run({ id: 1003, display_title: 'Nightly', event: 'schedule', head_sha: SHA_FAIL, conclusion: 'failure' }),
    ],
  };
}

export function mockJobs(runId: number): JobsResponse {
  const done = flipped();
  const mk = (over: Partial<Job> & { id: number; name: string }): Job => ({
    run_id: runId,
    status: 'completed',
    conclusion: 'success',
    started_at: new Date(BOOT - 120_000).toISOString(),
    completed_at: new Date(BOOT - 60_000).toISOString(),
    html_url: `https://github.com/acme/rocket/actions/runs/${runId}/job/${over.id}`,
    steps: [],
    ...over,
  });
  if (runId === 1001) {
    return {
      total_count: 2,
      jobs: [
        mk({ id: 90011, name: 'build' }),
        mk({
          id: 90012,
          name: 'integration-tests',
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
      jobs: [mk({ id: 90031, name: 'build' }), mk({ id: 90032, name: 'deploy', conclusion: 'failure' })],
    };
  }
  return { total_count: 1, jobs: [mk({ id: 90021, name: 'build' })] };
}

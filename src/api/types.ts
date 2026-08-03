/**
 * Subset of GitHub REST API response shapes that the dashboard consumes,
 * plus the normalized domain status used throughout the UI.
 *
 * Only the fields we actually read are typed; responses contain much more.
 */

/** GitHub check-run / workflow lifecycle state. */
export type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'waiting'
  | 'requested'
  | 'pending';

/** Terminal result of a completed run. `null` while not yet completed. */
export type RunConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | 'startup_failure'
  | null;

/** Normalized status used by StatusBadge and aggregation. */
export type OverallStatus =
  | 'success'
  | 'failure'
  | 'pending'
  | 'in_progress'
  | 'neutral'
  | 'unknown';

export interface GitHubUser {
  login: string;
  avatar_url: string;
  html_url: string;
}

/**
 * Minimal repository shape. `permissions` is only present on authenticated
 * requests and reflects the **authenticated account's role**, not the token's
 * own grants — see tokenCapability.ts for why that distinction matters.
 */
export interface Repository {
  name: string;
  full_name: string;
  private: boolean;
  permissions?: {
    admin: boolean;
    maintain?: boolean;
    push: boolean;
    triage?: boolean;
    pull: boolean;
  };
}

/** Present (non-null) on a pull request that is queued behind auto-merge. */
export interface AutoMerge {
  enabled_by: GitHubUser | null;
  merge_method: 'merge' | 'squash' | 'rebase';
  commit_title: string | null;
  commit_message: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  user: GitHubUser | null;
  created_at: string;
  updated_at: string;
  /** Non-null when auto-merge is armed. Returned by the list endpoint too. */
  auto_merge: AutoMerge | null;
  /** Set once the PR has been merged; null for open and closed-unmerged PRs. */
  merged_at: string | null;
  head: {
    sha: string;
    ref: string;
    label: string;
    user: GitHubUser | null;
  };
  base: {
    ref: string;
    repo: { full_name: string } | null;
  };
}

export interface CheckRun {
  id: number;
  name: string;
  status: RunStatus;
  conclusion: RunConclusion;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  details_url: string | null;
  app: { slug: string; name: string } | null;
}

export interface CheckRunsResponse {
  total_count: number;
  check_runs: CheckRun[];
}

export interface CommitStatusItem {
  id: number;
  state: 'success' | 'pending' | 'failure' | 'error';
  context: string;
  description: string | null;
  target_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface CombinedStatus {
  state: 'success' | 'pending' | 'failure';
  total_count: number;
  sha: string;
  statuses: CommitStatusItem[];
}

export interface WorkflowRun {
  id: number;
  name: string | null;
  display_title: string;
  head_branch: string | null;
  head_sha: string;
  run_number: number;
  run_attempt: number;
  event: string;
  status: RunStatus;
  conclusion: RunConclusion;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  /** Workflow file path, e.g. ".github/workflows/ci.yml" (present on repo-wide runs). */
  path?: string;
  /** Numeric id of the workflow this run belongs to. */
  workflow_id?: number;
}

export interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: WorkflowRun[];
}

export interface Workflow {
  id: number;
  name: string;
  /** e.g. ".github/workflows/ci.yml" */
  path: string;
  state: string;
}

export interface WorkflowsResponse {
  total_count: number;
  workflows: Workflow[];
}

export interface JobStep {
  name: string;
  status: RunStatus;
  conclusion: RunConclusion;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface Job {
  id: number;
  run_id: number;
  name: string;
  status: RunStatus;
  conclusion: RunConclusion;
  /** When the job was queued (before a runner was allocated). */
  created_at?: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  /** API URL of the job's check-run; the trailing id is used to fetch annotations. */
  check_run_url?: string;
  steps: JobStep[];
}

export interface Annotation {
  path: string;
  start_line: number | null;
  end_line: number | null;
  annotation_level: 'notice' | 'warning' | 'failure' | null;
  message: string | null;
  title: string | null;
  raw_details: string | null;
}

export interface JobsResponse {
  total_count: number;
  jobs: Job[];
}

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

export interface ArtifactsResponse {
  total_count: number;
  artifacts: Artifact[];
}

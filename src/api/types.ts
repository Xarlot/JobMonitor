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
  /** The branch a PR targets by default — "main" here, whatever it is actually called. */
  default_branch?: string;
  /** True for a fork; `parent` then names what it was forked from. */
  fork?: boolean;
  /**
   * The repository this one was forked from. Load-bearing for the fork sync: the
   * merge-upstream endpoint syncs from *this*, not from whatever the app has configured
   * as the upstream, and it succeeds either way — so the two have to be compared first.
   */
  parent?: { full_name: string } | null;
  /**
   * Which merge strategies the repository permits, and whether auto-merge is switched on
   * at all. Absent on an unauthenticated read. Worth checking up front: GitHub refuses
   * the auto-merge mutation for either reason, and by then the pull request already exists.
   */
  allow_auto_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
}

/** One entry of `git/matching-refs`: `ref` is fully qualified (`refs/heads/feature/x`). */
export interface GitRef {
  ref: string;
  object: { sha: string; type: string };
}

/** The answer from merge-upstream. `none` means the branch was already up to date. */
export interface MergeUpstreamResult {
  message: string;
  merge_type?: 'merge' | 'fast-forward' | 'none';
  base_branch?: string;
}

/** What `compare/{base}...{head}` returns, trimmed to the fields the app reads. */
export interface Comparison {
  status: string;
  ahead_by: number;
  behind_by: number;
  /** The true number of commits, which `commits` is capped below on a large range. */
  total_commits: number;
  /**
   * The commits in `head` that `base` lacks. `parents` distinguishes a merge (two or more)
   * from authored work, which is what separates a branch's own commits from the merge
   * commits a fork sync leaves behind. Capped at 250 by GitHub.
   */
  commits: {
    sha: string;
    parents?: { sha: string }[];
    commit: { message: string; author: { name?: string } | null };
  }[];
  /** Absent past the first page, and capped at 300 by GitHub. */
  files?: { filename: string; status: string; additions: number; deletions: number }[];
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
  /**
   * GraphQL global id. Present on every REST PR payload, and the only way to name a PR
   * to `enablePullRequestAutoMerge` — the mutation takes a node id, not owner/repo/number.
   */
  node_id: string;
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  /**
   * The description. Optional here rather than `string | null`: the list endpoint does
   * return it, but nothing in the dashboard depends on it being present — only the
   * arm-auto-merge dialog reads it, to show what it is about to delete.
   */
  body?: string | null;
  user: GitHubUser | null;
  created_at: string;
  updated_at: string;
  /** Non-null when auto-merge is armed. Returned by the list endpoint too. */
  auto_merge: AutoMerge | null;
  /** Set once the PR has been merged; null for open and closed-unmerged PRs. */
  merged_at: string | null;
  /**
   * Whether GitHub can merge this PR as it stands. **Only present on the single-PR
   * endpoint**, and `null` there until a background job has worked it out — so a caller
   * that acts on it has to poll until it isn't null rather than read it once.
   */
  mergeable?: boolean | null;
  /**
   * Why it can or can't: `clean`, `blocked`, `behind`, `dirty`, `unstable`, `draft`,
   * `has_hooks`, `unknown`. Typed as a plain string on purpose — the set is undocumented
   * and GitHub adds to it, so a union here would turn a new value into a type error
   * rather than the "something we don't recognise" the UI can already render.
   */
  mergeable_state?: string;
  /** Single-PR endpoint only; `merged_at` covers the same ground on the list. */
  merged?: boolean;
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

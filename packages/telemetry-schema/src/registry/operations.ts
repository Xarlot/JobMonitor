/**
 * Operations — things that take time and can fail.
 *
 * Each one carries a count, a duration sum, a max, and an 8-bucket histogram; failures are counted
 * separately by error category. Individual durations never leave the machine.
 *
 *   1000  GitHub reads            1200  local CLI (gh, claude)
 *   1100  local computation       1300  app lifecycle
 *
 * Deliberately *not* derived from the HTTP layer. `src/api/requestStats.ts` already records every
 * request's outcome, but per-request is the wrong grain: it has no duration, no notion of the work
 * a request was part of, and one user-visible operation is often several requests.
 */

import { buildRegistry, idEnum, type Def, type IdOf } from './registry';

const defs = {
  // ── 1000 GitHub reads ────────────────────────────────────────────────────────────────────────
  // The first four are all instrumented by one change to usePolling.ts.
  GH_PR_LIST_POLL: { id: 1000, key: 'gh.pr_list_poll' },
  GH_CHECKS_POLL: { id: 1001, key: 'gh.checks_poll' },
  GH_FLOW_RUNS_POLL: { id: 1002, key: 'gh.flow_runs_poll' },
  GH_FEATURE_BRANCHES_POLL: { id: 1003, key: 'gh.feature_branches_poll' },
  GH_JOBS_FETCH: { id: 1004, key: 'gh.jobs_fetch' },
  GH_ANNOTATIONS_FETCH: { id: 1005, key: 'gh.annotations_fetch' },
  GH_WORKFLOW_LIST: { id: 1006, key: 'gh.workflow_list' },
  GH_JOB_LOG_FETCH: { id: 1007, key: 'gh.job_log_fetch' },
  GH_ARTIFACT_LIST: { id: 1008, key: 'gh.artifact_list' },
  GH_ARTIFACT_DOWNLOAD: { id: 1009, key: 'gh.artifact_download' },
  GH_TOKEN_CAPABILITY: { id: 1010, key: 'gh.token_capability' },
  /**
   * The auto-rerun engine's own poll.
   *
   * Separate from GH_CHECKS_POLL even though it reads the same runs: this one fires on its own
   * schedule while armed, and its cost is paid by people who are not looking at the app. Folding
   * it into the dashboard polls would make the app look busier the moment anyone armed a rerun.
   */
  GH_AUTO_RERUN_POLL: { id: 1011, key: 'gh.auto_rerun_poll' },

  // GitHub writes. The only two write endpoints, plus the branch helpers that compose them.
  GH_RERUN_WRITE: { id: 1020, key: 'gh.rerun_write' },
  GH_AUTOMERGE_WRITE: { id: 1021, key: 'gh.automerge_write' },
  GH_BRANCH_ACTION: { id: 1022, key: 'gh.branch_action' },
  GH_FORK_SYNC: { id: 1023, key: 'gh.fork_sync' },

  // ── 1100 local computation ───────────────────────────────────────────────────────────────────
  // Cheap individually, but they run on every poll against every flow, so a regression here is
  // felt as general sluggishness rather than as a slow request.
  FLOW_PATTERN_EVAL: { id: 1100, key: 'flow.pattern_eval' },
  /**
   * Reserved, not yet reachable: groups are a stored order, not a computation worth timing. Kept rather than removed so the id is never handed to
   * something else — a receiver that has already seen this key would relabel the new value with
   * the old name.
   */
  FLOW_GROUP_RESOLVE: { id: 1101, key: 'flow.group_resolve' },
  FAILURES_SCAN: { id: 1102, key: 'failures.scan' },
  ARTIFACT_BUNDLE_ZIP: { id: 1103, key: 'artifact.bundle_zip' },

  // ── 1200 local CLI ───────────────────────────────────────────────────────────────────────────
  CLAUDE_PROBE: { id: 1200, key: 'claude.probe' },
  CLAUDE_QUICK: { id: 1201, key: 'claude.quick' },
  CLAUDE_DEEP: { id: 1202, key: 'claude.deep' },
  CLAUDE_BLAME: { id: 1203, key: 'claude.blame' },
  CLAUDE_LOG_FETCH: { id: 1204, key: 'claude.log_fetch' },
  CLAUDE_PR_COMPOSE: { id: 1205, key: 'claude.pr_compose' },

  // ── 1300 app lifecycle ───────────────────────────────────────────────────────────────────────
  APP_STARTUP: { id: 1300, key: 'app.startup' },
  RENDERER_BOOT: { id: 1301, key: 'renderer.boot' },
  CONFIG_LOAD: { id: 1302, key: 'config.load' },
  /**
   * Worth measuring on its own: src/crypto/webcrypto.ts uses 600,000 PBKDF2 iterations, so this is
   * the first thing a user waits on at every single unlock.
   */
  TOKEN_DECRYPT: { id: 1303, key: 'token.decrypt' },
  UPDATE_DOWNLOAD: { id: 1304, key: 'update.download' },
} as const satisfies Record<string, Def>;

/** Ids that once existed. Never reuse one. */
const TOMBSTONES: readonly number[] = [];

export const OPERATION_DEFS = defs;
export const Operations = buildRegistry('Operation', defs, TOMBSTONES);

/** Call-site enum: `Telemetry.measure(Operation.GH_JOB_LOG_FETCH, …)`. */
export const Operation = idEnum(defs);
export type Operation = IdOf<typeof defs>;

/**
 * Features — things a person did.
 *
 * Ids are allocated in blocks of 100 by area so a new value is appended to its block rather than
 * to the end of the file, which keeps related things numerically adjacent and makes a mistyped id
 * land somewhere obviously wrong.
 *
 *   100  shell and lifecycle      500  writes
 *   200  navigation and PRs       600  AI
 *   300  flows                    700  artifacts
 *   400  failures and logs        800  configuration
 *                                 900  feature branches
 *
 * Adding a value here does NOT bump SCHEMA_VERSION. That is the whole point of numeric ids: a
 * receiver that has never heard of 314 records it as `unknown(314)` and keeps the rest of the
 * batch. Removing one means adding its id to TOMBSTONES, never deleting the line silently.
 */

import { buildRegistry, idEnum, type Def, type IdOf } from './registry';

const defs = {
  // ── 100 shell and lifecycle ──────────────────────────────────────────────────────────────────
  APP_LAUNCHED: { id: 100, key: 'app.launched' },
  /** A second launch folding into the running instance. Explicitly *not* an app start. */
  APP_SECOND_INSTANCE: { id: 101, key: 'app.second_instance' },
  WINDOW_SHOWN: { id: 102, key: 'window.shown' },
  WINDOW_HIDDEN_TO_TRAY: { id: 103, key: 'window.hidden_to_tray' },
  TRAY_MENU_OPENED: { id: 104, key: 'tray.menu_opened' },
  SETTINGS_OPENED: { id: 105, key: 'settings.opened' },
  THEME_CHANGED: { id: 106, key: 'theme.changed' },
  COMPACT_MODE_TOGGLED: { id: 107, key: 'compact_mode.toggled' },
  UPDATE_CHECK_MANUAL: { id: 108, key: 'update.check_manual' },
  UPDATE_INSTALLED: { id: 109, key: 'update.installed' },
  TOKEN_UNLOCKED: { id: 110, key: 'token.unlocked' },
  TOKEN_REMEMBERED: { id: 111, key: 'token.remembered' },
  /** The ErrorBoundary's "Reset local data". Worth knowing how often people reach for it. */
  LOCAL_DATA_RESET: { id: 112, key: 'local_data.reset' },

  // ── 200 navigation and pull requests ─────────────────────────────────────────────────────────
  // The six views in App.tsx. Recorded from the nav click handler, never from render.
  VIEW_OVERVIEW: { id: 200, key: 'view.overview' },
  VIEW_PRS: { id: 201, key: 'view.prs' },
  VIEW_BRANCHES: { id: 202, key: 'view.branches' },
  VIEW_FLOWS: { id: 203, key: 'view.flows' },
  VIEW_FAILURES: { id: 204, key: 'view.failures' },
  VIEW_DIAGNOSTICS: { id: 205, key: 'view.diagnostics' },
  PR_OPENED_EXTERNAL: { id: 210, key: 'pr.opened_external' },
  PR_CHECKS_EXPANDED: { id: 211, key: 'pr.checks_expanded' },
  PR_CHECK_RUN_DIALOG: { id: 212, key: 'pr.check_run_dialog' },

  // ── 300 flows ────────────────────────────────────────────────────────────────────────────────
  FLOW_CREATED: { id: 300, key: 'flow.created' },
  FLOW_EDITED: { id: 301, key: 'flow.edited' },
  FLOW_DELETED: { id: 302, key: 'flow.deleted' },
  /** A flow matching workflows by regex rather than by an explicit file list. */
  FLOW_MATCH_REGEX_USED: { id: 303, key: 'flow.match_regex_used' },
  FLOW_GROUP_CREATED: { id: 304, key: 'flow.group_created' },
  FLOW_BOARD_EXPORTED: { id: 305, key: 'flow.board_exported' },
  FLOW_BOARD_IMPORTED: { id: 306, key: 'flow.board_imported' },
  FLOW_EMPTY_FILTER_USED: { id: 307, key: 'flow.empty_filter_used' },
  FLOW_WORKFLOW_BROWSER_OPENED: { id: 308, key: 'flow.workflow_browser_opened' },
  FLOW_UNMATCHED_DIALOG_OPENED: { id: 309, key: 'flow.unmatched_dialog_opened' },
  FLOW_RUN_EXPANDED: { id: 310, key: 'flow.run_expanded' },

  // ── 400 failures and logs ────────────────────────────────────────────────────────────────────
  LOGS_JOB_OPENED: { id: 400, key: 'logs.job_opened' },
  LOGS_JOB_SUMMARY_OPENED: { id: 401, key: 'logs.job_summary_opened' },
  LOGS_TIMELINE_OPENED: { id: 402, key: 'logs.timeline_opened' },
  LOGS_OVERALL_SUMMARY_OPENED: { id: 403, key: 'logs.overall_summary_opened' },
  /**
   * Reserved, not yet reachable: the log viewer has no search. Kept rather than removed so the id
   * is never handed to something else — a receiver that has already seen `logs.search_used` would
   * silently relabel the new feature with the old name.
   */
  LOGS_SEARCH_USED: { id: 404, key: 'logs.search_used' },
  FAILURES_REPORT_COPIED: { id: 405, key: 'failures.report_copied' },
  /**
   * Reserved, not yet reachable: failures are grouped by kind, and nothing lets a person make a group. Kept rather than removed so the id is never handed to
   * something else — a receiver that has already seen this key would relabel the new value with
   * the old name.
   */
  FAILURES_GROUP_CREATED: { id: 406, key: 'failures.group_created' },

  // ── 500 writes ───────────────────────────────────────────────────────────────────────────────
  // The app has exactly two write endpoints; both are represented here.
  RERUN_MANUAL: { id: 500, key: 'rerun.manual' },
  RERUN_AUTO_FIRED: { id: 501, key: 'rerun.auto_fired' },
  /** Auto-rerun declined by policy. The interesting half of the auto-rerun story. */
  RERUN_AUTO_SUPPRESSED: { id: 502, key: 'rerun.auto_suppressed' },
  AUTOMERGE_ARMED: { id: 503, key: 'automerge.armed' },

  // ── 600 AI ───────────────────────────────────────────────────────────────────────────────────
  // Mirrors the depths claudeBridge.cjs accepts: quick | deep | log | blame, plus compose.
  AI_TRIAGE_QUICK: { id: 600, key: 'ai.triage_quick' },
  AI_TRIAGE_DEEP: { id: 601, key: 'ai.triage_deep' },
  AI_BLAME: { id: 602, key: 'ai.blame' },
  AI_LOG_FETCH: { id: 603, key: 'ai.log_fetch' },
  AI_PR_COMPOSE: { id: 604, key: 'ai.pr_compose' },
  AI_CANCELLED: { id: 605, key: 'ai.cancelled' },

  // ── 700 artifacts ────────────────────────────────────────────────────────────────────────────
  ARTIFACT_DOWNLOADED: { id: 700, key: 'artifact.downloaded' },
  ARTIFACT_BUNDLE_DOWNLOADED: { id: 701, key: 'artifact.bundle_downloaded' },
  DOWNLOAD_REVEALED: { id: 702, key: 'download.revealed' },

  // ── 800 configuration ────────────────────────────────────────────────────────────────────────
  CONFIG_EXPORTED: { id: 800, key: 'config.exported' },
  CONFIG_IMPORTED: { id: 801, key: 'config.imported' },
  NOTIFICATIONS_ENABLED: { id: 802, key: 'notifications.enabled' },

  // ── 900 feature branches ─────────────────────────────────────────────────────────────────────
  // The two MergeDirections in src/lib/featureBranch.ts.
  /** Default branch into the feature branch — a backmerge. */
  BRANCH_SYNC: { id: 900, key: 'branch.sync' },
  /** The fork's branch back into the upstream — offering the work. */
  BRANCH_OFFER: { id: 901, key: 'branch.offer' },
  BRANCH_FORK_SYNCED: { id: 902, key: 'branch.fork_synced' },
} as const satisfies Record<string, Def>;

/** Ids that once existed. Never reuse one — a year of dashboard history is keyed on it. */
const TOMBSTONES: readonly number[] = [];

export const FEATURE_DEFS = defs;
export const Features = buildRegistry('Feature', defs, TOMBSTONES);

/** Call-site enum: `Telemetry.featureUsed(Feature.FLOW_CREATED)`. */
export const Feature = idEnum(defs);
export type Feature = IdOf<typeof defs>;

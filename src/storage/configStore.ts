/**
 * Non-secret monitor configuration: upstream/fork coordinates, the PR author to
 * track, polling cadences, and the list of "flows" (workflow + branches + events)
 * to watch. Persisted in localStorage and validated with zod on read/import.
 */

import { z } from 'zod';
import { normalizeRepoRef } from '../lib/repo';

/** Normalize a {owner, repo} pair before validation (accepts pasted URLs / slugs). */
function preprocessOwnerRepo(val: unknown): unknown {
  if (val && typeof val === 'object') {
    const v = val as Record<string, unknown>;
    const n = normalizeRepoRef(
      typeof v.owner === 'string' ? v.owner : '',
      typeof v.repo === 'string' ? v.repo : '',
    );
    return { ...v, owner: n.owner, repo: n.repo };
  }
  return val;
}

const ownerRepoSchema = z.preprocess(
  preprocessOwnerRepo,
  z.object({
    owner: z.string().trim().min(1, 'owner is required'),
    repo: z.string().trim().min(1, 'repo is required'),
  }),
);

export const emptyFlowFilterSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Direction of the filter:
   *  - hide: hide the flow when it matches the "empty" condition (the default).
   *  - show: show the flow ONLY when it matches — i.e. hide the non-empty ones.
   */
  mode: z.enum(['hide', 'show']).default('hide'),
  /**
   * What counts as "empty":
   *  - no_runs / only_skipped: derived from the runs themselves
   *  - no_artifacts: latest run's total artifact size at/below `minArtifactKB`
   *  - job: latest run has a job whose name contains `jobName` in state `jobState`
   *    (e.g. a "test" job that is skipped)
   */
  by: z.enum(['no_runs', 'only_skipped', 'no_artifacts', 'job']).default('no_runs'),
  minArtifactKB: z.number().int().min(0).max(10_000_000).default(0),
  /** For `by: 'job'`: substring match on the job name. */
  jobName: z.string().trim().default(''),
  /** For `by: 'job'`: the state the matching job must be in to mark the flow empty. */
  jobState: z.enum(['skipped', 'failure', 'success', 'in_progress']).default('skipped'),
});

/** Hard ceiling on how many workflows one regex flow may expand into. */
export const MAX_FLOW_MATCHES = 50;

/**
 * Regex matching: instead of naming one workflow, a flow can watch *every*
 * workflow of the repo whose name/file matches `pattern`. Each match becomes its
 * own card on the board — with its own runs, filters and group placement — so a
 * pattern flow is a template rather than a single monitored workflow.
 * `pattern: ''` (the default) keeps the classic single-`workflowFile` flow.
 */
export const flowMatchSchema = z.object({
  /** JavaScript regex source, matched against the repo's workflow list. */
  pattern: z.string().trim().default(''),
  /** What the regex is tested against: display name, file name, or either. */
  by: z.enum(['name', 'file', 'any']).default('name'),
  /** Off (the default) adds the `i` flag. */
  caseSensitive: z.boolean().default(false),
  /** Safety cap — every match polls on its own, so an unbounded regex is costly. */
  maxMatches: z.number().int().min(1).max(MAX_FLOW_MATCHES).default(12),
});

export const flowSchema = z.preprocess(
  (val) => {
    if (val && typeof val === 'object') {
      const v = { ...(val as Record<string, unknown>) };
      if (typeof v.owner === 'string' || typeof v.repo === 'string') {
        const n = normalizeRepoRef(
          typeof v.owner === 'string' ? v.owner : '',
          typeof v.repo === 'string' ? v.repo : '',
        );
        v.owner = n.owner || undefined;
        v.repo = n.repo || undefined;
      }
      return v;
    }
    return val;
  },
  z
    .object({
      id: z.string().min(1),
      name: z.string().trim().min(1, 'flow name is required'),
      /** Defaults to upstream owner/repo when omitted. */
      owner: z.string().trim().min(1).optional(),
      repo: z.string().trim().min(1).optional(),
      /**
       * Workflow file name (e.g. "build.yml") or numeric workflow id as string.
       * Required unless `match.pattern` is set (then the matches supply it).
       */
      workflowFile: z.string().trim().default(''),
      branches: z.array(z.string().trim().min(1)).min(1, 'at least one branch'),
      /** Event filter (e.g. workflow_dispatch, push). Empty = any event. */
      events: z.array(z.string().trim().min(1)).default([]),
      maxRuns: z.number().int().min(1).max(50).default(5),
      /** Per-flow visibility filter: hide/show the flow based on an "empty" condition. */
      emptyFilter: emptyFlowFilterSchema.prefault({}),
      /** Watch every workflow matching a regex instead of a single one. */
      match: flowMatchSchema.prefault({}),
    })
    .superRefine((flow, ctx) => {
      if (!flow.match.pattern && !flow.workflowFile) {
        ctx.addIssue({
          code: 'custom',
          path: ['workflowFile'],
          message: 'workflowFile is required (or set a match pattern)',
        });
      }
      if (flow.match.pattern) {
        try {
          new RegExp(flow.match.pattern);
        } catch (e) {
          ctx.addIssue({
            code: 'custom',
            path: ['match', 'pattern'],
            message: `invalid regex: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    }),
);

export const pollingSchema = z.object({
  prListSeconds: z.number().int().min(30).max(3600).default(180),
  checksSeconds: z.number().int().min(15).max(3600).default(60),
  flowRunsSeconds: z.number().int().min(30).max(3600).default(180),
  hiddenSeconds: z.number().int().min(60).max(3600).default(240),
});

/** Desktop (Web Notification) preferences — opt-in per category. */
export const notificationsSchema = z
  .object({
    /** Notify when a tracked PR's checks finish (success/failure). */
    pr: z.boolean().default(false),
    /** Notify when a tracked flow run completes. */
    flow: z.boolean().default(false),
    /** Notify when failed jobs were re-run automatically (or a re-run failed). */
    autoRerun: z.boolean().default(false),
  })
  .prefault({});

/**
 * Automatic re-run of failed jobs for pull requests waiting on auto-merge.
 *
 * The only feature that writes to GitHub, so it is off by default and inert until
 * the user names workflow files. Two independent brakes stop a genuinely broken
 * PR from burning CI forever: a hard attempt ceiling, and giving up as soon as the
 * failure repeats identically.
 */
export const prAutoRerunSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Exact workflow file names (e.g. "ci.yml"). A run qualifies when the basename
     * of its `path` is listed — never a pattern, so this can't widen by accident.
     */
    workflowFiles: z.array(z.string().trim().min(1)).default([]),
    /** Ceiling on GitHub's `run_attempt`; 1 disables retrying outright. */
    maxAttempts: z.number().int().min(1).max(20).default(10),
    /**
     * How many times the *same* failure may be seen before the engine stops retrying
     * it — counted as a consecutive streak of matching failure fingerprints, so a
     * different failure in between starts the count over.
     *
     * `0` switches the brake off entirely (retry until `maxAttempts`). `1` follows from
     * the same rule rather than being a special case: the first failure is already one
     * occurrence, so nothing identical is ever retried.
     */
    maxIdenticalFailures: z.number().int().min(0).max(20).default(5),
    /**
     * Ignore a failure older than this. Measured from the *latest attempt* — a run
     * that is actively being retried is as fresh as its last try, not as old as the
     * commit. GitHub's own 30-day refusal is enforced separately, from the run's
     * creation, and is not this setting.
     */
    maxRunAgeHours: z.number().int().min(1).max(720).default(72),
  })
  .prefault({});

/** Recently-merged PRs, polled so their failures stay reviewable after merge. */
export const mergedPrsSchema = z
  .object({
    /** How many of the most recently updated merged PRs to track; 0 disables. */
    count: z.number().int().min(0).max(50).default(10),
  })
  .prefault({});

/**
 * The manual "arm auto-merge" button.
 *
 * No `enabled` flag: the button is gated on the token being able to write, which is the
 * same gate every other write control uses, and an explicit click is its own authority.
 * Only the strategy needs configuring, because a repository can disallow any of the three
 * and GitHub refuses the mutation rather than picking another.
 */
export const autoMergeSchema = z
  .object({
    /** Strategy for auto-merge. Must be one the repository actually allows. */
    mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  })
  .prefault({});

/**
 * The in-app diagnostics log viewer.
 *
 * **On by default.** It was opt-in on the reasoning that a window on the app's own behaviour earns a
 * place in the navigation only for someone who went looking for it — which had it backwards: the
 * people who need it are the ones who have just been surprised by something and do not yet know the
 * log exists, and asking them to find a setting first is asking them at the worst moment. It costs
 * nothing when unused, since the log is written either way and the tab reads it only while open.
 *
 * Switch it off under **Settings → Diagnostics**; a machine that already has a preference keeps it.
 */
export const diagnosticsSchema = z
  .object({
    /** Show a "Diagnostics" tab in the main navigation. Desktop only. */
    showLogTab: z.boolean().default(true),
    /** How much of the end of the log to read per refresh. */
    tailKB: z.number().int().min(16).max(5120).default(512),
    /** Seconds between refreshes while "Live" is on. */
    followSeconds: z.number().int().min(1).max(60).default(3),
  })
  .prefault({});

/**
 * Long-lived shared branches in the upstream repository.
 *
 * A "feature branch" is one that exists under `prefix` in **both** the upstream and the
 * fork — the pair is what makes the three actions meaningful: a branch only in upstream
 * can't be pulled into a fork that doesn't have it, and one only in the fork isn't shared
 * work at all.
 *
 * Off by default, because most repositories have no such branches and an empty tab is
 * worse than an absent one.
 */
export const featureBranchesSchema = z
  .object({
    /**
     * Show the "Feature branches" tab in the main navigation.
     *
     * On by default. It costs two requests per poll to find out that a repository has no shared
     * branches under the prefix — cheap enough that defaulting to off mainly meant the tab went
     * unfound by the people it was built for. Turning it off stops all of that.
     */
    enabled: z.boolean().default(true),
    /**
     * Ref prefix that defines a feature branch. The trailing slash matters: it is handed
     * to GitHub's `matching-refs` endpoint verbatim, where `feature` would also match
     * `features-old` while `feature/` would not.
     *
     * Constrained to what a git ref may contain, because "verbatim" is literal — the
     * slashes have to stay slashes for the prefix to match anything, so this cannot be
     * percent-encoded on the way out. A `?` or `#` in here would otherwise stop being part
     * of the path and start being a query or a fragment.
     */
    prefix: z
      .string()
      .trim()
      .min(1)
      .regex(/^[A-Za-z0-9._\-/]+$/, 'prefix may only contain letters, digits, . _ - and /')
      .default('feature/'),
  })
  .prefault({});

/** Markdown failure reports (one per failed job) for filing bugs. */
export const failureReportsSchema = z
  .object({
    /**
     * Fetch annotations for newly-failed jobs without waiting for a click, so the
     * list shows test names immediately. One request per failed job.
     */
    prefetchAnnotations: z.boolean().default(true),
    /** Log lines from the failed step appended to a report; 0 omits the log. */
    logTailLines: z.number().int().min(0).max(500).default(80),
    /** Teams renders no <details>, so the report is flattened for it. */
    format: z.enum(['github', 'teams']).default('github'),
  })
  .prefault({});

/**
 * A user-defined group of flows, shown as a section in the Flows board and the
 * Overview. Membership is by flow `id` (stable, uuid), so the layout transfers
 * unambiguously between machines via export/import. A flow not referenced by any
 * group is "ungrouped". `flowIds` order is the order within the group.
 */
export const flowGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, 'group name is required'),
  flowIds: z.array(z.string().min(1)).default([]),
  collapsed: z.boolean().default(false),
});

/**
 * Model aliases offered for the AI tasks.
 *
 * Aliases rather than pinned ids, so the CLI resolves whatever its current Sonnet/Opus is
 * and a retired model id can't strand the feature. A closed set, because the value becomes
 * a `--model` argument: the bridge re-checks it against the same list, since anything the
 * renderer supplies is untrusted there.
 */
export const AI_MODELS = ['sonnet', 'opus', 'haiku'] as const;
/** What `claude --effort` accepts. */
export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const aiTaskSchema = (model: (typeof AI_MODELS)[number], effort: (typeof AI_EFFORTS)[number]) =>
  z
    .object({
      model: z.enum(AI_MODELS).default(model),
      effort: z.enum(AI_EFFORTS).default(effort),
      /**
       * Replaces the built-in brief entirely when non-empty.
       *
       * The verified facts, the annotations and the log are still appended, and the
       * output contract still applies — an override that dropped those would produce a
       * reply the app cannot parse. Blank means "use the built-in brief", which is what
       * almost everyone should leave it as.
       */
      prompt: z.string().default(''),
    })
    .prefault({});

/**
 * Local AI integration (the `claude` CLI). The one feature that sends anything outside
 * GitHub, so it has a single switch that hides all of it.
 */
export const aiSchema = z
  .object({
    /**
     * Master switch. Defaults **on** so that upgrading doesn't silently remove a feature
     * someone is using — it was already gated on `claude` being installed and on an
     * explicit click. Off hides every AI control outright.
     */
    enabled: z.boolean().default(true),
    /**
     * Appended to whichever brief runs, for standing context the model can't infer —
     * "our integration tests are flaky on Windows", "ignore the deprecation warnings".
     * Additive rather than replacing, so it can't quietly break the output contract.
     */
    extraInstructions: z.string().default(''),
    /** The fast read: a single-turn summary of a log already in hand. */
    quick: aiTaskSchema('sonnet', 'medium'),
    /** The investigation: fetches artifacts, the workflow and the diff. */
    deep: aiTaskSchema('opus', 'high'),
    /**
     * The log rewrite: a transformation with checkable output, so effort buys nothing.
     * Benchmarked — low was the fastest and passed every structural check.
     */
    log: aiTaskSchema('sonnet', 'low'),
    /**
     * Blame: which commit broke the flow. Reads run history across a branch and weighs a
     * flake against a real break — judgement, so Opus; but breadth rather than depth, so
     * medium effort rather than the deep pass's high.
     */
    blame: aiTaskSchema('opus', 'medium'),
    /**
     * The pull-request write-up: a title and description for the PR that ships a feature
     * branch into the default branch, from the commit subjects and changed files the app
     * has already fetched. One turn, no tools — it is summarising input it was handed, not
     * investigating anything.
     */
    pr: aiTaskSchema('sonnet', 'medium'),
  })
  .prefault({});

export const monitorConfigSchema = z.object({
  version: z.literal(1).default(1),
  upstream: ownerRepoSchema,
  fork: z.object({
    owner: z.string().trim().min(1, 'fork owner is required'),
    /**
     * The fork's own repository name, for the rare fork that was renamed.
     *
     * Blank means "same name as the upstream", which is what a fork gets by default and
     * what every earlier version of this app assumed outright — it never needed the name,
     * since the only thing it did with a fork was filter upstream PRs by head owner. The
     * feature-branch actions address the fork repository directly, so the name has to be
     * knowable. Read it through `forkRepo()` rather than this field.
     */
    repo: z.string().trim().default(''),
    branch: z.string().trim().min(1).nullable().default(null),
  }),
  /** GitHub login whose open PRs are tracked. Defaults to fork.owner if blank. */
  prAuthor: z.string().trim().default(''),
  polling: pollingSchema.prefault({}),
  notifications: notificationsSchema,
  /** Auto-rerun of failed jobs. Off until configured. */
  prAutoRerun: prAutoRerunSchema,
  /** The manual arm-auto-merge action. */
  autoMerge: autoMergeSchema,
  /** Track recently-merged PRs so their failures stay reviewable. */
  mergedPrs: mergedPrsSchema,
  /** Markdown failure-report generation. */
  failureReports: failureReportsSchema,
  /** The in-app diagnostics log viewer (desktop, on by default). */
  diagnostics: diagnosticsSchema,
  /** Shared `feature/**` branches: the tab and its three actions (on by default). */
  featureBranches: featureBranchesSchema,
  /** Local AI integration via the `claude` CLI. */
  ai: aiSchema,
  /** Desktop app: auto-download & install updates. Ignored where unsupported. */
  autoUpdate: z.boolean().default(true),
  rateLimitWarnAt: z.number().int().min(0).max(5000).default(50),
  flows: z.array(flowSchema).default([]),
  /** Optional grouping of flows (Overview + Flows board). */
  groups: z.array(flowGroupSchema).default([]),
  /**
   * Explicit order of the "Ungrouped" section, by flow id. Needed because
   * pattern-derived flows have no entry in `flows` to reorder; also marks a
   * derived flow as deliberately ungrouped so its pattern's group placement
   * doesn't pull it back in. Ids missing here follow `flows` order.
   */
  ungroupedOrder: z.array(z.string().min(1)).default([]),
});

export type Flow = z.infer<typeof flowSchema>;
export type FlowMatch = z.infer<typeof flowMatchSchema>;
export type FlowGroup = z.infer<typeof flowGroupSchema>;
export type PollingConfig = z.infer<typeof pollingSchema>;
export type NotificationPrefs = z.infer<typeof notificationsSchema>;
export type AiConfig = z.infer<typeof aiSchema>;
export type AiTaskConfig = z.infer<ReturnType<typeof aiTaskSchema>>;
export type PrAutoRerunConfig = z.infer<typeof prAutoRerunSchema>;
export type MergedPrsConfig = z.infer<typeof mergedPrsSchema>;
export type FailureReportsConfig = z.infer<typeof failureReportsSchema>;
export type DiagnosticsConfig = z.infer<typeof diagnosticsSchema>;
export type FeatureBranchesConfig = z.infer<typeof featureBranchesSchema>;
export type AutoMergeConfig = z.infer<typeof autoMergeSchema>;
export type EmptyFlowFilter = z.infer<typeof emptyFlowFilterSchema>;
export type MonitorConfig = z.infer<typeof monitorConfigSchema>;

const STORAGE_KEY = 'job-monitor.config';

/**
 * Initial empty config. Built as a literal (not via `.parse`) because the schema
 * requires non-empty coordinates — those are only enforced on save/import, while
 * the app starts out incomplete and routes the user to Settings.
 */
export const DEFAULT_CONFIG: MonitorConfig = {
  version: 1,
  upstream: { owner: '', repo: '' },
  fork: { owner: '', repo: '', branch: null },
  prAuthor: '',
  polling: { prListSeconds: 180, checksSeconds: 60, flowRunsSeconds: 180, hiddenSeconds: 240 },
  notifications: { pr: false, flow: false, autoRerun: false },
  prAutoRerun: {
    enabled: false,
    workflowFiles: [],
    maxAttempts: 10,
    maxIdenticalFailures: 5,
    maxRunAgeHours: 72,
  },
  mergedPrs: { count: 10 },
  failureReports: { prefetchAnnotations: true, logTailLines: 80, format: 'github' },
  autoMerge: { mergeMethod: 'squash' },
  diagnostics: { showLogTab: true, tailKB: 512, followSeconds: 3 },
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
  flows: [],
  groups: [],
  ungroupedOrder: [],
};

/** Parse + validate untrusted JSON (e.g. from the import textarea). */
export function parseConfig(raw: unknown): MonitorConfig {
  return monitorConfigSchema.parse(raw);
}

/** Safe variant returning a discriminated result instead of throwing. */
export function safeParseConfig(
  raw: unknown,
): { ok: true; config: MonitorConfig } | { ok: false; errors: string[] } {
  const result = monitorConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    ),
  };
}

/**
 * The exportable "board": full flow definitions + their grouping, keyed by stable
 * flow ids. Self-contained so it transfers between machines unambiguously (the
 * token/coordinates are intentionally NOT included — those are per-machine).
 */
export const flowBoardSchema = z.object({
  version: z.literal(1).default(1),
  flows: z.array(flowSchema).default([]),
  groups: z.array(flowGroupSchema).default([]),
  ungroupedOrder: z.array(z.string().min(1)).default([]),
});
export type FlowBoard = z.infer<typeof flowBoardSchema>;

export function safeParseBoard(
  raw: unknown,
): { ok: true; board: FlowBoard } | { ok: false; errors: string[] } {
  const result = flowBoardSchema.safeParse(raw);
  if (result.success) return { ok: true, board: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

export function loadConfig(): MonitorConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    return monitorConfigSchema.parse(JSON.parse(raw));
  } catch {
    // Corrupt/incompatible stored config: fall back to defaults rather than crash.
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: MonitorConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage full/unavailable: config still lives in memory for this session.
  }
}

/** True once the minimum coordinates needed to query GitHub are present. */
export function isConfigComplete(config: MonitorConfig): boolean {
  return Boolean(config.upstream.owner && config.upstream.repo && config.fork.owner);
}

/** Effective PR author: explicit prAuthor, else the fork owner. */
export function effectivePrAuthor(config: MonitorConfig): string {
  return config.prAuthor.trim() || config.fork.owner.trim();
}

/**
 * Effective fork repository name: the explicit override, else the upstream's name.
 *
 * Forking keeps the name unless someone renames it afterwards, so the fallback is right
 * for almost everyone — but it is a *guess*, and the calls that use it write to whatever
 * repository it names. Everything addressing the fork must go through here rather than
 * reaching for `upstream.repo` and quietly baking the guess in a second time.
 */
export function forkRepo(config: MonitorConfig): string {
  return config.fork.repo.trim() || config.upstream.repo;
}

export function newFlowId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `flow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function newGroupId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `group-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

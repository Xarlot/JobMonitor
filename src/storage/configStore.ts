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
  z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1, 'flow name is required'),
    /** Defaults to upstream owner/repo when omitted. */
    owner: z.string().trim().min(1).optional(),
    repo: z.string().trim().min(1).optional(),
    /** Workflow file name (e.g. "build.yml") or numeric workflow id as string. */
    workflowFile: z.string().trim().min(1, 'workflowFile is required'),
    branches: z.array(z.string().trim().min(1)).min(1, 'at least one branch'),
    /** Event filter (e.g. workflow_dispatch, push). Empty = any event. */
    events: z.array(z.string().trim().min(1)).default([]),
    maxRuns: z.number().int().min(1).max(50).default(5),
    /** Per-flow "hide when empty" filter. */
    emptyFilter: emptyFlowFilterSchema.prefault({}),
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

export const monitorConfigSchema = z.object({
  version: z.literal(1).default(1),
  upstream: ownerRepoSchema,
  fork: z.object({
    owner: z.string().trim().min(1, 'fork owner is required'),
    branch: z.string().trim().min(1).nullable().default(null),
  }),
  /** GitHub login whose open PRs are tracked. Defaults to fork.owner if blank. */
  prAuthor: z.string().trim().default(''),
  polling: pollingSchema.prefault({}),
  notifications: notificationsSchema,
  /** Desktop app: auto-download & install updates. Ignored where unsupported. */
  autoUpdate: z.boolean().default(true),
  rateLimitWarnAt: z.number().int().min(0).max(5000).default(50),
  flows: z.array(flowSchema).default([]),
  /** Optional grouping of flows (Overview + Flows board). */
  groups: z.array(flowGroupSchema).default([]),
});

export type Flow = z.infer<typeof flowSchema>;
export type FlowGroup = z.infer<typeof flowGroupSchema>;
export type PollingConfig = z.infer<typeof pollingSchema>;
export type NotificationPrefs = z.infer<typeof notificationsSchema>;
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
  fork: { owner: '', branch: null },
  prAuthor: '',
  polling: { prListSeconds: 180, checksSeconds: 60, flowRunsSeconds: 180, hiddenSeconds: 240 },
  notifications: { pr: false, flow: false },
  autoUpdate: true,
  rateLimitWarnAt: 50,
  flows: [],
  groups: [],
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

export function newFlowId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `flow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function newGroupId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `group-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

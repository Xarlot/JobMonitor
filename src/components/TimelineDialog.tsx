import { useEffect, useMemo, useState } from 'react';
import { Button, Flash, Spinner, Text } from '@primer/react';
import type { CheckRun, Job, OverallStatus, WorkflowRun } from '../api/types';
import { fetchAllRunJobs } from '../api/jobs';
import { checkRunIdFromUrl, jobIdFromUrl, runIdFromUrl } from '../api/endpoints';
import { statusToOverall } from '../lib/status';
import { formatDuration } from '../lib/format';
import { setupStep } from '../lib/jobTiming';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';
import styles from './TimelineDialog.module.css';

export interface GanttItem {
  id: string | number;
  label: string;
  status: OverallStatus;
  started_at: string | null;
  completed_at: string | null;
  /**
   * Optional boundary (ISO) between runner allocation (queue + "Set up job") and
   * the payload (actual work). When set, the bar is drawn as two segments.
   */
  allocationEndIso?: string | null;
  /** When the runner picked the item up — splits the allocation into queue and set-up. */
  queueEndIso?: string | null;
}

const BAR_COLOR: Record<OverallStatus, string> = {
  success: 'var(--bgColor-success-emphasis)',
  failure: 'var(--bgColor-danger-emphasis)',
  in_progress: 'var(--bgColor-attention-emphasis)',
  pending: 'var(--bgColor-attention-emphasis)',
  neutral: 'var(--bgColor-neutral-emphasis)',
  unknown: 'var(--bgColor-neutral-muted)',
};

const LABEL_W = 220;
const DUR_W = 72;

/** Label, bar, duration — shared so the legend and the rows line up by construction. */
const TIMELINE_COLUMNS = `${LABEL_W}px 1fr ${DUR_W}px`;
/** The same, with a column for the wait when any bar has one. */
const TIMELINE_COLUMNS_WAIT = `${LABEL_W}px 1fr ${DUR_W}px ${DUR_W}px`;
const ALLOC_HATCH =
  'repeating-linear-gradient(45deg, var(--fgColor-muted, rgba(110,118,129,0.6)) 0 3px, transparent 3px 6px)';

/** Gantt-style timeline: each row is an item; bar offset = start, width = duration. */
function GanttChart({ items }: { items: GanttItem[] }) {
  const now = Date.now();
  const timed = items.map((i) => {
    const start = i.started_at ? Date.parse(i.started_at) : NaN;
    const end = i.completed_at
      ? Date.parse(i.completed_at)
      : Number.isNaN(start)
        ? NaN
        : now; // still running -> extend to now
    return { ...i, start, end };
  });
  const valid = timed.filter((i) => !Number.isNaN(i.start));
  if (valid.length === 0) {
    return <Text className={styles.smallFgMuted}>No timing data available.</Text>;
  }

  const minStart = Math.min(...valid.map((i) => i.start));
  const maxEnd = Math.max(...valid.map((i) => i.end));
  const total = Math.max(1, maxEnd - minStart);
  const minStartIso = new Date(minStart).toISOString();
  const maxEndIso = new Date(maxEnd).toISOString();
  const sorted = [...timed].sort((a, b) => (a.start || Infinity) - (b.start || Infinity));
  const anyAlloc = sorted.some((i) => {
    const e = i.allocationEndIso ? Date.parse(i.allocationEndIso) : NaN;
    return !Number.isNaN(i.start) && !Number.isNaN(e) && e > i.start && e < i.end;
  });
  const columns = anyAlloc ? TIMELINE_COLUMNS_WAIT : TIMELINE_COLUMNS;

  return (
    <div>
      {/* axis */}
      <div
        className={styles.legend} style={{ gridTemplateColumns: columns }}
      >
        <Text>Item</Text>
        <div className={styles.flexBetween}>
          <span>0s</span>
          <span>total {formatDuration(minStartIso, maxEndIso)}</span>
        </div>
        {anyAlloc && (
          <Text className={styles.textRight} title="Queue + “Set up job” — the wait before the work">
            Wait
          </Text>
        )}
        <Text className={styles.textRight}>{anyAlloc ? 'Work' : 'Duration'}</Text>
      </div>

      {anyAlloc && (
        <div className={styles.flexGap3}>
          <div className={styles.flexCenter}>
            <div className={styles.swatch} style={{ backgroundImage: ALLOC_HATCH }} />
            runner allocation (queue + setup)
          </div>
          <div className={styles.flexCenter}>
            <div className={styles.roundedBgAccentEmphasis} />
            payload (work)
          </div>
        </div>
      )}

      <div className={styles.flexCol}>
        {sorted.map((i) => {
          const hasTime = !Number.isNaN(i.start);
          const allocEnd = i.allocationEndIso ? Date.parse(i.allocationEndIso) : NaN;
          const hasSplit = hasTime && !Number.isNaN(allocEnd) && allocEnd > i.start && allocEnd < i.end;

          const startPct = hasTime ? ((i.start - minStart) / total) * 100 : 0;
          const allocWidthPct = hasSplit ? ((allocEnd - i.start) / total) * 100 : 0;
          const payloadLeftPct = hasSplit ? ((allocEnd - minStart) / total) * 100 : startPct;
          const payloadWidthPct = hasSplit
            ? Math.max(((i.end - allocEnd) / total) * 100, 0.6)
            : hasTime
              ? Math.max(((i.end - i.start) / total) * 100, 0.6)
              : 0;

          const allocLabel = hasSplit ? formatDuration(i.started_at, i.allocationEndIso ?? null) : null;
          const payloadLabel = hasSplit
            ? formatDuration(i.allocationEndIso ?? null, i.completed_at)
            : hasTime
              ? formatDuration(i.started_at, i.completed_at)
              : '—';
          const offsetLabel = hasTime ? formatDuration(minStartIso, i.started_at) : '—';
          const queueEnd = i.queueEndIso ? Date.parse(i.queueEndIso) : NaN;
          const hasQueue = hasSplit && !Number.isNaN(queueEnd) && queueEnd >= i.start && queueEnd <= allocEnd;
          const allocParts = hasQueue
            ? `queued ${formatDuration(i.started_at, i.queueEndIso ?? null)} · set-up ${formatDuration(i.queueEndIso ?? null, i.allocationEndIso ?? null)}`
            : `allocation ${allocLabel}`;
          const barTitle = hasSplit
            ? `${allocParts} · work ${payloadLabel} (starts +${offsetLabel})`
            : `starts +${offsetLabel} · runs ${payloadLabel}`;

          return (
            <div
              key={i.id}
              className={styles.row} style={{ gridTemplateColumns: columns }}
            >
              <div className={styles.flexCenter2}>
                <StatusBadge status={i.status} withText={false} size={14} />
                <Text
                  className={styles.smallNowrap}
                  title={i.label}
                >
                  {i.label}
                </Text>
              </div>
              <div
                title={barTitle}
                className={styles.relativeBgCanvasSubtle}
              >
                {hasSplit && (
                  <div
                    className={styles.barAlloc}
                style={{ left: `${startPct}%`, width: `${allocWidthPct}%`, backgroundImage: ALLOC_HATCH }}
                  />
                )}
                {hasTime && (
                  <div
                    className={styles.barPayload}
                style={{ left: `${payloadLeftPct}%`, width: `${payloadWidthPct}%`, backgroundColor: BAR_COLOR[i.status] }}
                  />
                )}
              </div>
              {anyAlloc && (
                <Text className={styles.smallFgMuted2} title={hasSplit ? allocParts : undefined}>
                  {allocLabel ?? '—'}
                </Text>
              )}
              <Text className={styles.smallFgMuted2}>
                {payloadLabel}
              </Text>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Presentational timeline modal: caller supplies items (+ loading/error). */
export function TimelineDialog({
  title,
  subtitle,
  items,
  loading,
  error,
  notice,
  onClose,
}: {
  title: string;
  subtitle?: string;
  items: GanttItem[];
  loading?: boolean;
  error?: string | null;
  /** A line under the chart — something the bars can't say, without hiding them. */
  notice?: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Text className={styles.smallFgMuted3}>
        Bars show each item’s start offset and duration relative to the earliest start.
      </Text>
      {loading ? (
        <div className={styles.flexCenter3}>
          <Spinner size="small" /> <Text className={styles.small}>Loading…</Text>
        </div>
      ) : error ? (
        <Flash variant="danger" className={styles.small}>{error}</Flash>
      ) : (
        <GanttChart items={items} />
      )}
      {notice && <Text className={styles.notice}>{notice}</Text>}
    </Modal>
  );
}

/**
 * One Actions job as a bar split into runner allocation and payload.
 *
 * Allocation = the queue (created_at→started_at) + the "Set up job" step; payload = everything
 * after it. The bar starts at queue time when the job reports it, so the wait is visible.
 */
export function jobGanttItem(j: Job, label: string = j.name): GanttItem {
  const setup = setupStep(j);
  return {
    id: j.id,
    label,
    status: statusToOverall(j.status, j.conclusion),
    started_at: j.created_at ?? j.started_at,
    completed_at: j.completed_at,
    allocationEndIso: setup?.completed_at ?? j.started_at,
    queueEndIso: j.started_at,
  };
}

/** A check-run as a plain bar — all a check from outside Actions can show. */
export function checkRunGanttItem(c: CheckRun): GanttItem {
  return {
    id: c.id,
    label: c.name,
    status: statusToOverall(c.status, c.conclusion),
    started_at: c.started_at,
    completed_at: c.completed_at,
  };
}

/**
 * Upgrade a PR's check bars with the queue time of the Actions jobs behind them.
 *
 * A check-run carries no queue time — its `started_at` is when a runner picked the job up — so
 * each check backed by an Actions job is replaced by that job's split bar. The job is found by
 * the id in the check's `details_url`, or by the job's own check-run id (the same number for
 * Actions). Checks from other apps, and jobs that could not be read, keep their plain bar.
 */
export function mergeCheckRunsWithJobs(checkRuns: CheckRun[], jobs: Job[]): GanttItem[] {
  const byId = new Map<number, Job>();
  for (const j of jobs) {
    byId.set(j.id, j);
    const checkId = checkRunIdFromUrl(j.check_run_url);
    if (checkId !== null) byId.set(checkId, j);
  }
  return checkRuns.map((c) => {
    const job = byId.get(jobIdFromUrl(c.details_url) ?? c.id);
    return job ? { ...jobGanttItem(job, c.name), id: c.id } : checkRunGanttItem(c);
  });
}

/**
 * PR check timeline: the check bars at once, then — once the jobs of the Actions runs behind
 * them are read — with each job's queue and set-up drawn in.
 */
export function PrChecksTimelineDialog({
  owner,
  repo,
  title,
  subtitle,
  checkRuns,
  onClose,
}: {
  owner: string;
  repo: string;
  title: string;
  subtitle: string;
  checkRuns: CheckRun[];
  onClose: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // The runs, as a string, so a re-poll returning the same checks doesn't refetch.
  const runKey = [
    ...new Set(
      checkRuns
        .map((c) => runIdFromUrl(c.details_url) ?? runIdFromUrl(c.html_url))
        .filter((id): id is number => id !== null),
    ),
  ]
    .sort((a, b) => a - b)
    .join(',');

  useEffect(() => {
    const runIds = runKey ? runKey.split(',').map(Number) : [];
    if (runIds.length === 0) return;
    let active = true;
    setLoadingJobs(true);
    setFailed(null);
    Promise.allSettled(runIds.map((id) => fetchAllRunJobs(owner, repo, id)))
      .then((results) => {
        if (!active) return;
        setJobs(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
        const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (rejected) {
          const why = rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason);
          setFailed(`Queue time is missing for some checks — their jobs could not be read: ${why}`);
        }
      })
      .finally(() => active && setLoadingJobs(false));
    return () => {
      active = false;
    };
  }, [owner, repo, runKey]);

  const items = useMemo(() => mergeCheckRunsWithJobs(checkRuns, jobs), [checkRuns, jobs]);

  return (
    <TimelineDialog
      title={title}
      subtitle={subtitle}
      items={items}
      notice={loadingJobs ? 'Reading the jobs for their queue time…' : failed}
      onClose={onClose}
    />
  );
}

/** Flow-run timeline: fetches the run's jobs and renders their Gantt. */
export function FlowRunTimelineDialog({
  owner,
  repo,
  run,
  onClose,
}: {
  owner: string;
  repo: string;
  run: WorkflowRun;
  onClose: () => void;
}) {
  const [items, setItems] = useState<GanttItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchAllRunJobs(owner, repo, run.id)
      .then((jobs) => {
        if (!active) return;
        setItems(jobs.map((j) => jobGanttItem(j)));
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [owner, repo, run.id]);

  return (
    <TimelineDialog
      title={run.display_title || run.name || 'Workflow run'}
      subtitle={`${owner}/${repo} · run #${run.run_number} · job timeline`}
      items={items}
      loading={loading}
      error={error}
      onClose={onClose}
    />
  );
}

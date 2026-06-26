import { useEffect, useState } from 'react';
import { Box, Button, Flash, Spinner, Text } from '@primer/react';
import type { OverallStatus, WorkflowRun } from '../api/types';
import { fetchAllRunJobs } from '../api/jobs';
import { statusToOverall } from '../lib/status';
import { formatDuration } from '../lib/format';
import { StatusBadge } from './StatusBadge';
import { Modal } from './Modal';

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
}

const BAR_COLOR: Record<OverallStatus, string> = {
  success: 'success.emphasis',
  failure: 'danger.emphasis',
  in_progress: 'attention.emphasis',
  pending: 'attention.emphasis',
  neutral: 'neutral.emphasis',
  unknown: 'neutral.muted',
};

const LABEL_W = 220;
const DUR_W = 72;
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
    return <Text sx={{ fontSize: 0, color: 'fg.muted' }}>No timing data available.</Text>;
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

  return (
    <Box>
      {/* axis */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: `${LABEL_W}px 1fr ${DUR_W}px`,
          alignItems: 'center',
          mb: 2,
          fontSize: 0,
          color: 'fg.muted',
        }}
      >
        <Text>Item</Text>
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>0s</span>
          <span>total {formatDuration(minStartIso, maxEndIso)}</span>
        </Box>
        <Text sx={{ textAlign: 'right' }}>Duration</Text>
      </Box>

      {anyAlloc && (
        <Box sx={{ display: 'flex', gap: 3, alignItems: 'center', mb: 2, fontSize: 0, color: 'fg.muted' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ width: 16, height: 10, borderRadius: 1, bg: 'neutral.muted', backgroundImage: ALLOC_HATCH }} />
            runner allocation (queue + setup)
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ width: 16, height: 10, borderRadius: 1, bg: 'accent.emphasis' }} />
            payload (work)
          </Box>
        </Box>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
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
          const barTitle = hasSplit
            ? `allocation ${allocLabel} · payload ${payloadLabel} (starts +${offsetLabel})`
            : `starts +${offsetLabel} · runs ${payloadLabel}`;

          return (
            <Box
              key={i.id}
              sx={{
                display: 'grid',
                gridTemplateColumns: `${LABEL_W}px 1fr ${DUR_W}px`,
                alignItems: 'center',
                gap: 2,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                <StatusBadge status={i.status} withText={false} size={14} />
                <Text
                  sx={{ fontSize: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={i.label}
                >
                  {i.label}
                </Text>
              </Box>
              <Box
                title={barTitle}
                sx={{
                  position: 'relative',
                  height: 18,
                  bg: 'canvas.subtle',
                  borderRadius: 2,
                  backgroundImage:
                    'linear-gradient(90deg, var(--borderColor-muted, rgba(0,0,0,0.08)) 0 1px, transparent 1px)',
                  backgroundSize: '25% 100%',
                }}
              >
                {hasSplit && (
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 2,
                      height: 14,
                      left: `${startPct}%`,
                      width: `${allocWidthPct}%`,
                      minWidth: '1px',
                      bg: 'neutral.muted',
                      backgroundImage: ALLOC_HATCH,
                      borderRadius: 2,
                    }}
                  />
                )}
                {hasTime && (
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 2,
                      height: 14,
                      left: `${payloadLeftPct}%`,
                      width: `${payloadWidthPct}%`,
                      minWidth: '2px',
                      bg: BAR_COLOR[i.status],
                      borderRadius: 2,
                    }}
                  />
                )}
              </Box>
              <Text sx={{ fontSize: 0, color: 'fg.muted', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {payloadLabel}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** Presentational timeline modal: caller supplies items (+ loading/error). */
export function TimelineDialog({
  title,
  subtitle,
  items,
  loading,
  error,
  onClose,
}: {
  title: string;
  subtitle?: string;
  items: GanttItem[];
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 3 }}>
        Bars show each item’s start offset and duration relative to the earliest start.
      </Text>
      {loading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
          <Spinner size="small" /> <Text sx={{ fontSize: 0 }}>Loading…</Text>
        </Box>
      ) : error ? (
        <Flash variant="danger" sx={{ fontSize: 0 }}>{error}</Flash>
      ) : (
        <GanttChart items={items} />
      )}
    </Modal>
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
        setItems(
          jobs.map((j) => {
            // Runner allocation = queue (created_at→started_at) + the "Set up job"
            // step; payload = everything after it.
            const setup =
              j.steps.find((s) => s.number === 1 || /set up job/i.test(s.name)) ?? null;
            return {
              id: j.id,
              label: j.name,
              status: statusToOverall(j.status, j.conclusion),
              // start the bar at queue time when available, so allocation is visible
              started_at: j.created_at ?? j.started_at,
              completed_at: j.completed_at,
              allocationEndIso: setup?.completed_at ?? j.started_at,
            };
          }),
        );
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

import { Fragment, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  Box,
  BranchName,
  Button,
  Flash,
  Heading,
  IconButton,
  Label,
  Link,
  Octicon,
  Spinner,
  Text,
} from '@primer/react';
import {
  ChecklistIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GraphIcon,
  LinkExternalIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { FlowRunTimelineDialog } from './TimelineDialog';
import { RunOverallSummaryDialog } from './OverallSummaryDialog';
import type { WorkflowRun } from '../api/types';
import type { Flow } from '../storage/configStore';
import type { FlowState } from '../hooks/useFlows';
import { useFlowsFilter } from '../context/FlowsFilterContext';
import { statusToOverall } from '../lib/status';
import { filterRuns } from '../lib/flowFilter';
import { StatusBadge } from './StatusBadge';
import { JobsTable } from './JobsTable';
import { formatDuration, formatRelative } from '../lib/format';

interface TableMeta {
  isExpanded: (runId: number) => boolean;
  onTimeline: (run: WorkflowRun) => void;
  onSummary: (run: WorkflowRun) => void;
}

const columnHelper = createColumnHelper<WorkflowRun>();

const headerCellSx = {
  px: 2,
  py: 2,
  fontSize: 0,
  fontWeight: 'bold',
  color: 'fg.muted',
  textAlign: 'left',
  borderBottom: '1px solid',
  borderColor: 'border.default',
} as const;

const bodyCellSx = {
  px: 2,
  py: 2,
  fontSize: 1,
  verticalAlign: 'middle',
  borderColor: 'border.muted',
} as const;

function eventVariant(event: string): 'accent' | 'done' | 'secondary' {
  if (event === 'workflow_dispatch') return 'accent';
  if (event === 'schedule') return 'done';
  return 'secondary';
}

export function FlowRunsGrid({
  flow,
  state,
  highlight = false,
}: {
  flow: Flow;
  state: FlowState | undefined;
  highlight?: boolean;
}) {
  const { filter } = useFlowsFilter();

  const runs = state?.runs ?? [];
  const overall = state?.overall ?? 'unknown';
  const jobsByRun = state?.jobsByRun ?? {};
  const owner = state?.owner ?? flow.owner ?? '';
  const repo = state?.repo ?? flow.repo ?? '';
  const isExpanded = state?.isExpanded ?? (() => false);
  const onToggleRun = state?.onToggleRun ?? (() => {});
  const isFetchingRuns = state?.isFetchingRuns ?? false;
  const runsError = state?.runsError ?? null;
  const runsUpdatedAt = state?.runsUpdatedAt ?? null;
  const refresh = state?.refresh ?? (() => {});

  const [timelineRun, setTimelineRun] = useState<WorkflowRun | null>(null);
  const [summaryRun, setSummaryRun] = useState<WorkflowRun | null>(null);

  const visibleRuns = useMemo(
    () =>
      filterRuns(runs, filter, (runId) => {
        const cache = jobsByRun[runId];
        return { jobs: cache?.jobs ?? [], loaded: Boolean(cache && !cache.loading) };
      }),
    [runs, filter, jobsByRun],
  );

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'expander',
        header: '',
        cell: (info) => {
          const open = (info.table.options.meta as TableMeta).isExpanded(info.row.original.id);
          return (
            <Octicon
              icon={open ? ChevronDownIcon : ChevronRightIcon}
              size={16}
              sx={{ color: 'fg.muted' }}
            />
          );
        },
      }),
      columnHelper.accessor((r) => statusToOverall(r.status, r.conclusion), {
        id: 'status',
        header: 'Status',
        cell: (info) => <StatusBadge status={info.getValue()} />,
      }),
      columnHelper.display({
        id: 'run',
        header: 'Run',
        cell: (info) => {
          const r = info.row.original;
          return (
            <Box>
              <Text sx={{ fontWeight: 'bold' }}>{r.display_title || r.name || 'Workflow run'}</Text>
              <Text sx={{ color: 'fg.muted', ml: 2, fontSize: 0 }}>
                #{r.run_number}
                {r.run_attempt > 1 ? ` · attempt ${r.run_attempt}` : ''}
              </Text>
            </Box>
          );
        },
      }),
      columnHelper.accessor((r) => r.head_branch ?? '', {
        id: 'branch',
        header: 'Branch',
        cell: (info) =>
          info.getValue() ? (
            <BranchName as="span" sx={{ fontSize: 0 }}>{info.getValue()}</BranchName>
          ) : (
            <Text sx={{ color: 'fg.muted' }}>—</Text>
          ),
      }),
      columnHelper.accessor('event', {
        header: 'Event',
        cell: (info) => (
          <Label variant={eventVariant(info.getValue())}>{info.getValue()}</Label>
        ),
      }),
      columnHelper.display({
        id: 'duration',
        header: 'Duration',
        cell: (info) => {
          const r = info.row.original;
          const start = r.run_started_at ?? r.created_at;
          const end = r.status === 'completed' ? r.updated_at : null;
          return (
            <Text sx={{ color: 'fg.muted', whiteSpace: 'nowrap' }}>
              {formatDuration(start, end)}
            </Text>
          );
        },
      }),
      columnHelper.accessor((r) => r.run_started_at ?? r.created_at, {
        id: 'started',
        header: 'Started',
        cell: (info) => (
          <Text sx={{ color: 'fg.muted', whiteSpace: 'nowrap' }}>
            {formatRelative(info.getValue())}
          </Text>
        ),
      }),
      columnHelper.display({
        id: 'link',
        header: '',
        cell: (info) => {
          const r = info.row.original;
          const meta = info.table.options.meta as TableMeta;
          return (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 }}>
              <IconButton
                size="small"
                variant="invisible"
                icon={ChecklistIcon}
                aria-label="Run summary"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  meta.onSummary(r);
                }}
              />
              <IconButton
                size="small"
                variant="invisible"
                icon={GraphIcon}
                aria-label="Run timeline"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  meta.onTimeline(r);
                }}
              />
              <Link
                href={r.html_url}
                target="_blank"
                rel="noreferrer"
                muted
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                <Octicon icon={LinkExternalIcon} size={14} />
              </Link>
            </Box>
          );
        },
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: visibleRuns,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => String(row.id),
    meta: {
      isExpanded,
      onTimeline: setTimelineRun,
      onSummary: setSummaryRun,
    } satisfies TableMeta,
  });

  const colSpan = table.getAllLeafColumns().length;
  const filteredOut = runs.length > 0 && visibleRuns.length === 0;

  return (
    <Box
      id={`flow-${flow.id}`}
      sx={{
        border: '1px solid',
        borderColor: highlight ? 'accent.emphasis' : 'border.default',
        boxShadow: highlight ? '0 0 0 2px var(--bgColor-accent-muted, rgba(9,105,218,0.3))' : 'none',
        borderRadius: 2,
        mb: 4,
        overflow: 'hidden',
        transition: 'border-color 0.3s, box-shadow 0.3s',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          px: 3,
          py: 2,
          bg: 'canvas.subtle',
          borderBottom: '1px solid',
          borderColor: 'border.default',
          flexWrap: 'wrap',
        }}
      >
        <StatusBadge status={overall} withText={false} size={18} />
        <Heading as="h3" sx={{ fontSize: 2 }}>{flow.name}</Heading>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {flow.branches.map((b) => (
            <BranchName key={b} as="span" sx={{ fontSize: 0 }}>{b}</BranchName>
          ))}
        </Box>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          {flow.owner || ''}
          {flow.owner ? '/' : ''}
          {flow.repo || ''} · {flow.workflowFile}
        </Text>
        <Box sx={{ flex: 1 }} />
        {runsUpdatedAt && (
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
            updated {formatRelative(new Date(runsUpdatedAt).toISOString())}
          </Text>
        )}
        {isFetchingRuns && <Spinner size="small" />}
        <Button leadingVisual={SyncIcon} size="small" onClick={refresh}>
          Refresh
        </Button>
      </Box>

      {runsError && (
        <Flash variant="danger" sx={{ m: 2, fontSize: 0 }}>
          Failed to load runs: {runsError.message}
        </Flash>
      )}

      <Box sx={{ overflowX: 'auto' }}>
        <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
          <Box as="thead">
            {table.getHeaderGroups().map((hg) => (
              <Box as="tr" key={hg.id}>
                {hg.headers.map((h) => (
                  <Box as="th" key={h.id} sx={headerCellSx}>
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
          <Box as="tbody">
            {visibleRuns.length === 0 ? (
              <Box as="tr">
                <Box as="td" colSpan={colSpan} sx={{ p: 4, textAlign: 'center', color: 'fg.muted' }}>
                  {filteredOut
                    ? 'No runs match the current filter.'
                    : isFetchingRuns
                      ? 'Loading runs…'
                      : 'No runs found for the configured branches/events.'}
                </Box>
              </Box>
            ) : (
              table.getRowModel().rows.map((row) => {
                const open = isExpanded(row.original.id);
                return (
                  <Fragment key={row.id}>
                    <Box
                      as="tr"
                      onClick={() => onToggleRun(row.original)}
                      sx={{
                        cursor: 'pointer',
                        ':hover': { bg: 'canvas.subtle' },
                        borderBottom: '1px solid',
                        borderColor: 'border.muted',
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <Box as="td" key={cell.id} sx={bodyCellSx}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </Box>
                      ))}
                    </Box>
                    {open && (
                      <Box as="tr">
                        <Box as="td" colSpan={colSpan} sx={{ p: 0, bg: 'canvas.inset' }}>
                          <Box sx={{ px: 4, py: 2 }}>
                            <JobsTable entry={jobsByRun[row.original.id]} owner={owner} repo={repo} />
                          </Box>
                        </Box>
                      </Box>
                    )}
                  </Fragment>
                );
              })
            )}
          </Box>
        </Box>
      </Box>

      {timelineRun && (
        <FlowRunTimelineDialog
          owner={owner}
          repo={repo}
          run={timelineRun}
          onClose={() => setTimelineRun(null)}
        />
      )}
      {summaryRun && (
        <RunOverallSummaryDialog
          owner={owner}
          repo={repo}
          run={summaryRun}
          onClose={() => setSummaryRun(null)}
        />
      )}
    </Box>
  );
}

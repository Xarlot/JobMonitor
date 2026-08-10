import { Fragment, useMemo, useState } from 'react';
import {
  coreFeatures,
  createColumnHelper,
  createCoreRowModel,
  flexRender,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { BranchName, Button, Flash, Heading, IconButton, Label, Spinner, Text } from '@primer/react';
import {
  ChecklistIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GrabberIcon,
  GraphIcon,
  LinkExternalIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { FlowRunTimelineDialog } from './TimelineDialog';
import { RunOverallSummaryDialog } from './OverallSummaryDialog';
import type { WorkflowRun } from '../api/types';
import type { ResolvedFlow } from '../lib/flowPatterns';
import type { FlowState } from '../hooks/useFlows';
import { useFlowsFilter } from '../context/FlowsFilterContext';
import { isActiveStatus, statusToOverall } from '../lib/status';
import { filterRuns } from '../lib/flowFilter';
import { AnalysedBadge } from './AnalysedBadge';
import { StatusBadge } from './StatusBadge';
import { JobsTable } from './JobsTable';
import { ArtifactsButton } from './ArtifactsButton';
import { formatDuration, formatRelative } from '../lib/format';
import styles from './FlowRunsGrid.module.css';
import { Icon } from './Icon';
import { Feature, Telemetry } from '../lib/telemetry';

interface TableMeta {
  isExpanded: (runId: number) => boolean;
  onTimeline: (run: WorkflowRun) => void;
  onSummary: (run: WorkflowRun) => void;
  owner: string;
  repo: string;
}

/**
 * The feature set this grid actually uses.
 *
 * v9 requires features to be declared rather than inferred: sorting, filtering, pagination and the
 * rest are opt-in, and anything not listed here is absent from both the runtime table and its type.
 * This grid renders every run it is given in the order it receives them — filtering happens upstream
 * in `filterRuns` — so the core feature set plus a row model is the whole of it.
 */
const gridFeatures = tableFeatures({
  ...coreFeatures,
  coreRowModel: createCoreRowModel(),
});

const columnHelper = createColumnHelper<typeof gridFeatures, WorkflowRun>();

/**
 * A column of this grid, with the accessor's value type deliberately left open.
 *
 * The columns below return different things — a status string, a timestamp, nothing at all for the
 * display-only ones — and each `columnHelper` call bakes its own value type into the result. An
 * array of them therefore has a union type that satisfies no single `ColumnDef`, so the array has
 * to be annotated with the value slot widened. This is the shape TanStack's own examples use for a
 * heterogeneous column list; it costs nothing, because a column's value type is consumed inside the
 * cell renderer that produced it and is never read from here.
 */
type GridColumn = ColumnDef<typeof gridFeatures, WorkflowRun, any>;

function eventVariant(event: string): 'accent' | 'done' | 'secondary' {
  if (event === 'workflow_dispatch') return 'accent';
  if (event === 'schedule') return 'done';
  return 'secondary';
}

export interface FlowDnd {
  dragging: boolean;
  /** Show an insertion line at the top / bottom of this card. */
  dropBefore: boolean;
  dropAfter: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (after: boolean) => void;
  onDrop: () => void;
}

export function FlowRunsGrid({
  flow,
  state,
  highlight = false,
  expanded = true,
  onToggle,
  dnd,
}: {
  flow: ResolvedFlow;
  state: FlowState | undefined;
  highlight?: boolean;
  /** Accordion: when false the card is a thin header-only strip. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Drag-and-drop reordering handlers (omitted = not draggable). */
  dnd?: FlowDnd;
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

  const columns = useMemo<GridColumn[]>(
    () => [
      columnHelper.display({
        id: 'expander',
        header: '',
        cell: (info) => {
          const open = (info.table.options.meta as TableMeta).isExpanded(info.row.original.id);
          return (
            <Icon
              icon={open ? ChevronDownIcon : ChevronRightIcon}
              size={16}
              className={styles.fgMuted}
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
            <div>
              <Text className={styles.bold}>{r.display_title || r.name || 'Workflow run'}</Text>
              <Text className={styles.fgMutedMl2}>
                #{r.run_number}
                {r.run_attempt > 1 ? ` · attempt ${r.run_attempt}` : ''}
              </Text>
            </div>
          );
        },
      }),
      columnHelper.accessor((r) => r.head_branch ?? '', {
        id: 'branch',
        header: 'Branch',
        cell: (info) =>
          info.getValue() ? (
            <BranchName as="span" className={styles.small}>{info.getValue()}</BranchName>
          ) : (
            <Text className={styles.fgMuted}>—</Text>
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
            <Text className={styles.fgMutedNowrap}>
              {formatDuration(start, end)}
            </Text>
          );
        },
      }),
      columnHelper.accessor((r) => r.run_started_at ?? r.created_at, {
        id: 'started',
        header: 'Started',
        cell: (info) => (
          <Text className={styles.fgMutedNowrap}>
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
            <div className={styles.flexCenter}>
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
              <ArtifactsButton
                owner={meta.owner}
                repo={meta.repo}
                runId={r.id}
                title="Artifacts"
                subtitle={`${r.display_title || r.name} · run #${r.run_number}`}
                bundleName={`run-${r.run_number}-artifacts`}
              />
              <IconButton
                size="small"
                variant="invisible"
                icon={LinkExternalIcon}
                aria-label="Open run on GitHub"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  window.open(r.html_url, '_blank', 'noopener');
                }}
              />
            </div>
          );
        },
      }),
    ],
    [],
  );

  const table = useTable({
    features: gridFeatures,
    data: visibleRuns,
    columns,
    getRowId: (row) => String(row.id),
    meta: {
      isExpanded,
      onTimeline: (run: WorkflowRun) => {
        Telemetry.featureUsed(Feature.LOGS_TIMELINE_OPENED);
        setTimelineRun(run);
      },
      onSummary: (run: WorkflowRun) => {
        Telemetry.featureUsed(Feature.LOGS_OVERALL_SUMMARY_OPENED);
        setSummaryRun(run);
      },
      owner,
      repo,
    } satisfies TableMeta,
  });

  const colSpan = table.getAllLeafColumns().length;
  const filteredOut = runs.length > 0 && visibleRuns.length === 0;

  return (
    <div
      id={`flow-${flow.id}`}
      onDragOver={
        dnd
          ? (e: React.DragEvent) => {
              e.preventDefault();
              e.stopPropagation(); // don't bubble to the group section's handler
              e.dataTransfer.dropEffect = 'move';
              const r = e.currentTarget.getBoundingClientRect();
              dnd.onDragOver(e.clientY > r.top + r.height / 2); // bottom half = after
            }
          : undefined
      }
      onDrop={
        dnd
          ? (e: React.DragEvent) => {
              e.preventDefault();
              e.stopPropagation();
              dnd.onDrop();
            }
          : undefined
      }
      className={
        dnd?.dropBefore
          ? styles.cardDropBefore
          : dnd?.dropAfter
            ? styles.cardDropAfter
            : dnd?.dragging
              ? styles.cardDragging
              : highlight
                ? styles.cardHighlight
                : styles.card
      }
    >
      <div
        onClick={onToggle}
        className={`${expanded ? styles.cardHeaderExpanded : styles.cardHeader} ${
          onToggle ? styles.cardHeaderClickable : ''
        }`}
      >
        {dnd && (
          <span
            draggable
            title="Drag to reorder"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            onDragStart={(e: React.DragEvent) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', flow.id); // Firefox needs data
              // Drag a ghost of the whole card, not just the tiny grip handle.
              const card = document.getElementById(`flow-${flow.id}`);
              if (card) e.dataTransfer.setDragImage(card, 24, 24);
              dnd.onDragStart();
            }}
            onDragEnd={() => dnd.onDragEnd()}
            className={styles.flexCenter2}
          >
            <GrabberIcon size={16} />
          </span>
        )}
        {onToggle && (
          <Icon
            icon={expanded ? ChevronDownIcon : ChevronRightIcon}
            size={16}
            className={styles.fgMuted}
          />
        )}
        <StatusBadge status={overall} withText={false} size={18} />
        {/*
          The badge reports the last *result*, so "a run is in flight" would otherwise vanish from a
          collapsed card — a different fact, and one worth keeping. A spinner beside the verdict says
          both at once: how it last came out, and that the answer may be about to change.
        */}
        {runs.length > 0 && isActiveStatus(runs[0].status) && (
          <Spinner size="small" aria-label="A run is in progress" />
        )}
        <Heading as="h3" className={styles.large}>{flow.name}</Heading>
        <AnalysedBadge kind="flow" id={flow.id} />
        <div className={styles.flexGap1}>
          {flow.branches.map((b) => (
            <BranchName key={b} as="span" className={styles.small}>{b}</BranchName>
          ))}
        </div>
        <Text
          className={styles.smallFgMuted}
          title={
            flow.source
              ? `Matched by the regex /${flow.source.pattern}/ of flow “${flow.source.patternName}”`
              : undefined
          }
        >
          {flow.owner || ''}
          {flow.owner ? '/' : ''}
          {flow.repo || ''} · {flow.source?.workflow.file ?? flow.workflowFile}
          {flow.source ? ' · regex' : ''}
        </Text>
        <div className={styles.grow} />
        {!expanded && runs.length > 0 && (
          <Text className={styles.smallFgMuted}>
            {runs.length} {runs.length === 1 ? 'run' : 'runs'}
          </Text>
        )}
        {runsUpdatedAt && (
          <Text className={styles.smallFgMuted}>
            updated {formatRelative(new Date(runsUpdatedAt).toISOString())}
          </Text>
        )}
        {isFetchingRuns && <Spinner size="small" />}
        <Button
          leadingVisual={SyncIcon}
          size="small"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            refresh();
          }}
        >
          Refresh
        </Button>
      </div>

      {expanded && runsError && (
        <Flash variant="danger" className={styles.m2Small}>
          Failed to load runs: {runsError.message}
        </Flash>
      )}

      {expanded && (
      <div className={styles.overflowX}>
        <table className={styles.width}>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} className={styles.px2Py2}>
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {visibleRuns.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className={styles.p4TextCenter}>
                  {filteredOut
                    ? 'No runs match the current filter.'
                    : isFetchingRuns
                      ? 'Loading runs…'
                      : 'No runs found for the configured branches/events.'}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => {
                const open = isExpanded(row.original.id);
                return (
                  <Fragment key={row.id}>
                    <tr
                      onClick={() => {
                        // Expanding a run is how someone goes from "it is red" to "which job".
                        if (!open) Telemetry.featureUsed(Feature.FLOW_RUN_EXPANDED);
                        onToggleRun(row.original);
                      }}
                      className={styles.runRow}
                    >
                      {/* `getAllCells`, not `getVisibleCells`: column visibility is a v9 feature
                          this grid does not register, and every column here is always shown. */}
                      {row.getAllCells().map((cell) => (
                        <td key={cell.id} className={styles.px2Py2_2}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={colSpan} className={styles.p0BgCanvasInset}>
                          <div className={styles.pl4Py2}>
                            <JobsTable entry={jobsByRun[row.original.id]} owner={owner} repo={repo} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      )}

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
    </div>
  );
}

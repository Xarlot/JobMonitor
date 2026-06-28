import { useState, type ReactNode } from 'react';
import { Box, BranchName, Button, Heading, IconButton, Label, Octicon, Spinner, Text } from '@primer/react';
import {
  ChecklistIcon,
  CheckCircleFillIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GitPullRequestIcon,
  GrabberIcon,
  GraphIcon,
  LinkExternalIcon,
  PencilIcon,
  PlusIcon,
  SyncIcon,
  TrashIcon,
  WorkflowIcon,
} from '@primer/octicons-react';
import { useDashboard } from '../context/DashboardContext';
import { useFlowStates } from '../context/FlowsRuntimeContext';
import { useFlowGroups } from '../hooks/useFlowGroups';
import type { OverallStatus, WorkflowRun } from '../api/types';
import type { Flow } from '../storage/configStore';
import type { PrEntry } from '../hooks/useGitHubDashboard';
import { statusToOverall } from '../lib/status';
import { isFlowEmpty, latestRunJobs } from '../lib/flowEmptiness';
import { StatusBadge } from './StatusBadge';
import { formatRelative } from '../lib/format';
import { OverallSummaryDialog, RunOverallSummaryDialog } from './OverallSummaryDialog';
import { FlowRunTimelineDialog, TimelineDialog, type GanttItem } from './TimelineDialog';
import { GroupStatusCounts } from './GroupStatusCounts';

const STATUS_BORDER: Record<OverallStatus, string> = {
  success: 'success.emphasis',
  failure: 'danger.emphasis',
  pending: 'attention.emphasis',
  in_progress: 'attention.emphasis',
  neutral: 'border.default',
  unknown: 'border.default',
};

const titleSx = {
  fontWeight: 'bold',
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

function open(url: string | null | undefined) {
  if (url) window.open(url, '_blank', 'noopener');
}

interface TileDnd {
  flowId: string;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onDragOver: (after: boolean) => void;
  onDrop: () => void;
}

function Tile({
  status,
  onOpen,
  actions,
  children,
  dnd,
}: {
  status: OverallStatus;
  onOpen: () => void;
  actions?: ReactNode;
  children: ReactNode;
  dnd?: TileDnd;
}) {
  return (
    <Box
      id={dnd ? `flow-tile-${dnd.flowId}` : undefined}
      onDragOver={
        dnd
          ? (e: React.DragEvent) => {
              e.preventDefault();
              e.stopPropagation(); // don't bubble to the group section's handler
              e.dataTransfer.dropEffect = 'move';
              const r = e.currentTarget.getBoundingClientRect();
              dnd.onDragOver(e.clientX > r.left + r.width / 2); // right half = after
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
      sx={{
        position: 'relative',
        bg: 'canvas.default',
        color: 'fg.default',
        border: '1px solid',
        borderColor: 'border.default',
        borderLeft: '4px solid',
        borderLeftColor: STATUS_BORDER[status],
        borderRadius: 2,
        p: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        opacity: dnd?.dragging ? 0.4 : 1,
        boxShadow: dnd?.dropBefore
          ? 'inset 3px 0 0 0 var(--fgColor-accent, #2f81f7)'
          : dnd?.dropAfter
            ? 'inset -3px 0 0 0 var(--fgColor-accent, #2f81f7)'
            : 'none',
        ':hover': { borderColor: 'border.muted' },
      }}
    >
      <Box
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
        sx={{ display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', flex: 1 }}
      >
        {children}
      </Box>
      {actions && (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 1,
            pt: 2,
            borderTop: '1px solid',
            borderColor: 'border.muted',
          }}
        >
          {actions}
        </Box>
      )}
    </Box>
  );
}

function latestRun(runs: WorkflowRun[]): WorkflowRun | undefined {
  return runs[0];
}

type Dlg =
  | { kind: 'flowSummary' | 'flowTimeline'; owner: string; repo: string; run: WorkflowRun }
  | { kind: 'prSummary' | 'prTimeline'; entry: PrEntry };

export function Overview({
  onOpenFlow,
  onOpenPrs,
}: {
  onOpenFlow: (flowId: string) => void;
  onOpenPrs: () => void;
}) {
  const { config, sections, moveFlow, addGroup, renameGroup, deleteGroup, setCollapsed } =
    useFlowGroups();
  const { owner: upOwner, repo: upRepo } = config.upstream;
  const { prs, refreshAll, isFetchingList, isFetchingChecks } = useDashboard();
  const flowStates = useFlowStates();
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<{ id: string; after: boolean } | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null); // group id, '' = ungrouped

  const resetDrag = () => {
    setDragId(null);
    setDropEdge(null);
    setDropGroup(null);
  };

  const isVisible = (flow: Flow) => {
    const state = flowStates.get(flow.id);
    return !isFlowEmpty(
      {
        runs: state?.runs ?? [],
        latestArtifactBytes: state?.latestArtifactBytes ?? null,
        latestJobs: latestRunJobs(state?.runs ?? [], state?.jobsByRun ?? {}),
      },
      flow.emptyFilter,
    );
  };

  // Drop the dragged tile next to the hovered tile (within or across groups).
  const dropOnTile = () => {
    if (!dragId || !dropEdge) return resetDrag();
    const sec = sections.find((s) => s.flows.some((f) => f.id === dropEdge.id));
    if (!sec) return resetDrag();
    const idx = sec.flows.findIndex((f) => f.id === dropEdge.id);
    const beforeFlowId = dropEdge.after ? (sec.flows[idx + 1]?.id ?? null) : dropEdge.id;
    moveFlow(dragId, sec.group?.id ?? null, beforeFlowId);
    resetDrag();
  };
  const dropOnGroup = (groupId: string | null) => {
    if (dragId) moveFlow(dragId, groupId, null);
    resetDrag();
  };

  const tileDnd = (flow: Flow) => ({
    flowId: flow.id,
    dragging: dragId === flow.id,
    dropBefore: dropEdge?.id === flow.id && !dropEdge.after && dragId !== flow.id,
    dropAfter: dropEdge?.id === flow.id && dropEdge.after && dragId !== flow.id,
    onDragOver: (after: boolean) => {
      if (!dragId || dragId === flow.id) return;
      setDropGroup(null);
      setDropEdge((cur) => (cur && cur.id === flow.id && cur.after === after ? cur : { id: flow.id, after }));
    },
    onDrop: dropOnTile,
  });

  const refreshEverything = () => {
    refreshAll();
    for (const s of flowStates.values()) s.refresh();
  };

  const visibleFlows = sections.flatMap((s) => s.flows.filter(isVisible));

  const failingPrs = prs.filter((e) => e.overall === 'failure').length;
  const failingFlows = visibleFlows.filter((f) => {
    const run = latestRun(flowStates.get(f.id)?.runs ?? []);
    return run ? statusToOverall(run.status, run.conclusion) === 'failure' : false;
  }).length;
  const totalFailing = failingPrs + failingFlows;

  const checkItems = (entry: PrEntry): GanttItem[] =>
    entry.checkRuns.map((c) => ({
      id: c.id,
      label: c.name,
      status: statusToOverall(c.status, c.conclusion),
      started_at: c.started_at,
      completed_at: c.completed_at,
    }));

  const iconBtn = (icon: typeof GraphIcon, label: string, onClick: () => void) => (
    <IconButton
      size="small"
      variant="invisible"
      icon={icon}
      aria-label={label}
      onClick={onClick}
    />
  );

  const renderFlowTile = (flow: Flow) => {
    const state = flowStates.get(flow.id);
    const run = latestRun(state?.runs ?? []);
    const status = run ? statusToOverall(run.status, run.conclusion) : 'unknown';
    const fOwner = state?.owner ?? flow.owner ?? upOwner;
    const fRepo = state?.repo ?? flow.repo ?? upRepo;
    return (
      <Tile
        key={flow.id}
        status={status}
        onOpen={() => onOpenFlow(flow.id)}
        dnd={tileDnd(flow)}
        actions={
          run ? (
            <>
              {iconBtn(ChecklistIcon, 'Run summary', () =>
                setDlg({ kind: 'flowSummary', owner: fOwner, repo: fRepo, run }),
              )}
              {iconBtn(GraphIcon, 'Run timeline', () =>
                setDlg({ kind: 'flowTimeline', owner: fOwner, repo: fRepo, run }),
              )}
              {iconBtn(LinkExternalIcon, 'Open run on GitHub', () => open(run.html_url))}
            </>
          ) : undefined
        }
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box
            as="span"
            draggable
            title="Drag to reorder"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            onDragStart={(e: React.DragEvent) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', flow.id);
              const el = document.getElementById(`flow-tile-${flow.id}`);
              if (el) e.dataTransfer.setDragImage(el, 24, 24);
              setDragId(flow.id);
            }}
            onDragEnd={resetDrag}
            sx={{ display: 'flex', flexShrink: 0, cursor: 'grab', color: 'fg.muted' }}
          >
            <Octicon icon={GrabberIcon} size={16} />
          </Box>
          <StatusBadge status={status} withText={false} size={18} />
          <Text sx={titleSx}>{flow.name}</Text>
          <Octicon icon={ChevronRightIcon} size={14} sx={{ color: 'fg.muted' }} />
        </Box>
        {run ? (
          <>
            <Text sx={{ fontSize: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              latest: {run.display_title || run.name || 'run'}{' '}
              <Text as="span" sx={{ color: 'fg.muted' }}>#{run.run_number}</Text>
            </Text>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
              <Label variant="secondary">{run.event}</Label>
              <Text sx={{ fontSize: 0 }}>{formatRelative(run.run_started_at ?? run.created_at)}</Text>
            </Box>
          </>
        ) : (
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{state ? 'no runs yet' : 'loading…'}</Text>
        )}
      </Tile>
    );
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 4 }}>
        <Octicon
          icon={totalFailing > 0 ? WorkflowIcon : CheckCircleFillIcon}
          size={20}
          sx={{ color: totalFailing > 0 ? 'danger.fg' : 'success.fg' }}
        />
        <Heading as="h2" sx={{ fontSize: 3 }}>
          {totalFailing > 0 ? `${totalFailing} failing` : 'All green'}
        </Heading>
        <Text sx={{ color: 'fg.muted' }}>
          across {prs.length} PRs and {visibleFlows.length} flows
        </Text>
        <Box sx={{ flex: 1 }} />
        {(isFetchingList || isFetchingChecks) && <Spinner size="small" />}
        <Button leadingVisual={SyncIcon} size="small" onClick={refreshEverything}>
          Refresh
        </Button>
      </Box>

      <Heading as="h3" sx={{ fontSize: 1, color: 'fg.muted', mb: 2 }}>
        <Octicon icon={GitPullRequestIcon} size={14} sx={{ mr: 1 }} />
        Pull requests
      </Heading>
      {prs.length === 0 ? (
        <Text sx={{ color: 'fg.muted' }}>No open pull requests.</Text>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 3, mb: 5 }}>
          {prs.map((entry) => (
            <Tile
              key={entry.pr.number}
              status={entry.overall}
              onOpen={onOpenPrs}
              actions={
                <>
                  {iconBtn(ChecklistIcon, 'Checks summary', () => setDlg({ kind: 'prSummary', entry }))}
                  {iconBtn(GraphIcon, 'Check timeline', () => setDlg({ kind: 'prTimeline', entry }))}
                  {iconBtn(LinkExternalIcon, 'Open PR on GitHub', () => open(entry.pr.html_url))}
                </>
              }
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <StatusBadge status={entry.overall} withText={false} size={18} />
                <Text sx={titleSx}>{entry.pr.title}</Text>
                <Octicon icon={ChevronRightIcon} size={14} sx={{ color: 'fg.muted' }} />
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
                <Text sx={{ fontSize: 0 }}>#{entry.pr.number}</Text>
                <BranchName as="span" sx={{ fontSize: 0 }}>{entry.pr.head.ref}</BranchName>
              </Box>
            </Tile>
          ))}
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Heading as="h3" sx={{ fontSize: 1, color: 'fg.muted' }}>
          <Octicon icon={WorkflowIcon} size={14} sx={{ mr: 1 }} />
          Flows
        </Heading>
        <Box sx={{ flex: 1 }} />
        <Button
          leadingVisual={PlusIcon}
          size="small"
          onClick={() => {
            const name = window.prompt('New group name', 'New group');
            if (name && name.trim()) addGroup(name.trim());
          }}
        >
          New group
        </Button>
      </Box>
      {config.flows.length === 0 ? (
        <Text sx={{ color: 'fg.muted' }}>No flows configured — add one in Settings.</Text>
      ) : (
        sections.map((section) => {
          const group = section.group;
          const groupKey = group ? group.id : '';
          const visible = section.flows.filter(isVisible);
          if (!group && visible.length === 0 && config.groups.length > 0) return null;
          const collapsed = group?.collapsed ?? false;
          const isDropTarget = Boolean(dragId) && dropGroup === groupKey;
          return (
            <Box
              key={groupKey || '__ungrouped'}
              onDragOver={
                dragId
                  ? (e: React.DragEvent) => {
                      e.preventDefault();
                      setDropEdge(null);
                      setDropGroup(groupKey);
                    }
                  : undefined
              }
              onDrop={
                dragId
                  ? (e: React.DragEvent) => {
                      e.preventDefault();
                      dropOnGroup(group?.id ?? null);
                    }
                  : undefined
              }
              sx={{
                mb: 4,
                py: 2,
                borderRadius: 2,
                border: '1px dashed',
                borderColor: isDropTarget ? 'accent.emphasis' : 'transparent',
                bg: isDropTarget ? 'accent.subtle' : 'transparent',
                transition: 'border-color 0.12s, background-color 0.12s',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: collapsed ? 0 : 2 }}>
                <IconButton
                  size="small"
                  variant="invisible"
                  aria-label={collapsed ? 'Expand group' : 'Collapse group'}
                  icon={collapsed ? ChevronRightIcon : ChevronDownIcon}
                  onClick={() => group && setCollapsed(group.id, !collapsed)}
                  sx={{ visibility: group ? 'visible' : 'hidden' }}
                />
                <Heading as="h4" sx={{ fontSize: 0, color: group ? 'fg.default' : 'fg.muted' }}>
                  {group ? group.name : 'Ungrouped'}
                </Heading>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>· {visible.length}</Text>
                <GroupStatusCounts
                  statuses={visible.map((f) => {
                    const run = latestRun(flowStates.get(f.id)?.runs ?? []);
                    return run ? statusToOverall(run.status, run.conclusion) : 'unknown';
                  })}
                />
                <Box sx={{ flex: 1 }} />
                {group && (
                  <>
                    <IconButton
                      size="small"
                      variant="invisible"
                      aria-label="Rename group"
                      icon={PencilIcon}
                      onClick={() => {
                        const n = window.prompt('Rename group', group.name);
                        if (n && n.trim()) renameGroup(group.id, n.trim());
                      }}
                    />
                    <IconButton
                      size="small"
                      variant="invisible"
                      aria-label="Delete group"
                      icon={TrashIcon}
                      onClick={() => {
                        if (window.confirm(`Delete group “${group.name}”? Its flows become ungrouped.`))
                          deleteGroup(group.id);
                      }}
                    />
                  </>
                )}
              </Box>
              {!collapsed &&
                (visible.length > 0 ? (
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 3 }}>
                    {visible.map(renderFlowTile)}
                  </Box>
                ) : (
                  <Box
                    sx={{
                      p: 3,
                      textAlign: 'center',
                      color: 'fg.muted',
                      fontSize: 0,
                      border: '1px dashed',
                      borderColor: 'border.muted',
                      borderRadius: 2,
                    }}
                  >
                    {group ? 'Drop flows here' : 'No ungrouped flows'}
                  </Box>
                ))}
            </Box>
          );
        })
      )}

      {dlg?.kind === 'flowSummary' && (
        <RunOverallSummaryDialog owner={dlg.owner} repo={dlg.repo} run={dlg.run} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === 'flowTimeline' && (
        <FlowRunTimelineDialog owner={dlg.owner} repo={dlg.repo} run={dlg.run} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === 'prSummary' && (
        <OverallSummaryDialog
          title={dlg.entry.pr.title}
          subtitle={`#${dlg.entry.pr.number} · checks summary`}
          owner={upOwner}
          repo={upRepo}
          items={dlg.entry.checkRuns.map((c) => ({
            id: c.id,
            label: c.name,
            status: statusToOverall(c.status, c.conclusion),
            checkRunId: c.id,
          }))}
          htmlUrl={dlg.entry.pr.html_url}
          onClose={() => setDlg(null)}
        />
      )}
      {dlg?.kind === 'prTimeline' && (
        <TimelineDialog
          title={dlg.entry.pr.title}
          subtitle={`#${dlg.entry.pr.number} · check timeline`}
          items={checkItems(dlg.entry)}
          onClose={() => setDlg(null)}
        />
      )}
    </Box>
  );
}

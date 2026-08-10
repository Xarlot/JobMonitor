import { useState, type ReactNode } from 'react';
import { BranchName, Button, Heading, IconButton, Label, Spinner, Text } from '@primer/react';
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
import { useResolvedFlows } from '../context/ResolvedFlowsContext';
import { useFlowGroups } from '../hooks/useFlowGroups';
import type { OverallStatus, WorkflowRun } from '../api/types';
import type { ResolvedFlow } from '../lib/flowPatterns';
import type { FlowGroup } from '../storage/configStore';
import type { PrEntry } from '../hooks/useGitHubDashboard';
import { statusToOverall, latestFinalStatus } from '../lib/status';
import { isFlowHidden, latestRunJobs } from '../lib/flowEmptiness';
import { StatusBadge } from './StatusBadge';
import { formatRelative } from '../lib/format';
import { OverallSummaryDialog, RunOverallSummaryDialog } from './OverallSummaryDialog';
import { FlowRunTimelineDialog, TimelineDialog, type GanttItem } from './TimelineDialog';
import { GroupStatusCounts, groupVerdict } from './GroupStatusCounts';
import { ArtifactsButton } from './ArtifactsButton';
import { RerunFailedJobsButton } from './RerunFailedJobsButton';
import { PromptDialog } from './PromptDialog';
import { UnmatchedFlowsDialog } from './UnmatchedFlowsDialog';
import { runIdFromUrl } from '../api/endpoints';
import styles from './Overview.module.css';
import { Icon } from './Icon';
import { Feature, Telemetry } from '../lib/telemetry';

/** The card's left edge, keyed by status. A CSS value, since it is chosen at runtime. */
const STATUS_BORDER: Record<OverallStatus, string> = {
  success: 'var(--bgColor-success-emphasis)',
  failure: 'var(--bgColor-danger-emphasis)',
  pending: 'var(--bgColor-attention-emphasis)',
  in_progress: 'var(--bgColor-attention-emphasis)',
  neutral: 'var(--borderColor-default)',
  unknown: 'var(--borderColor-default)',
};

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
    <div
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
      className={
        dnd?.dropBefore
          ? styles.cardDropBefore
          : dnd?.dropAfter
            ? styles.cardDropAfter
            : dnd?.dragging
              ? styles.cardDragging
              : styles.card
      }
      style={{ borderLeftColor: STATUS_BORDER[status] }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
        className={styles.flexCol}
      >
        {children}
      </div>
      {actions && (
        <div
          className={styles.flexEnd}
        >
          {actions}
        </div>
      )}
    </div>
  );
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
  const {
    config,
    flows,
    sections,
    resolving,
    moveFlow,
    addGroup,
    renameGroup,
    deleteGroup,
    setCollapsed,
    describeId,
  } = useFlowGroups();
  const { refresh: refreshPatterns } = useResolvedFlows();
  const { owner: upOwner, repo: upRepo } = config.upstream;
  const { prs, refreshAll, isFetchingList, isFetchingChecks, invalidateChecks } = useDashboard();
  const flowStates = useFlowStates();
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [groupPrompt, setGroupPrompt] = useState<{ mode: 'create' | 'rename'; group?: FlowGroup } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<{ id: string; after: boolean } | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null); // group id, '' = ungrouped
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const resetDrag = () => {
    setDragId(null);
    setDropEdge(null);
    setDropGroup(null);
  };

  const isVisible = (flow: ResolvedFlow) => {
    const state = flowStates.get(flow.id);
    return !isFlowHidden(
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

  const tileDnd = (flow: ResolvedFlow) => ({
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
    refreshPatterns(); // pick up workflows added since the last resolve
    for (const s of flowStates.values()) s.refresh();
  };

  const visibleFlows = sections.flatMap((s) => s.flows.filter(isVisible));

  const failingPrs = prs.filter((e) => e.overall === 'failure').length;
  const failingFlows = visibleFlows.filter(
    (f) => latestFinalStatus(flowStates.get(f.id)?.runs ?? []) === 'failure',
  ).length;
  const totalFailing = failingPrs + failingFlows;

  const checkItems = (entry: PrEntry): GanttItem[] =>
    entry.checkRuns.map((c) => ({
      id: c.id,
      label: c.name,
      status: statusToOverall(c.status, c.conclusion),
      started_at: c.started_at,
      completed_at: c.completed_at,
    }));

  // Artifacts are per-run; the Actions run id lives in a check-run's details_url.
  const prRunId = (entry: PrEntry): number | null =>
    entry.checkRuns
      .map((c) => runIdFromUrl(c.details_url) ?? runIdFromUrl(c.html_url))
      .find((id) => id != null) ?? null;

  const iconBtn = (icon: typeof GraphIcon, label: string, onClick: () => void) => (
    <IconButton
      size="small"
      variant="invisible"
      icon={icon}
      aria-label={label}
      onClick={onClick}
    />
  );

  const renderFlowTile = (flow: ResolvedFlow) => {
    const state = flowStates.get(flow.id);
    const runs = state?.runs ?? [];
    const run = runs[0];
    const status = latestFinalStatus(runs);
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
              <ArtifactsButton
                owner={fOwner}
                repo={fRepo}
                runId={run.id}
                title="Artifacts"
                subtitle={`${run.display_title || run.name} · run #${run.run_number}`}
                bundleName={`run-${run.run_number}-artifacts`}
              />
              {iconBtn(LinkExternalIcon, 'Open run on GitHub', () => open(run.html_url))}
            </>
          ) : undefined
        }
      >
        <div className={styles.flexCenter}>
          <span
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
            className={styles.flexGrab}
          >
            <GrabberIcon size={16} />
          </span>
          <StatusBadge status={status} withText={false} size={18} />
          <Text className={styles.boldGrow}>{flow.name}</Text>
          <ChevronRightIcon size={14} className={styles.fgMuted} />
        </div>
        {run ? (
          <>
            <Text className={styles.smallNowrap}>
              latest: {run.display_title || run.name || 'run'}{' '}
              <Text as="span" className={styles.fgMuted}>#{run.run_number}</Text>
            </Text>
            <div className={styles.flexCenter2}>
              <Label variant="secondary">{run.event}</Label>
              <Text className={styles.small}>{formatRelative(run.run_started_at ?? run.created_at)}</Text>
            </div>
          </>
        ) : (
          <Text className={styles.smallFgMuted}>{state ? 'no runs yet' : 'loading…'}</Text>
        )}
      </Tile>
    );
  };

  return (
    <div>
      <div className={styles.flexCenter3}>
        <Icon
          icon={totalFailing > 0 ? WorkflowIcon : CheckCircleFillIcon}
          size={20}
          className={totalFailing > 0 ? styles.failingCountBad : styles.failingCount}
        />
        <Heading as="h2" className={styles.title}>
          {totalFailing > 0 ? `${totalFailing} failing` : 'All green'}
        </Heading>
        <Text className={styles.fgMuted}>
          across {prs.length} PRs and {visibleFlows.length} flows
        </Text>
        <div className={styles.grow} />
        {(isFetchingList || isFetchingChecks) && <Spinner size="small" />}
        <Button leadingVisual={SyncIcon} size="small" onClick={refreshEverything}>
          Refresh
        </Button>
      </div>

      <Heading as="h3" className={styles.bodyFgMuted}>
        <GitPullRequestIcon size={14} className={styles.mr1} />
        Pull requests
      </Heading>
      {prs.length === 0 ? (
        <Text className={styles.fgMuted}>No open pull requests.</Text>
      ) : (
        <div className={styles.gridGap2}>
          {prs.map((entry) => (
            <Tile
              key={entry.pr.number}
              status={entry.overall}
              onOpen={onOpenPrs}
              actions={
                <>
                  {iconBtn(ChecklistIcon, 'Checks summary', () => setDlg({ kind: 'prSummary', entry }))}
                  {iconBtn(GraphIcon, 'Check timeline', () => setDlg({ kind: 'prTimeline', entry }))}
                  {(() => {
                    const rid = prRunId(entry);
                    return rid != null ? (
                      <ArtifactsButton
                        owner={upOwner}
                        repo={upRepo}
                        runId={rid}
                        title="Artifacts"
                        subtitle={`${entry.pr.title} · #${entry.pr.number}`}
                        bundleName={`pr-${entry.pr.number}-artifacts`}
                      />
                    ) : null;
                  })()}
                  <RerunFailedJobsButton
                    owner={upOwner}
                    repo={upRepo}
                    headSha={entry.pr.head.sha}
                    subtitle={`${entry.pr.title} · #${entry.pr.number}`}
                    onRerun={() => invalidateChecks(entry.pr.number)}
                  />
                  {iconBtn(LinkExternalIcon, 'Open PR on GitHub', () => open(entry.pr.html_url))}
                </>
              }
            >
              <div className={styles.flexCenter}>
                <StatusBadge status={entry.overall} withText={false} size={18} />
                <Text className={styles.boldGrow}>{entry.pr.title}</Text>
                <ChevronRightIcon size={14} className={styles.fgMuted} />
              </div>
              <div className={styles.flexCenter2}>
                <Text className={styles.small}>#{entry.pr.number}</Text>
                <BranchName as="span" className={styles.small}>{entry.pr.head.ref}</BranchName>
              </div>
            </Tile>
          ))}
        </div>
      )}

      <div className={styles.flexCenter4}>
        <Heading as="h3" className={styles.bodyFgMuted2}>
          <WorkflowIcon size={14} className={styles.mr1} />
          Flows
        </Heading>
        <div className={styles.grow} />
        <Button
          leadingVisual={PlusIcon}
          size="small"
          onClick={() => {
                Telemetry.featureUsed(Feature.FLOW_GROUP_CREATED);
                setGroupPrompt({ mode: 'create' });
              }}
        >
          New group
        </Button>
      </div>
      {config.flows.length === 0 ? (
        <Text className={styles.fgMuted}>No flows configured — add one in Settings.</Text>
      ) : flows.length === 0 && resolving ? (
        <Text className={styles.fgMuted}>Matching workflows against the configured regex…</Text>
      ) : (
        sections.map((section) => {
          const group = section.group;
          const groupKey = group ? group.id : '';
          const visible = section.flows.filter(isVisible);
          if (!group && visible.length === 0 && config.groups.length > 0 && section.pinnedMissing.length === 0)
            return null;
          const collapsed = group?.collapsed ?? false;
          const isDropTarget = Boolean(dragId) && dropGroup === groupKey;
          return (
            <div
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
              className={isDropTarget ? styles.dropZoneActive : styles.dropZone}
            >
              {/* With no groups at all, there's just one ungrouped list — skip the header. */}
              {(group || config.groups.length > 0) && (
                <div className={collapsed ? styles.groupHeaderCollapsed : styles.groupHeader}>
                  <IconButton
                    size="small"
                    variant="invisible"
                    aria-label={collapsed ? 'Expand group' : 'Collapse group'}
                    icon={collapsed ? ChevronRightIcon : ChevronDownIcon}
                    onClick={() => group && setCollapsed(group.id, !collapsed)}
                    className={group ? undefined : styles.hiddenControl}
                  />
                  <Heading as="h4" className={group ? styles.groupNameNamed : styles.groupName}>
                    {group ? group.name : 'Ungrouped'}
                  </Heading>
                  <Text className={styles.smallFgMuted}>· {visible.length}</Text>
                  <GroupStatusCounts
                    verdicts={visible.map((f) => groupVerdict(flowStates.get(f.id)?.runs ?? []))}
                  />
                  {/* Placement kept for a flow that's gone or no longer matched. */}
                  {!resolving && section.pinnedMissing.length > 0 && (
                    <Button
                      size="small"
                      variant="invisible"
                      className={styles.attentionFgSmall}
                      title={`Placed here but not available right now:\n${section.pinnedMissing.map(describeId).join('\n')}\n\nClick to review / remove.`}
                      onClick={() => {
                        Telemetry.featureUsed(Feature.FLOW_UNMATCHED_DIALOG_OPENED);
                        setCleanupOpen(true);
                      }}
                    >
                      {section.pinnedMissing.length} unmatched
                    </Button>
                  )}
                  <div className={styles.grow} />
                  {group && (
                    <>
                      <IconButton
                        size="small"
                        variant="invisible"
                        aria-label="Rename group"
                        icon={PencilIcon}
                        onClick={() => {
                          Telemetry.featureUsed(Feature.FLOW_EDITED);
                          setGroupPrompt({ mode: 'rename', group });
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
                </div>
              )}
              {!collapsed &&
                (visible.length > 0 ? (
                  <div className={styles.gridGap2_2}>
                    {visible.map(renderFlowTile)}
                  </div>
                ) : (
                  <div
                    className={styles.p3TextCenter}
                  >
                    {group ? 'Drop flows here' : 'No ungrouped flows'}
                  </div>
                ))}
            </div>
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
      {cleanupOpen && <UnmatchedFlowsDialog onClose={() => setCleanupOpen(false)} />}
      {groupPrompt && (
        <PromptDialog
          title={groupPrompt.mode === 'create' ? 'New group' : 'Rename group'}
          label="Group name"
          initialValue={groupPrompt.mode === 'create' ? '' : (groupPrompt.group?.name ?? '')}
          submitLabel={groupPrompt.mode === 'create' ? 'Create' : 'Rename'}
          onSubmit={(name) =>
            groupPrompt.mode === 'create'
              ? addGroup(name)
              : groupPrompt.group && renameGroup(groupPrompt.group.id, name)
          }
          onClose={() => setGroupPrompt(null)}
        />
      )}
    </div>
  );
}

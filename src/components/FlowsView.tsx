import { useEffect, useState } from 'react';
import { Button, Flash, Heading, IconButton, SegmentedControl, Select, Spinner, Text, TextInput } from '@primer/react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  WorkflowIcon,
  XIcon,
} from '@primer/octicons-react';
import { useFlowStates } from '../context/FlowsRuntimeContext';
import { useFlowGroups } from '../hooks/useFlowGroups';
import { isFlowHidden, latestRunJobs } from '../lib/flowEmptiness';
import {
  DEFAULT_FLOWS_FILTER,
  isJobFilterActive,
  useFlowsFilter,
  type JobStateFilter,
  type RunStatusFilter,
} from '../context/FlowsFilterContext';
import { useViewMode } from '../context/ViewModeContext';
import type { ResolvedFlow } from '../lib/flowPatterns';
import type { FlowGroup } from '../storage/configStore';
import { FlowRunsGrid } from './FlowRunsGrid';
import { FlowBoardDialog } from './FlowBoardDialog';
import { UnmatchedFlowsDialog } from './UnmatchedFlowsDialog';
import { PromptDialog } from './PromptDialog';
import { GroupStatusCounts, groupVerdict } from './GroupStatusCounts';
import styles from './FlowsView.module.css';
import { Feature, Telemetry } from '../lib/telemetry';

const RUN_FILTERS: { value: RunStatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'failed', label: 'Failed' },
  { value: 'success', label: 'Success' },
];

const JOB_STATES: { value: JobStateFilter; label: string }[] = [
  { value: 'any', label: 'present (any status)' },
  { value: 'success', label: 'succeeded' },
  { value: 'failure', label: 'failed' },
  { value: 'in_progress', label: 'in progress' },
  { value: 'not_skipped', label: 'not skipped' },
];

const EXPANDED_KEY = 'job-monitor.flows.expanded';
/** Returns the saved expanded flow id, '' for "all collapsed", or null if unset. */
function loadExpanded(): string | null {
  try {
    return localStorage.getItem(EXPANDED_KEY);
  } catch {
    return null;
  }
}
function saveExpanded(id: string | null): void {
  try {
    localStorage.setItem(EXPANDED_KEY, id ?? '');
  } catch {
    /* ignore */
  }
}

function FlowsToolbar() {
  const { filter, setFilter } = useFlowsFilter();
  const { compact, setCompact } = useViewMode();
  const jobActive = isJobFilterActive(filter);
  return (
    <div className={styles.flexCenter}>
      <SegmentedControl aria-label="Filter runs by status">
        {RUN_FILTERS.map((f) => (
          <SegmentedControl.Button
            key={f.value}
            selected={filter.runStatus === f.value}
            onClick={() => setFilter({ ...filter, runStatus: f.value })}
          >
            {f.label}
          </SegmentedControl.Button>
        ))}
      </SegmentedControl>

      <SegmentedControl aria-label="Job view density">
        <SegmentedControl.Button selected={!compact} onClick={() => setCompact(false)}>
          All jobs
        </SegmentedControl.Button>
        <SegmentedControl.Button selected={compact} onClick={() => setCompact(true)}>
          Compact
        </SegmentedControl.Button>
      </SegmentedControl>

      <div className={styles.flexCenter2}>
        <Text className={styles.bodyBold}>Job filter</Text>
        <TextInput
          leadingVisual={SearchIcon}
          value={filter.jobName}
          onChange={(e) => setFilter({ ...filter, jobName: e.target.value })}
          placeholder="job name contains…"
          aria-label="Job filter"
          className={styles.width}
        />
      </div>

      <div className={styles.flexCenter2}>
        <Text
          className={jobActive ? styles.filterLabelActive : styles.filterLabel}
        >
          Job is
        </Text>
        <Select
          value={filter.jobState}
          onChange={(e) => setFilter({ ...filter, jobState: e.target.value as JobStateFilter })}
          disabled={!jobActive}
          aria-label="Job is"
          className={styles.width}
        >
          {JOB_STATES.map((s) => (
            <Select.Option key={s.value} value={s.value}>
              {s.label}
            </Select.Option>
          ))}
        </Select>
      </div>

      {(jobActive || filter.runStatus !== 'all') && (
        <Button leadingVisual={XIcon} variant="invisible" onClick={() => setFilter(DEFAULT_FLOWS_FILTER)}>
          Clear
        </Button>
      )}

      {jobActive && (
        <Text className={styles.smallFgMuted}>Loading jobs to evaluate the filter…</Text>
      )}
    </div>
  );
}

export function FlowsView({ focusFlowId }: { focusFlowId?: string | null }) {
  const states = useFlowStates();
  const {
    config,
    flows,
    sections,
    patterns,
    resolving,
    addGroup,
    renameGroup,
    deleteGroup,
    setCollapsed,
    moveFlow,
    describeId,
  } = useFlowGroups();

  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Accordion: at most one flow expanded across all groups.
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    const saved = loadExpanded();
    return saved === null ? (flows[0]?.id ?? null) : saved || null;
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<{ id: string; after: boolean } | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null); // group id, '' = ungrouped
  const [boardOpen, setBoardOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [groupPrompt, setGroupPrompt] = useState<{ mode: 'create' | 'rename'; group?: FlowGroup } | null>(null);

  const resetDrag = () => {
    setDragId(null);
    setDropEdge(null);
    setDropGroup(null);
  };

  const toggleExpand = (id: string) =>
    setExpandedId((cur) => {
      const next = cur === id ? null : id;
      saveExpanded(next);
      return next;
    });

  // Regex flows resolve a moment after mount, so the default "expand the first
  // card" has nothing to pick yet on the first render — apply it once they land.
  useEffect(() => {
    if (loadExpanded() !== null) return; // the user already chose
    setExpandedId((cur) => cur ?? flows[0]?.id ?? null);
  }, [flows]);

  useEffect(() => {
    if (!focusFlowId) return;
    setExpandedId(focusFlowId);
    saveExpanded(focusFlowId);
    const el = document.getElementById(`flow-${focusFlowId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setHighlightId(focusFlowId);
    const t = setTimeout(() => setHighlightId(null), 2200);
    return () => clearTimeout(t);
  }, [focusFlowId]);

  const isVisible = (flow: ResolvedFlow) => {
    const st = states.get(flow.id);
    return !isFlowHidden(
      {
        runs: st?.runs ?? [],
        latestArtifactBytes: st?.latestArtifactBytes ?? null,
        latestJobs: latestRunJobs(st?.runs ?? [], st?.jobsByRun ?? {}),
      },
      flow.emptyFilter,
    );
  };

  // Drop the dragged flow next to the hovered card (within or across groups).
  const dropOnFlow = () => {
    if (!dragId || !dropEdge) return resetDrag();
    const sec = sections.find((s) => s.flows.some((f) => f.id === dropEdge.id));
    if (!sec) return resetDrag();
    const idx = sec.flows.findIndex((f) => f.id === dropEdge.id);
    const beforeFlowId = dropEdge.after ? (sec.flows[idx + 1]?.id ?? null) : dropEdge.id;
    moveFlow(dragId, sec.group?.id ?? null, beforeFlowId);
    resetDrag();
  };

  // Drop onto a group's empty area / header → append to that group.
  const dropOnGroup = (groupId: string | null) => {
    if (dragId) moveFlow(dragId, groupId, null);
    resetDrag();
  };

  const flowDnd = (flow: ResolvedFlow) => ({
    dragging: dragId === flow.id,
    dropBefore: dropEdge?.id === flow.id && !dropEdge.after && dragId !== flow.id,
    dropAfter: dropEdge?.id === flow.id && dropEdge.after && dragId !== flow.id,
    onDragStart: () => setDragId(flow.id),
    onDragEnd: resetDrag,
    onDragOver: (after: boolean) => {
      if (!dragId || dragId === flow.id) return;
      setDropGroup(null);
      setDropEdge((cur) => (cur && cur.id === flow.id && cur.after === after ? cur : { id: flow.id, after }));
    },
    onDrop: dropOnFlow,
  });

  if (config.flows.length === 0) {
    return (
      <div className={styles.p6TextCenter}>
        <WorkflowIcon size={32} />
        <Text as="p" className={styles.mt2}>
          No flows configured yet. Add one in <strong>Settings → Flows</strong> to monitor
          workflow runs on specific branches or triggered via workflow_dispatch — either a single
          workflow or every workflow matching a regex.
        </Text>
      </div>
    );
  }

  if (flows.length === 0 && resolving) {
    return (
      <div className={styles.p6TextCenter}>
        <Spinner />
        <Text as="p" className={styles.mt2}>Matching workflows against the configured regex…</Text>
      </div>
    );
  }

  // A regex that matches nothing (or a workflow list that failed to load) would
  // otherwise just show an empty board — say so instead.
  const patternIssues = [...patterns.entries()].flatMap(([id, st]) => {
    const flow = config.flows.find((f) => f.id === id);
    if (!flow || st.loading) return [];
    if (st.error) return [{ id, text: `Flow “${flow.name}”: ${st.error}` }];
    if (st.matches === 0)
      return [
        {
          id,
          text: `Flow “${flow.name}”: the regex /${flow.match.pattern}/ matches no workflow in the repo.`,
        },
      ];
    return [];
  });

  const totalVisible = sections.reduce((n, s) => n + s.flows.filter(isVisible).length, 0);
  const hiddenCount = flows.length - totalVisible;

  return (
    <div>
      <FlowsToolbar />

      <div className={styles.flexGap2}>
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
        <Button leadingVisual={DownloadIcon} size="small" onClick={() => {
            Telemetry.featureUsed(Feature.FLOW_BOARD_EXPORTED);
            setBoardOpen(true);
          }}>
          Export / Import
        </Button>
      </div>

      {patternIssues.length > 0 && (
        <Flash variant="warning" className={styles.mb3Body}>
          <ul className={styles.m0Pl3}>
            {patternIssues.map((issue) => (
              <li key={issue.id}>{issue.text}</li>
            ))}
          </ul>
        </Flash>
      )}

      {hiddenCount > 0 && (
        <Text className={styles.blockSmall}>
          {hiddenCount} {hiddenCount === 1 ? 'flow' : 'flows'} hidden by per-flow filter
          (configure in Settings → each flow's visibility filter).
        </Text>
      )}

      {sections.map((section) => {
        const group = section.group;
        const groupKey = group ? group.id : '';
        const visible = section.flows.filter(isVisible);
        // Hide an empty ungrouped section only when groups exist (avoid a stray
        // header) — unless it still holds places to clean up.
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
                <Heading as="h3" className={group ? styles.groupNameNamed : styles.groupName}>
                  {group ? group.name : 'Ungrouped'}
                </Heading>
                <Text className={styles.smallFgMuted}>· {visible.length}</Text>
                {/*
                  The latest run, not the flow's aggregate across all of them: the aggregate
                  puts failure first, so a flow that failed five runs ago read as red here
                  long after it had gone green — and the Overview, showing the same group,
                  said otherwise.
                */}
                <GroupStatusCounts
                  verdicts={visible.map((f) => groupVerdict(states.get(f.id)?.runs ?? []))}
                />
                {/* Cards the group still holds a place for: a deleted flow, or a
                    regex match the pattern no longer produces. The placement is
                    kept, so the card returns when the workflow does. */}
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
                visible.map((flow) => (
                  <FlowRunsGrid
                    key={flow.id}
                    flow={flow}
                    state={states.get(flow.id)}
                    highlight={highlightId === flow.id}
                    expanded={expandedId === flow.id}
                    onToggle={() => toggleExpand(flow.id)}
                    dnd={flowDnd(flow)}
                  />
                ))
              ) : (
                <div
                  className={styles.p3TextCenter}
                >
                  {group ? 'Drop flows here' : 'No ungrouped flows'}
                </div>
              ))}
          </div>
        );
      })}

      {boardOpen && <FlowBoardDialog onClose={() => setBoardOpen(false)} />}
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

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Heading,
  IconButton,
  Octicon,
  SegmentedControl,
  Select,
  Text,
  TextInput,
} from '@primer/react';
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
import { isFlowEmpty, latestRunJobs } from '../lib/flowEmptiness';
import {
  DEFAULT_FLOWS_FILTER,
  isJobFilterActive,
  useFlowsFilter,
  type JobStateFilter,
  type RunStatusFilter,
} from '../context/FlowsFilterContext';
import { useViewMode } from '../context/ViewModeContext';
import type { Flow, FlowGroup } from '../storage/configStore';
import { FlowRunsGrid } from './FlowRunsGrid';
import { FlowBoardDialog } from './FlowBoardDialog';
import { PromptDialog } from './PromptDialog';
import { GroupStatusCounts } from './GroupStatusCounts';

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
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, mb: 3, flexWrap: 'wrap' }}>
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

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Text sx={{ fontSize: 1, fontWeight: 'bold', whiteSpace: 'nowrap' }}>Job filter</Text>
        <TextInput
          leadingVisual={SearchIcon}
          value={filter.jobName}
          onChange={(e) => setFilter({ ...filter, jobName: e.target.value })}
          placeholder="job name contains…"
          aria-label="Job filter"
          sx={{ width: 200 }}
        />
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Text
          sx={{ fontSize: 1, fontWeight: 'bold', whiteSpace: 'nowrap', color: jobActive ? 'fg.default' : 'fg.muted' }}
        >
          Job is
        </Text>
        <Select
          value={filter.jobState}
          onChange={(e) => setFilter({ ...filter, jobState: e.target.value as JobStateFilter })}
          disabled={!jobActive}
          aria-label="Job is"
          sx={{ width: 200 }}
        >
          {JOB_STATES.map((s) => (
            <Select.Option key={s.value} value={s.value}>
              {s.label}
            </Select.Option>
          ))}
        </Select>
      </Box>

      {(jobActive || filter.runStatus !== 'all') && (
        <Button leadingVisual={XIcon} variant="invisible" onClick={() => setFilter(DEFAULT_FLOWS_FILTER)}>
          Clear
        </Button>
      )}

      {jobActive && (
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Loading jobs to evaluate the filter…</Text>
      )}
    </Box>
  );
}

export function FlowsView({ focusFlowId }: { focusFlowId?: string | null }) {
  const states = useFlowStates();
  const { config, sections, addGroup, renameGroup, deleteGroup, setCollapsed, moveFlow } =
    useFlowGroups();

  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Accordion: at most one flow expanded across all groups.
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    const saved = loadExpanded();
    return saved === null ? (config.flows[0]?.id ?? null) : saved || null;
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<{ id: string; after: boolean } | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null); // group id, '' = ungrouped
  const [boardOpen, setBoardOpen] = useState(false);
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

  const isVisible = (flow: Flow) => {
    const st = states.get(flow.id);
    return !isFlowEmpty(
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

  const flowDnd = (flow: Flow) => ({
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
      <Box sx={{ p: 6, textAlign: 'center', color: 'fg.muted' }}>
        <Octicon icon={WorkflowIcon} size={32} />
        <Text as="p" sx={{ mt: 2 }}>
          No flows configured yet. Add one in <strong>Settings → Flows</strong> to monitor
          workflow runs on specific branches or triggered via workflow_dispatch.
        </Text>
      </Box>
    );
  }

  const totalVisible = sections.reduce((n, s) => n + s.flows.filter(isVisible).length, 0);
  const hiddenCount = config.flows.length - totalVisible;

  return (
    <Box>
      <FlowsToolbar />

      <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <Button
          leadingVisual={PlusIcon}
          size="small"
          onClick={() => setGroupPrompt({ mode: 'create' })}
        >
          New group
        </Button>
        <Button leadingVisual={DownloadIcon} size="small" onClick={() => setBoardOpen(true)}>
          Export / Import
        </Button>
      </Box>

      {hiddenCount > 0 && (
        <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted', mb: 3 }}>
          {hiddenCount} empty {hiddenCount === 1 ? 'flow' : 'flows'} hidden by per-flow filter
          (configure in Settings → each flow's “Hide when empty”).
        </Text>
      )}

      {sections.map((section) => {
        const group = section.group;
        const groupKey = group ? group.id : '';
        const visible = section.flows.filter(isVisible);
        // Hide an empty ungrouped section only when groups exist (avoid a stray header).
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
            {/* With no groups at all, there's just one ungrouped list — skip the header. */}
            {(group || config.groups.length > 0) && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: collapsed ? 0 : 2 }}>
                <IconButton
                  size="small"
                  variant="invisible"
                  aria-label={collapsed ? 'Expand group' : 'Collapse group'}
                  icon={collapsed ? ChevronRightIcon : ChevronDownIcon}
                  onClick={() => group && setCollapsed(group.id, !collapsed)}
                  sx={{ visibility: group ? 'visible' : 'hidden' }}
                />
                <Heading as="h3" sx={{ fontSize: 1, color: group ? 'fg.default' : 'fg.muted' }}>
                  {group ? group.name : 'Ungrouped'}
                </Heading>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>· {visible.length}</Text>
                <GroupStatusCounts
                  statuses={visible.map((f) => states.get(f.id)?.overall ?? 'unknown')}
                />
                <Box sx={{ flex: 1 }} />
                {group && (
                  <>
                    <IconButton
                      size="small"
                      variant="invisible"
                      aria-label="Rename group"
                      icon={PencilIcon}
                      onClick={() => setGroupPrompt({ mode: 'rename', group })}
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
      })}

      {boardOpen && <FlowBoardDialog onClose={() => setBoardOpen(false)} />}
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
    </Box>
  );
}

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  FormControl,
  Octicon,
  SegmentedControl,
  Select,
  Text,
  TextInput,
} from '@primer/react';
import { SearchIcon, WorkflowIcon, XIcon } from '@primer/octicons-react';
import { useConfig } from '../context/ConfigContext';
import { useFlowStates } from '../context/FlowsRuntimeContext';
import { isFlowEmpty, latestRunJobs } from '../lib/flowEmptiness';
import {
  DEFAULT_FLOWS_FILTER,
  isJobFilterActive,
  useFlowsFilter,
  type JobStateFilter,
  type RunStatusFilter,
} from '../context/FlowsFilterContext';
import { useViewMode } from '../context/ViewModeContext';
import { FlowRunsGrid } from './FlowRunsGrid';

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

function FlowsToolbar() {
  const { filter, setFilter } = useFlowsFilter();
  const { compact, setCompact } = useViewMode();
  const jobActive = isJobFilterActive(filter);
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 3,
        mb: 3,
        flexWrap: 'wrap',
      }}
    >
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

      <FormControl sx={{ width: 200 }}>
        <FormControl.Label>Job filter</FormControl.Label>
        <TextInput
          leadingVisual={SearchIcon}
          value={filter.jobName}
          onChange={(e) => setFilter({ ...filter, jobName: e.target.value })}
          placeholder="job name contains…"
          block
        />
      </FormControl>

      <FormControl sx={{ width: 200 }} disabled={!jobActive}>
        <FormControl.Label>Job is</FormControl.Label>
        <Select
          value={filter.jobState}
          onChange={(e) => setFilter({ ...filter, jobState: e.target.value as JobStateFilter })}
          block
        >
          {JOB_STATES.map((s) => (
            <Select.Option key={s.value} value={s.value}>
              {s.label}
            </Select.Option>
          ))}
        </Select>
      </FormControl>

      {(jobActive || filter.runStatus !== 'all') && (
        <Button
          leadingVisual={XIcon}
          variant="invisible"
          onClick={() => setFilter(DEFAULT_FLOWS_FILTER)}
        >
          Clear
        </Button>
      )}

      {jobActive && (
        <Text sx={{ fontSize: 0, color: 'fg.muted', alignSelf: 'center' }}>
          Loading jobs to evaluate the filter…
        </Text>
      )}
    </Box>
  );
}

export function FlowsView({ focusFlowId }: { focusFlowId?: string | null }) {
  const { config } = useConfig();
  const states = useFlowStates();
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Scroll to + briefly highlight a flow when navigated here from the Overview.
  useEffect(() => {
    if (!focusFlowId) return;
    const el = document.getElementById(`flow-${focusFlowId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setHighlightId(focusFlowId);
    const t = setTimeout(() => setHighlightId(null), 2200);
    return () => clearTimeout(t);
  }, [focusFlowId]);

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

  const visibleFlows = config.flows.filter((flow) => {
    const state = states.get(flow.id);
    return !isFlowEmpty(
      {
        runs: state?.runs ?? [],
        latestArtifactBytes: state?.latestArtifactBytes ?? null,
        latestJobs: latestRunJobs(state?.runs ?? [], state?.jobsByRun ?? {}),
      },
      flow.emptyFilter,
    );
  });
  const hiddenCount = config.flows.length - visibleFlows.length;

  return (
    <Box>
      <FlowsToolbar />
      {hiddenCount > 0 && (
        <Text sx={{ display: 'block', fontSize: 0, color: 'fg.muted', mb: 3 }}>
          {hiddenCount} empty {hiddenCount === 1 ? 'flow' : 'flows'} hidden by per-flow filter
          (configure in Settings → each flow's “Hide when empty”).
        </Text>
      )}
      {visibleFlows.map((flow) => (
        <FlowRunsGrid
          key={flow.id}
          flow={flow}
          state={states.get(flow.id)}
          highlight={highlightId === flow.id}
        />
      ))}
      {visibleFlows.length === 0 && (
        <Box sx={{ p: 4, textAlign: 'center', color: 'fg.muted' }}>
          All flows are hidden by the empty-flow filter.
        </Box>
      )}
    </Box>
  );
}

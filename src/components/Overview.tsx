import { useMemo } from 'react';
import { Box, BranchName, Heading, Label, Octicon, Text } from '@primer/react';
import {
  CheckCircleFillIcon,
  ChevronRightIcon,
  GitPullRequestIcon,
  WorkflowIcon,
} from '@primer/octicons-react';
import { useConfig } from '../context/ConfigContext';
import { useDashboard } from '../context/DashboardContext';
import { useFlowStates } from '../context/FlowsRuntimeContext';
import type { OverallStatus, WorkflowRun } from '../api/types';
import { statusToOverall } from '../lib/status';
import { isFlowEmpty, latestRunJobs } from '../lib/flowEmptiness';
import { StatusBadge } from './StatusBadge';
import { formatRelative } from '../lib/format';

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

function Tile({
  status,
  onClick,
  children,
}: {
  status: OverallStatus;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Box
      as="button"
      type="button"
      onClick={onClick}
      sx={{
        appearance: 'none',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        bg: 'canvas.default',
        color: 'fg.default',
        border: '1px solid',
        borderColor: 'border.default',
        borderLeft: '4px solid',
        borderLeftColor: STATUS_BORDER[status],
        borderRadius: 2,
        p: 3,
        minHeight: 92,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        ':hover': { bg: 'canvas.subtle', borderColor: 'border.muted' },
      }}
    >
      {children}
    </Box>
  );
}

/** The most recent run of a flow (runs are sorted newest-first). */
function latestRun(runs: WorkflowRun[]): WorkflowRun | undefined {
  return runs[0];
}

export function Overview({
  onOpenFlow,
  onOpenPrs,
}: {
  onOpenFlow: (flowId: string) => void;
  onOpenPrs: () => void;
}) {
  const { config } = useConfig();
  const { prs } = useDashboard();
  const flowStates = useFlowStates();

  // Hide flows the configured empty-flow filter considers empty.
  const visibleFlows = useMemo(
    () =>
      config.flows.filter((f) => {
        const state = flowStates.get(f.id);
        return !isFlowEmpty(
          {
            runs: state?.runs ?? [],
            latestArtifactBytes: state?.latestArtifactBytes ?? null,
            latestJobs: latestRunJobs(state?.runs ?? [], state?.jobsByRun ?? {}),
          },
          f.emptyFilter,
        );
      }),
    [config.flows, flowStates],
  );

  const failingPrs = prs.filter((e) => e.overall === 'failure').length;
  const failingFlows = visibleFlows.filter((f) => {
    const run = latestRun(flowStates.get(f.id)?.runs ?? []);
    return run ? statusToOverall(run.status, run.conclusion) === 'failure' : false;
  }).length;
  const totalFailing = failingPrs + failingFlows;

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
      </Box>

      <Heading as="h3" sx={{ fontSize: 1, color: 'fg.muted', mb: 2 }}>
        <Octicon icon={GitPullRequestIcon} size={14} sx={{ mr: 1 }} />
        Pull requests
      </Heading>
      {prs.length === 0 ? (
        <Text sx={{ color: 'fg.muted' }}>No open pull requests.</Text>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 3,
            mb: 5,
          }}
        >
          {prs.map((entry) => (
            <Tile key={entry.pr.number} status={entry.overall} onClick={onOpenPrs}>
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

      <Heading as="h3" sx={{ fontSize: 1, color: 'fg.muted', mb: 2 }}>
        <Octicon icon={WorkflowIcon} size={14} sx={{ mr: 1 }} />
        Flows
      </Heading>
      {visibleFlows.length === 0 ? (
        <Text sx={{ color: 'fg.muted' }}>
          {config.flows.length === 0
            ? 'No flows configured — add one in Settings.'
            : 'All flows are hidden by the empty-flow filter.'}
        </Text>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 3,
          }}
        >
          {visibleFlows.map((flow) => {
            const state = flowStates.get(flow.id);
            const run = latestRun(state?.runs ?? []);
            const status = run ? statusToOverall(run.status, run.conclusion) : 'unknown';
            return (
              <Tile key={flow.id} status={status} onClick={() => onOpenFlow(flow.id)}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
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
                      <Text sx={{ fontSize: 0 }}>
                        {formatRelative(run.run_started_at ?? run.created_at)}
                      </Text>
                    </Box>
                  </>
                ) : (
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                    {state ? 'no runs yet' : 'loading…'}
                  </Text>
                )}
              </Tile>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

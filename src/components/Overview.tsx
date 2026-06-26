import { useMemo, useState, type ReactNode } from 'react';
import { Box, BranchName, Button, Heading, IconButton, Label, Octicon, Spinner, Text } from '@primer/react';
import {
  ChecklistIcon,
  CheckCircleFillIcon,
  ChevronRightIcon,
  GitPullRequestIcon,
  GraphIcon,
  LinkExternalIcon,
  SyncIcon,
  WorkflowIcon,
} from '@primer/octicons-react';
import { useConfig } from '../context/ConfigContext';
import { useDashboard } from '../context/DashboardContext';
import { useFlowStates } from '../context/FlowsRuntimeContext';
import type { OverallStatus, WorkflowRun } from '../api/types';
import type { PrEntry } from '../hooks/useGitHubDashboard';
import { statusToOverall } from '../lib/status';
import { isFlowEmpty, latestRunJobs } from '../lib/flowEmptiness';
import { StatusBadge } from './StatusBadge';
import { formatRelative } from '../lib/format';
import { OverallSummaryDialog, RunOverallSummaryDialog } from './OverallSummaryDialog';
import { FlowRunTimelineDialog, TimelineDialog, type GanttItem } from './TimelineDialog';

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

function Tile({
  status,
  onOpen,
  actions,
  children,
}: {
  status: OverallStatus;
  onOpen: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
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
  const { config } = useConfig();
  const { owner: upOwner, repo: upRepo } = config.upstream;
  const { prs, refreshAll, isFetchingList, isFetchingChecks } = useDashboard();
  const flowStates = useFlowStates();
  const [dlg, setDlg] = useState<Dlg | null>(null);

  const refreshEverything = () => {
    refreshAll();
    for (const s of flowStates.values()) s.refresh();
  };

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
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 3 }}>
          {visibleFlows.map((flow) => {
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
          })}
        </Box>
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

import { useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Box,
  BranchName,
  Button,
  Flash,
  IconButton,
  Link,
  Octicon,
  SegmentedControl,
  Spinner,
  StateLabel,
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
import { useDashboard } from '../context/DashboardContext';
import { useViewMode } from '../context/ViewModeContext';
import { useConfig } from '../context/ConfigContext';
import type { PrEntry } from '../hooks/useGitHubDashboard';
import type { OverallStatus } from '../api/types';
import { statusToOverall } from '../lib/status';
import { StatusBadge } from './StatusBadge';
import { CheckRunsTable } from './CheckRunsTable';
import { TimelineDialog, type GanttItem } from './TimelineDialog';
import { OverallSummaryDialog } from './OverallSummaryDialog';
import { ArtifactsButton } from './ArtifactsButton';
import { runIdFromUrl } from '../api/endpoints';
import { formatRelative } from '../lib/format';

export type PrFilter = 'all' | 'active' | 'failed' | 'success';
type Filter = PrFilter;

function inFilter(status: OverallStatus, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return status === 'in_progress' || status === 'pending' || status === 'unknown';
    case 'failed':
      return status === 'failure';
    case 'success':
      return status === 'success' || status === 'neutral';
  }
}

function PrRow({ entry }: { entry: PrEntry }) {
  const [open, setOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const { config } = useConfig();
  const { owner, repo } = config.upstream;
  const { pr, overall } = entry;
  // Artifacts are per-run; derive the PR's CI run id from its check-run URLs.
  // The Actions run id lives in `details_url` (.../actions/runs/{id}/job/{id});
  // `html_url` is the generic /runs/{check_run_id} page, so check it second.
  const runId = useMemo(
    () =>
      entry.checkRuns
        .map((c) => runIdFromUrl(c.details_url) ?? runIdFromUrl(c.html_url))
        .find((id) => id != null) ?? null,
    [entry.checkRuns],
  );
  const timelineItems: GanttItem[] = entry.checkRuns.map((c) => ({
    id: c.id,
    label: c.name,
    status: statusToOverall(c.status, c.conclusion),
    started_at: c.started_at,
    completed_at: c.completed_at,
  }));
  return (
    <Box sx={{ borderBottom: '1px solid', borderColor: 'border.default' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          px: 3,
          py: 2,
          cursor: 'pointer',
          ':hover': { bg: 'canvas.subtle' },
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <Octicon icon={open ? ChevronDownIcon : ChevronRightIcon} size={16} sx={{ color: 'fg.muted' }} />
        <Box sx={{ width: 150, flexShrink: 0 }}>
          <StatusBadge status={overall} />
        </Box>
        <StateLabel status={pr.draft ? 'draft' : 'pullOpened'} variant="small" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Link
            href={pr.html_url}
            target="_blank"
            rel="noreferrer"
            sx={{ fontWeight: 'bold', color: 'fg.default' }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {pr.title}
          </Link>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 1, color: 'fg.muted' }}>
            <Text sx={{ fontSize: 0 }}>#{pr.number}</Text>
            <BranchName as="span" sx={{ fontSize: 0 }}>{pr.head.ref}</BranchName>
            <Octicon icon={ChevronRightIcon} size={12} />
            <BranchName as="span" sx={{ fontSize: 0 }}>{pr.base.ref}</BranchName>
            <Text sx={{ fontSize: 0 }}>updated {formatRelative(pr.updated_at)}</Text>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          {pr.user && <Avatar src={pr.user.avatar_url} size={20} alt={pr.user.login} />}
          <IconButton
            size="small"
            variant="invisible"
            icon={ChecklistIcon}
            aria-label="PR checks summary"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              setSummaryOpen(true);
            }}
          />
          <IconButton
            size="small"
            variant="invisible"
            icon={GraphIcon}
            aria-label="PR check timeline"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              setTimelineOpen(true);
            }}
          />
          {runId != null && (
            <ArtifactsButton
              owner={owner}
              repo={repo}
              runId={runId}
              title="Artifacts"
              subtitle={`${pr.title} · #${pr.number}`}
              bundleName={`pr-${pr.number}-artifacts`}
            />
          )}
          <IconButton
            size="small"
            variant="invisible"
            icon={LinkExternalIcon}
            aria-label="Open PR on GitHub"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              window.open(pr.html_url, '_blank', 'noopener');
            }}
          />
        </Box>
      </Box>
      {timelineOpen && (
        <TimelineDialog
          title={pr.title}
          subtitle={`#${pr.number} · check timeline`}
          items={timelineItems}
          onClose={() => setTimelineOpen(false)}
        />
      )}
      {summaryOpen && (
        <OverallSummaryDialog
          title={pr.title}
          subtitle={`#${pr.number} · checks summary`}
          owner={owner}
          repo={repo}
          items={entry.checkRuns.map((c) => ({
            id: c.id,
            label: c.name,
            status: statusToOverall(c.status, c.conclusion),
            checkRunId: c.id,
          }))}
          htmlUrl={pr.html_url}
          onClose={() => setSummaryOpen(false)}
        />
      )}
      {open && (
        <Box sx={{ pl: 4, pr: 2, pb: 3, pt: 1, bg: 'canvas.subtle' }}>
          {entry.checksError && (
            <Flash variant="danger" sx={{ mb: 2, fontSize: 0 }}>{entry.checksError}</Flash>
          )}
          {entry.checksUpdatedAt === null ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted' }}>
              <Spinner size="small" /> <Text sx={{ fontSize: 0 }}>Loading checks…</Text>
            </Box>
          ) : (
            <CheckRunsTable checkRuns={entry.checkRuns} combined={entry.combined} owner={owner} repo={repo} />
          )}
        </Box>
      )}
    </Box>
  );
}

export function PrList({ initialFilter }: { initialFilter?: PrFilter } = {}) {
  const { prs, listError, listUpdatedAt, isFetchingList, isFetchingChecks, refreshAll } =
    useDashboard();
  const { compact, setCompact } = useViewMode();
  const [filter, setFilter] = useState<Filter>(initialFilter ?? 'all');

  // Apply a filter requested via Overview navigation.
  useEffect(() => {
    if (initialFilter) setFilter(initialFilter);
  }, [initialFilter]);

  const counts = useMemo(() => {
    const c = { all: prs.length, active: 0, failed: 0, success: 0 };
    for (const e of prs) {
      if (inFilter(e.overall, 'active')) c.active++;
      else if (inFilter(e.overall, 'failed')) c.failed++;
      else if (inFilter(e.overall, 'success')) c.success++;
    }
    return c;
  }, [prs]);

  const visible = prs.filter((e) => inFilter(e.overall, filter));
  const filters: Filter[] = ['all', 'active', 'failed', 'success'];
  const label: Record<Filter, string> = {
    all: 'All',
    active: 'Active',
    failed: 'Failed',
    success: 'Success',
  };

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
          flexWrap: 'wrap',
          gap: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          <SegmentedControl aria-label="Filter pull requests">
            {filters.map((f) => (
              <SegmentedControl.Button
                key={f}
                selected={filter === f}
                onClick={() => setFilter(f)}
              >
                {`${label[f]} (${counts[f]})`}
              </SegmentedControl.Button>
            ))}
          </SegmentedControl>
          <SegmentedControl aria-label="Check view density">
            <SegmentedControl.Button selected={!compact} onClick={() => setCompact(false)}>
              All checks
            </SegmentedControl.Button>
            <SegmentedControl.Button selected={compact} onClick={() => setCompact(true)}>
              Compact
            </SegmentedControl.Button>
          </SegmentedControl>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {listUpdatedAt && (
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
              updated {formatRelative(new Date(listUpdatedAt).toISOString())}
            </Text>
          )}
          {(isFetchingList || isFetchingChecks) && <Spinner size="small" />}
          <Button leadingVisual={SyncIcon} onClick={refreshAll} variant="default" size="small">
            Refresh
          </Button>
        </Box>
      </Box>

      {listError && (
        <Flash variant="danger" sx={{ mb: 3 }}>
          Failed to load pull requests: {listError.message}
        </Flash>
      )}

      <Box sx={{ borderRadius: 2, borderTop: '1px solid', borderColor: 'border.default' }}>
        {visible.length === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center', color: 'fg.muted' }}>
            {prs.length === 0 ? 'No open pull requests found for this fork.' : 'No PRs match this filter.'}
          </Box>
        ) : (
          visible.map((e) => <PrRow key={e.pr.number} entry={e} />)
        )}
      </Box>
    </Box>
  );
}

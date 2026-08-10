import { useEffect, useMemo, useState } from 'react';
import { Avatar, BranchName, Button, Flash, IconButton, Link, SegmentedControl, Spinner, StateLabel, Text } from '@primer/react';
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
import { AnalysedBadge } from './AnalysedBadge';
import { AutoRerunLabel } from './AutoRerunLabel';
import { AutoMergeButton, AutoMergeLabel } from './AutoMergeButton';
import { StatusBadge } from './StatusBadge';
import { CheckRunsTable } from './CheckRunsTable';
import { TimelineDialog, type GanttItem } from './TimelineDialog';
import { OverallSummaryDialog } from './OverallSummaryDialog';
import { ArtifactsButton } from './ArtifactsButton';
import { RerunFailedJobsButton } from './RerunFailedJobsButton';
import { runIdFromUrl } from '../api/endpoints';
import { formatRelative } from '../lib/format';
import styles from './PrList.module.css';
import { Icon } from './Icon';
import { Feature, Telemetry } from '../lib/telemetry';

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

function PrRow({ entry, focused }: { entry: PrEntry; focused?: boolean }) {
  const [open, setOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const { config } = useConfig();
  const { invalidateChecks, refreshAll } = useDashboard();
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
  /**
   * Open and highlight the row that was navigated to.
   *
   * The Feature branches tab can send you here for one pull request, and a list of a dozen
   * with nothing marked would leave you to find it by number. Mirrors how a flow behaves
   * when the Overview jumps to it.
   */
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);

  return (
    <div
      id={`pr-${pr.number}`}
      className={focused ? styles.prRowFocused : styles.prRow}
    >
      <div
        className={styles.prHeader}
        onClick={() =>
          setOpen((v) => {
            // Only the opening counts. A close is the same click and would double every number.
            if (!v) Telemetry.featureUsed(Feature.PR_CHECKS_EXPANDED);
            return !v;
          })
        }
      >
        <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size={16} className={styles.fgMuted} />
        <div className={styles.width}>
          <StatusBadge status={overall} />
        </div>
        <StateLabel status={pr.draft ? 'draft' : 'pullOpened'} variant="small" />
        <AnalysedBadge kind="pr" id={pr.number} />
        <AutoMergeLabel pr={pr} />
        <AutoRerunLabel prNumber={pr.number} />
        <div className={styles.grow}>
          <Link
            href={pr.html_url}
            target="_blank"
            rel="noreferrer"
            className={styles.boldFgDefault}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {pr.title}
          </Link>
          <div className={styles.flexCenter}>
            <Text className={styles.small}>#{pr.number}</Text>
            <BranchName as="span" className={styles.small}>{pr.head.ref}</BranchName>
            <ChevronRightIcon size={12} />
            <BranchName as="span" className={styles.small}>{pr.base.ref}</BranchName>
            <Text className={styles.small}>updated {formatRelative(pr.updated_at)}</Text>
          </div>
        </div>
        <div className={styles.flexCenter2}>
          {pr.user && <Avatar src={pr.user.avatar_url} size={20} alt={pr.user.login} />}
          <IconButton
            size="small"
            variant="invisible"
            icon={ChecklistIcon}
            aria-label="PR checks summary"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              Telemetry.featureUsed(Feature.LOGS_OVERALL_SUMMARY_OPENED);
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
              Telemetry.featureUsed(Feature.LOGS_TIMELINE_OPENED);
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
          <RerunFailedJobsButton
            owner={owner}
            repo={repo}
            headSha={pr.head.sha}
            subtitle={`${pr.title} · #${pr.number}`}
            onRerun={() => invalidateChecks(pr.number)}
          />
          {/* refreshAll, not invalidateChecks: arming changes the PR itself (auto_merge
              and the body), and only a re-read of the PR list shows that. */}
          <AutoMergeButton owner={owner} repo={repo} pr={pr} onArmed={refreshAll} />
          <IconButton
            size="small"
            variant="invisible"
            icon={LinkExternalIcon}
            aria-label="Open PR on GitHub"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              Telemetry.featureUsed(Feature.PR_OPENED_EXTERNAL);
              window.open(pr.html_url, '_blank', 'noopener');
            }}
          />
        </div>
      </div>
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
        <div className={styles.pl4Pr2}>
          {entry.checksError && (
            <Flash variant="danger" className={styles.mb2Small}>{entry.checksError}</Flash>
          )}
          {entry.checksUpdatedAt === null ? (
            <div className={styles.flexCenter3}>
              <Spinner size="small" /> <Text className={styles.small}>Loading checks…</Text>
            </div>
          ) : (
            <CheckRunsTable checkRuns={entry.checkRuns} combined={entry.combined} owner={owner} repo={repo} />
          )}
        </div>
      )}
    </div>
  );
}

export function PrList({
  initialFilter,
  focusPrNumber,
}: { initialFilter?: PrFilter; focusPrNumber?: number | null } = {}) {
  const { prs, listError, listUpdatedAt, isFetchingList, isFetchingChecks, refreshAll } =
    useDashboard();
  const { compact, setCompact } = useViewMode();
  const [filter, setFilter] = useState<Filter>(initialFilter ?? 'all');

  // Apply a filter requested via Overview navigation.
  useEffect(() => {
    if (initialFilter) setFilter(initialFilter);
  }, [initialFilter]);

  /**
   * Arriving for one particular pull request.
   *
   * The filter is cleared to `all` first: the request came from somewhere that knows the
   * pull request exists, and landing on a filtered list that happens to exclude it would
   * look like it had vanished. Scrolling waits a frame, since the row it targets is only
   * rendered once that filter change has been applied.
   */
  useEffect(() => {
    if (focusPrNumber == null) return;
    setFilter('all');
    const id = requestAnimationFrame(() => {
      document.getElementById(`pr-${focusPrNumber}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
    return () => cancelAnimationFrame(id);
  }, [focusPrNumber]);

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
    <div>
      <div
        className={styles.flexCenter4}
      >
        <div className={styles.flexCenter5}>
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
        </div>
        <div className={styles.flexCenter6}>
          {listUpdatedAt && (
            <Text className={styles.smallFgMuted}>
              updated {formatRelative(new Date(listUpdatedAt).toISOString())}
            </Text>
          )}
          {(isFetchingList || isFetchingChecks) && <Spinner size="small" />}
          <Button leadingVisual={SyncIcon} onClick={refreshAll} variant="default" size="small">
            Refresh
          </Button>
        </div>
      </div>

      {listError && (
        <Flash variant="danger" className={styles.mb3}>
          Failed to load pull requests: {listError.message}
        </Flash>
      )}

      <div className={styles.rounded}>
        {visible.length === 0 ? (
          <div className={styles.p4TextCenter}>
            {prs.length === 0 ? 'No open pull requests found for this fork.' : 'No PRs match this filter.'}
          </div>
        ) : (
          visible.map((e) => (
            <PrRow key={e.pr.number} entry={e} focused={e.pr.number === focusPrNumber} />
          ))
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { IconButton, Text } from '@primer/react';
import { InfoIcon, LinkExternalIcon, TerminalIcon } from '@primer/octicons-react';
import type { CheckRun, CombinedStatus, OverallStatus } from '../api/types';
import { statusToOverall } from '../lib/status';
import { jobIdFromUrl } from '../api/endpoints';
import { isQuietStatus, useViewMode } from '../context/ViewModeContext';
import { StatusBadge } from './StatusBadge';
import { CheckRunDialog } from './CheckRunDialog';
import { AnalyseFailureButton } from './AnalyseFailureButton';
import { formatDuration, formatRelative } from '../lib/format';
import styles from './CheckRunsTable.module.css';
import { Feature, Telemetry } from '../lib/telemetry';

interface Row {
  key: string;
  overall: OverallStatus;
  name: string;
  context: string | null;
  duration: string;
  started: string;
  url: string | null;
  /** Actions job id (when this check-run maps to a job) — enables Summary/Logs. */
  jobId: number | null;
  /** The check-run itself, which is how a pull request's failures are keyed. */
  checkRunId: number | null;
}

function toRows(checkRuns: CheckRun[], combined: CombinedStatus | null): Row[] {
  const rows: Row[] = checkRuns.map((c) => ({
    key: `cr-${c.id}`,
    overall: statusToOverall(c.status, c.conclusion),
    name: c.name,
    context: c.app?.name ?? null,
    duration: formatDuration(c.started_at, c.completed_at),
    started: formatRelative(c.started_at),
    url: c.html_url ?? c.details_url,
    jobId: jobIdFromUrl(c.details_url ?? c.html_url),
    checkRunId: c.id,
  }));
  if (combined) {
    for (const s of combined.statuses) {
      rows.push({
        key: `st-${s.id}`,
        overall: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure',
        name: s.context,
        context: s.description,
        duration: formatDuration(s.created_at, s.updated_at),
        started: formatRelative(s.created_at),
        url: s.target_url,
        jobId: null,
        // A commit status is not a check run and has no job, so it never reaches the
        // Failures tab and gets no jump.
        checkRunId: null,
      });
    }
  }
  return rows;
}

type OpenDialog = { jobId: number; kind: 'summary' | 'logs' } | null;

export function CheckRunsTable({
  checkRuns,
  combined,
  owner,
  repo,
}: {
  checkRuns: CheckRun[];
  combined: CombinedStatus | null;
  owner: string;
  repo: string;
}) {
  const { compact } = useViewMode();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const allRows = toRows(checkRuns, combined);
  const rows = compact ? allRows.filter((r) => !isQuietStatus(r.overall)) : allRows;
  const hidden = allRows.length - rows.length;

  if (allRows.length === 0) {
    return (
      <Text className={styles.smallFgMuted}>No checks reported for this commit.</Text>
    );
  }
  if (rows.length === 0) {
    return (
      <Text className={styles.smallFgMuted}>
        All {allRows.length} checks passed — nothing to show in compact view.
      </Text>
    );
  }
  return (
    <>
      {hidden > 0 && (
        <Text className={styles.smallFgMuted2}>
          {hidden} passed/skipped hidden (Compact)
        </Text>
      )}
      <table className={styles.width}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className={styles.px2Small}>
                <StatusBadge status={r.overall} />
              </td>
              <td className={styles.px2Small2}>
                <Text className={styles.bold}>{r.name}</Text>
                {r.context && <Text className={styles.fgMutedMl2}>{r.context}</Text>}
              </td>
              <td className={styles.px2Small3}>
                {r.duration}
              </td>
              <td className={styles.px2Small3}>
                {r.started}
              </td>
              <td className={styles.px2Small4}>
                <AnalyseFailureButton checkRunId={r.checkRunId} jobId={r.jobId} />
                {r.jobId != null && (
                  <>
                    <IconButton
                      size="small"
                      variant="invisible"
                      icon={InfoIcon}
                      aria-label="Check summary"
                      onClick={() => {
                        Telemetry.featureUsed(Feature.PR_CHECK_RUN_DIALOG);
                        Telemetry.featureUsed(Feature.LOGS_JOB_SUMMARY_OPENED);
                        setDialog({ jobId: r.jobId as number, kind: 'summary' });
                      }}
                      className={styles.mr1}
                    />
                    <IconButton
                      size="small"
                      variant="invisible"
                      icon={TerminalIcon}
                      aria-label="Check logs"
                      onClick={() => {
                        Telemetry.featureUsed(Feature.PR_CHECK_RUN_DIALOG);
                        Telemetry.featureUsed(Feature.LOGS_JOB_OPENED);
                        setDialog({ jobId: r.jobId as number, kind: 'logs' });
                      }}
                      className={styles.mr1}
                    />
                  </>
                )}
                {r.url && (
                  <IconButton
                    size="small"
                    variant="invisible"
                    icon={LinkExternalIcon}
                    aria-label="Open on GitHub"
                    onClick={() => {
                      Telemetry.featureUsed(Feature.PR_OPENED_EXTERNAL);
                      window.open(r.url as string, '_blank', 'noopener');
                    }}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {dialog && (
        <CheckRunDialog
          owner={owner}
          repo={repo}
          jobId={dialog.jobId}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

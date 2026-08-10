import { useState } from 'react';
import { Flash, IconButton, Spinner, Text } from '@primer/react';
import { InfoIcon, LinkExternalIcon, TerminalIcon } from '@primer/octicons-react';
import type { Job } from '../api/types';
import type { JobsCacheEntry } from '../hooks/useFlows';
import { statusToOverall } from '../lib/status';
import { isQuietStatus, useViewMode } from '../context/ViewModeContext';
import { StatusBadge } from './StatusBadge';
import { JobSummaryDialog } from './JobSummaryDialog';
import { JobLogsDialog } from './JobLogsDialog';
import { ShowInFailuresButton } from './ShowInFailuresButton';
import { formatDuration, formatRelative } from '../lib/format';
import styles from './JobsTable.module.css';
import { Feature, Telemetry } from '../lib/telemetry';

type OpenDialog = { job: Job; kind: 'summary' | 'logs' } | null;

export function JobsTable({
  entry,
  owner,
  repo,
}: {
  entry: JobsCacheEntry | undefined;
  owner: string;
  repo: string;
}) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const { compact } = useViewMode();

  if (!entry || (entry.loading && entry.jobs.length === 0)) {
    return (
      <div className={styles.flexCenter}>
        <Spinner size="small" /> <Text className={styles.small}>Loading jobs…</Text>
      </div>
    );
  }
  if (entry.error && entry.jobs.length === 0) {
    return (
      <Flash variant="danger" className={styles.m2Small}>
        Failed to load jobs: {entry.error}
      </Flash>
    );
  }
  if (entry.jobs.length === 0) {
    return <Text className={styles.smallFgMuted}>No jobs for this run.</Text>;
  }

  const jobs = compact
    ? entry.jobs.filter((j) => !isQuietStatus(statusToOverall(j.status, j.conclusion)))
    : entry.jobs;
  const hidden = entry.jobs.length - jobs.length;

  return (
    <>
      {hidden > 0 && (
        <Text className={styles.smallFgMuted2}>
          {hidden} passed/skipped {hidden === 1 ? 'job' : 'jobs'} hidden (Compact)
        </Text>
      )}
      {jobs.length === 0 ? (
        <Text className={styles.smallFgMuted}>
          All {entry.jobs.length} jobs passed — nothing to show in compact view.
        </Text>
      ) : (
      <table className={styles.width}>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td className={styles.px2Small}>
                <StatusBadge status={statusToOverall(job.status, job.conclusion)} />
              </td>
              <td className={styles.px2Small2}>
                <Text className={styles.bold}>{job.name}</Text>
                {job.steps.length > 0 && (
                  <Text className={styles.fgMutedMl2}>{job.steps.length} steps</Text>
                )}
              </td>
              <td className={styles.px2Small3}>
                {formatDuration(job.started_at, job.completed_at)}
              </td>
              <td className={styles.px2Small3}>
                {formatRelative(job.started_at)}
              </td>
              <td className={styles.px2Small4}>
                <ShowInFailuresButton jobId={job.id} />
                <IconButton
                  size="small"
                  variant="invisible"
                  icon={InfoIcon}
                  aria-label="Job summary"
                  onClick={() => {
                    Telemetry.featureUsed(Feature.LOGS_JOB_SUMMARY_OPENED);
                    setDialog({ job, kind: 'summary' });
                  }}
                  className={styles.mr1}
                />
                <IconButton
                  size="small"
                  variant="invisible"
                  icon={TerminalIcon}
                  aria-label="Job logs"
                  onClick={() => {
                    Telemetry.featureUsed(Feature.LOGS_JOB_OPENED);
                    setDialog({ job, kind: 'logs' });
                  }}
                  className={styles.mr1}
                />
                <IconButton
                  size="small"
                  variant="invisible"
                  icon={LinkExternalIcon}
                  aria-label="Open job on GitHub"
                  disabled={!job.html_url}
                  onClick={() => job.html_url && window.open(job.html_url, '_blank', 'noopener')}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}

      {dialog?.kind === 'summary' && (
        <JobSummaryDialog owner={owner} repo={repo} job={dialog.job} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'logs' && (
        <JobLogsDialog owner={owner} repo={repo} job={dialog.job} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

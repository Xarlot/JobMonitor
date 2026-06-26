import { useState } from 'react';
import { Box, Flash, IconButton, Spinner, Text } from '@primer/react';
import { InfoIcon, LinkExternalIcon, TerminalIcon } from '@primer/octicons-react';
import type { Job } from '../api/types';
import type { JobsCacheEntry } from '../hooks/useFlows';
import { statusToOverall } from '../lib/status';
import { isQuietStatus, useViewMode } from '../context/ViewModeContext';
import { StatusBadge } from './StatusBadge';
import { JobSummaryDialog } from './JobSummaryDialog';
import { JobLogsDialog } from './JobLogsDialog';
import { formatDuration, formatRelative } from '../lib/format';

const cellSx = {
  px: 2,
  py: '6px',
  borderColor: 'border.muted',
  borderBottomWidth: 1,
  borderBottomStyle: 'solid',
  fontSize: 0,
  verticalAlign: 'middle',
} as const;

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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'fg.muted', p: 2 }}>
        <Spinner size="small" /> <Text sx={{ fontSize: 0 }}>Loading jobs…</Text>
      </Box>
    );
  }
  if (entry.error && entry.jobs.length === 0) {
    return (
      <Flash variant="danger" sx={{ m: 2, fontSize: 0 }}>
        Failed to load jobs: {entry.error}
      </Flash>
    );
  }
  if (entry.jobs.length === 0) {
    return <Text sx={{ fontSize: 0, color: 'fg.muted', p: 2 }}>No jobs for this run.</Text>;
  }

  const jobs = compact
    ? entry.jobs.filter((j) => !isQuietStatus(statusToOverall(j.status, j.conclusion)))
    : entry.jobs;
  const hidden = entry.jobs.length - jobs.length;

  return (
    <>
      {hidden > 0 && (
        <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1, px: 2 }}>
          {hidden} passed/skipped {hidden === 1 ? 'job' : 'jobs'} hidden (Compact)
        </Text>
      )}
      {jobs.length === 0 ? (
        <Text sx={{ fontSize: 0, color: 'fg.muted', p: 2 }}>
          All {entry.jobs.length} jobs passed — nothing to show in compact view.
        </Text>
      ) : (
      <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
        <Box as="tbody">
          {jobs.map((job) => (
            <Box as="tr" key={job.id}>
              <Box as="td" sx={{ ...cellSx, width: '160px' }}>
                <StatusBadge status={statusToOverall(job.status, job.conclusion)} />
              </Box>
              <Box as="td" sx={cellSx}>
                <Text sx={{ fontWeight: 'bold' }}>{job.name}</Text>
                {job.steps.length > 0 && (
                  <Text sx={{ color: 'fg.muted', ml: 2 }}>{job.steps.length} steps</Text>
                )}
              </Box>
              <Box as="td" sx={{ ...cellSx, color: 'fg.muted', whiteSpace: 'nowrap' }}>
                {formatDuration(job.started_at, job.completed_at)}
              </Box>
              <Box as="td" sx={{ ...cellSx, color: 'fg.muted', whiteSpace: 'nowrap' }}>
                {formatRelative(job.started_at)}
              </Box>
              <Box as="td" sx={{ ...cellSx, textAlign: 'right', whiteSpace: 'nowrap' }}>
                <IconButton
                  size="small"
                  variant="invisible"
                  icon={InfoIcon}
                  aria-label="Job summary"
                  onClick={() => setDialog({ job, kind: 'summary' })}
                  sx={{ mr: 1 }}
                />
                <IconButton
                  size="small"
                  variant="invisible"
                  icon={TerminalIcon}
                  aria-label="Job logs"
                  onClick={() => setDialog({ job, kind: 'logs' })}
                  sx={{ mr: 1 }}
                />
                <IconButton
                  size="small"
                  variant="invisible"
                  icon={LinkExternalIcon}
                  aria-label="Open job on GitHub"
                  disabled={!job.html_url}
                  onClick={() => job.html_url && window.open(job.html_url, '_blank', 'noopener')}
                />
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
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

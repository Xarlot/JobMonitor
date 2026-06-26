import { Box, Flash, Link, Octicon, Spinner, Text } from '@primer/react';
import { LinkExternalIcon } from '@primer/octicons-react';
import type { JobsCacheEntry } from '../hooks/useFlows';
import { statusToOverall } from '../lib/status';
import { StatusBadge } from './StatusBadge';
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

export function JobsTable({ entry }: { entry: JobsCacheEntry | undefined }) {
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
  return (
    <Box as="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
      <Box as="tbody">
        {entry.jobs.map((job) => (
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
            <Box as="td" sx={{ ...cellSx, textAlign: 'right' }}>
              {job.html_url && (
                <Link href={job.html_url} target="_blank" rel="noreferrer" muted>
                  <Octicon icon={LinkExternalIcon} size={14} />
                </Link>
              )}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

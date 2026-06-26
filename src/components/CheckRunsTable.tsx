import { Box, Link, Octicon, Text } from '@primer/react';
import { LinkExternalIcon } from '@primer/octicons-react';
import type { CheckRun, CombinedStatus, OverallStatus } from '../api/types';
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

interface Row {
  key: string;
  overall: OverallStatus;
  name: string;
  context: string | null;
  duration: string;
  started: string;
  url: string | null;
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
      });
    }
  }
  return rows;
}

export function CheckRunsTable({
  checkRuns,
  combined,
}: {
  checkRuns: CheckRun[];
  combined: CombinedStatus | null;
}) {
  const rows = toRows(checkRuns, combined);
  if (rows.length === 0) {
    return (
      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>No checks reported for this commit.</Text>
    );
  }
  return (
    <Box
      as="table"
      sx={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}
    >
      <Box as="tbody">
        {rows.map((r) => (
          <Box as="tr" key={r.key}>
            <Box as="td" sx={{ ...cellSx, width: '160px' }}>
              <StatusBadge status={r.overall} />
            </Box>
            <Box as="td" sx={cellSx}>
              <Text sx={{ fontWeight: 'bold' }}>{r.name}</Text>
              {r.context && (
                <Text sx={{ color: 'fg.muted', ml: 2 }}>{r.context}</Text>
              )}
            </Box>
            <Box as="td" sx={{ ...cellSx, color: 'fg.muted', whiteSpace: 'nowrap' }}>
              {r.duration}
            </Box>
            <Box as="td" sx={{ ...cellSx, color: 'fg.muted', whiteSpace: 'nowrap' }}>
              {r.started}
            </Box>
            <Box as="td" sx={{ ...cellSx, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {r.url && (
                <Link href={r.url} target="_blank" rel="noreferrer" muted>
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

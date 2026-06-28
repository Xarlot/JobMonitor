import { Box, Octicon, Text } from '@primer/react';
import { CheckCircleFillIcon, DotFillIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { OverallStatus } from '../api/types';

/**
 * Compact tally of flow statuses for a group header — failed / in-progress /
 * passed — so a collapsed group still shows what's inside at a glance.
 */
export function GroupStatusCounts({ statuses }: { statuses: OverallStatus[] }) {
  let passed = 0;
  let failed = 0;
  let running = 0;
  for (const s of statuses) {
    if (s === 'success') passed++;
    else if (s === 'failure') failed++;
    else if (s === 'in_progress' || s === 'pending') running++;
  }
  if (passed === 0 && failed === 0 && running === 0) return null;

  const item = (icon: typeof CheckCircleFillIcon, color: string, count: number, label: string) =>
    count > 0 ? (
      <Box
        as="span"
        title={`${count} ${label}`}
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, color }}
      >
        <Octicon icon={icon} size={12} />
        <Text sx={{ fontSize: 0 }}>{count}</Text>
      </Box>
    ) : null;

  return (
    <Box as="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {item(CheckCircleFillIcon, 'success.fg', passed, 'passed')}
      {item(DotFillIcon, 'attention.fg', running, 'in progress')}
      {item(XCircleFillIcon, 'danger.fg', failed, 'failed')}
    </Box>
  );
}

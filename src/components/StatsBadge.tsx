import { Label, Octicon, Tooltip } from '@primer/react';
import { PulseIcon } from '@primer/octicons-react';
import { useRequestStats } from '../hooks/useRequestStats';
import { useRateLimit } from '../hooks/useRateLimit';

/**
 * Requests made in the last hour (sliding window) against the hourly limit.
 * Tooltip breaks down fresh / cached(304) / error and shows GitHub's remaining.
 */
export function StatsBadge() {
  const s = useRequestStats();
  const { limit, remaining } = useRateLimit();

  const label = limit != null ? `${s.total} / ${limit}/h` : `${s.total}/h`;
  const ratio = limit ? s.total / limit : 0;
  const variant = ratio >= 0.9 ? 'danger' : ratio >= 0.6 ? 'attention' : 'secondary';

  const tip =
    `Last hour: ${s.fresh} fresh · ${s.cached} cached (304) · ${s.error} errors` +
    (limit != null ? ` · GitHub limit ${limit}/h` : '') +
    (remaining != null ? ` · ${remaining} remaining` : '');

  return (
    <Tooltip aria-label={tip}>
      <Label variant={variant}>
        <Octicon icon={PulseIcon} size={14} sx={{ mr: 1 }} />
        {label}
      </Label>
    </Tooltip>
  );
}

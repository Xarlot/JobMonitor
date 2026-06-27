import { Box, Label, Octicon } from '@primer/react';
import { Tooltip } from '@primer/react/next';
import { PulseIcon } from '@primer/octicons-react';
import { useRequestStats } from '../hooks/useRequestStats';
import { useRateLimit } from '../hooks/useRateLimit';

/**
 * Requests made in the last hour (sliding window). The headline counts only
 * quota-costing requests against the hourly limit; cached 304s (free) are shown
 * alongside. The tooltip explains each figure.
 */
export function StatsBadge() {
  const s = useRequestStats();
  const { limit, remaining } = useRateLimit();

  // 304 (cached) responses do NOT count against GitHub's rate limit, so only
  // non-304 requests are counted against the limit in the headline.
  const counted = s.total - s.cached;
  const headline = limit != null ? `${counted} / ${limit}/h` : `${counted}/h`;
  const label = `${headline} · ${s.cached} cached`;
  const ratio = limit ? counted / limit : 0;
  const variant = ratio >= 0.9 ? 'danger' : ratio >= 0.6 ? 'attention' : 'secondary';

  const tip = [
    'GitHub API requests · last hour (sliding window)',
    `${counted} counted — use GitHub quota`,
    `${s.cached} cached (304) — free, not charged`,
    `${s.fresh} fresh · ${s.error} errors · ${s.total} total`,
    limit != null
      ? `GitHub’s window: ${remaining != null ? `${remaining} of ` : ''}${limit}/h left`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    // TooltipV2 requires an interactive trigger; wrap the badge in a bare,
    // action-less button so it's focusable (tooltip on hover AND keyboard) and
    // the popover renders in the top layer (never clipped by the header).
    // TooltipV2 hardcodes centered/nowrap-collapsing text with a 250px cap;
    // override it via a higher-specificity nested selector (class + [role]) so
    // the multi-line breakdown reads left-aligned with real line breaks.
    <Box
      sx={{
        display: 'inline-flex',
        '& [role="tooltip"]': {
          textAlign: 'left',
          whiteSpace: 'pre-line',
          maxWidth: 340,
          lineHeight: 1.5,
          padding: '8px 10px',
        },
      }}
    >
      <Tooltip text={tip} type="description">
        <Box
          as="button"
          type="button"
          sx={{ all: 'unset', display: 'inline-flex', alignItems: 'center', cursor: 'default' }}
        >
          <Label variant={variant}>
            <Octicon icon={PulseIcon} size={14} sx={{ mr: 1 }} />
            {label}
          </Label>
        </Box>
      </Tooltip>
    </Box>
  );
}

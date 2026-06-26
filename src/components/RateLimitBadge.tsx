import { useEffect, useState } from 'react';
import { Box, Label, Octicon, Text, Tooltip } from '@primer/react';
import { AlertIcon, ClockIcon, GraphIcon } from '@primer/octicons-react';
import { useRateLimit } from '../hooks/useRateLimit';
import { isLow, isThrottled, throttledUntil } from '../api/rateLimit';
import { useConfig } from '../context/ConfigContext';
import { formatCountdown } from '../lib/format';

/** Shows remaining/limit + reset countdown; warns when low or throttled. */
export function RateLimitBadge() {
  const info = useRateLimit();
  const { config } = useConfig();
  const [now, setNow] = useState(() => Date.now());

  // Tick once per second so the countdown stays live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (info.remaining == null) {
    return (
      <Label variant="secondary">
        <Octicon icon={GraphIcon} size={14} sx={{ mr: 1 }} />
        rate limit: —
      </Label>
    );
  }

  const throttled = isThrottled(info, now);
  const low = isLow(info, config.rateLimitWarnAt);
  const until = throttledUntil(info, now);
  const resetSecs = until != null ? Math.round(until / 1000) : info.reset;

  const variant = throttled ? 'danger' : low ? 'attention' : 'success';
  const icon = throttled || low ? AlertIcon : GraphIcon;

  return (
    <Tooltip
      aria-label={
        throttled
          ? `Throttled — requests resume in ${formatCountdown(resetSecs, now)}`
          : `${info.remaining}/${info.limit} core requests remaining; resets in ${formatCountdown(info.reset, now)}`
      }
    >
      <Label variant={variant}>
        <Octicon icon={icon} size={14} sx={{ mr: 1 }} />
        <Box as="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
          <Text sx={{ fontWeight: 'bold' }}>{info.remaining}</Text>
          <Text sx={{ opacity: 0.8 }}>/ {info.limit ?? '—'}</Text>
          {(throttled || low) && (
            <Text sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, ml: 1 }}>
              <Octicon icon={ClockIcon} size={12} />
              {formatCountdown(resetSecs, now)}
            </Text>
          )}
        </Box>
      </Label>
    </Tooltip>
  );
}

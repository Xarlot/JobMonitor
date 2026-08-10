import { useEffect, useState } from 'react';
import { Label, Text, Tooltip } from '@primer/react';
import { AlertIcon, ClockIcon, GraphIcon } from '@primer/octicons-react';
import { useRateLimit } from '../hooks/useRateLimit';
import { isLow, isThrottled, throttledUntil } from '../api/rateLimit';
import { useConfig } from '../context/ConfigContext';
import { formatCountdown } from '../lib/format';
import styles from './RateLimitBadge.module.css';
import { Icon } from './Icon';

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
        <GraphIcon size={14} className={styles.mr1} />
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
      type="description"
      text={
        throttled
          ? `Throttled — requests resume in ${formatCountdown(resetSecs, now)}`
          : `${info.remaining}/${info.limit} core requests remaining; resets in ${formatCountdown(info.reset, now)}`
      }
    >
      <button type="button" className={styles.trigger}>
        <Label variant={variant}>
        <Icon icon={icon} size={14} className={styles.mr1} />
        <span className={styles.centerGap1}>
          <Text className={styles.bold}>{info.remaining}</Text>
          <Text className={styles.opacity}>/ {info.limit ?? '—'}</Text>
          {(throttled || low) && (
            <Text className={styles.centerGap1_2}>
              <ClockIcon size={12} />
              {formatCountdown(resetSecs, now)}
            </Text>
          )}
        </span>
      </Label>
      </button>
    </Tooltip>
  );
}

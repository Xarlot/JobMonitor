import { Spinner, Text } from '@primer/react';
import {
  CheckCircleFillIcon,
  ClockIcon,
  DotFillIcon,
  SkipIcon,
  XCircleFillIcon,
} from '@primer/octicons-react';
import type { OverallStatus } from '../api/types';
import { STATUS_LABEL } from '../lib/status';
import { Icon } from './Icon';
import styles from './StatusBadge.module.css';

interface BadgeStyle {
  icon: typeof CheckCircleFillIcon | null;
  color: string;
  spinner?: boolean;
}

const STYLES: Record<OverallStatus, BadgeStyle> = {
  success: { icon: CheckCircleFillIcon, color: 'var(--fgColor-success)' },
  failure: { icon: XCircleFillIcon, color: 'var(--fgColor-danger)' },
  pending: { icon: ClockIcon, color: 'var(--fgColor-attention)' },
  in_progress: { icon: null, color: 'var(--fgColor-attention)', spinner: true },
  neutral: { icon: SkipIcon, color: 'var(--fgColor-muted)' },
  unknown: { icon: DotFillIcon, color: 'var(--fgColor-muted)' },
};

interface StatusBadgeProps {
  status: OverallStatus;
  /** Render the textual label next to the icon. */
  withText?: boolean;
  size?: number;
}

/** GitHub-style status indicator: colored octicon (or spinner) + optional label. */
export function StatusBadge({ status, withText = true, size = 16 }: StatusBadgeProps) {
  const style = STYLES[status];
  return (
    <div className={styles.badge} style={{ color: style.color }}>
      {style.spinner ? (
        <Spinner size="small" style={{ width: size, height: size }} />
      ) : style.icon ? (
        <Icon icon={style.icon} size={size} />
      ) : null}
      {withText && (
        <Text className={styles.label} style={{ color: style.color }}>
          {STATUS_LABEL[status]}
        </Text>
      )}
    </div>
  );
}

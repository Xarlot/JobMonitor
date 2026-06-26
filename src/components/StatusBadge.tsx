import { Box, Octicon, Spinner, Text } from '@primer/react';
import {
  CheckCircleFillIcon,
  ClockIcon,
  DotFillIcon,
  SkipIcon,
  XCircleFillIcon,
} from '@primer/octicons-react';
import type { OverallStatus } from '../api/types';
import { STATUS_LABEL } from '../lib/status';

interface BadgeStyle {
  icon: typeof CheckCircleFillIcon | null;
  color: string;
  spinner?: boolean;
}

const STYLES: Record<OverallStatus, BadgeStyle> = {
  success: { icon: CheckCircleFillIcon, color: 'success.fg' },
  failure: { icon: XCircleFillIcon, color: 'danger.fg' },
  pending: { icon: ClockIcon, color: 'attention.fg' },
  in_progress: { icon: null, color: 'attention.fg', spinner: true },
  neutral: { icon: SkipIcon, color: 'fg.muted' },
  unknown: { icon: DotFillIcon, color: 'fg.muted' },
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
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, color: style.color }}>
      {style.spinner ? (
        <Spinner size="small" sx={{ width: size, height: size }} />
      ) : style.icon ? (
        <Octicon icon={style.icon} size={size} />
      ) : null}
      {withText && (
        <Text sx={{ fontSize: 0, color: style.color, whiteSpace: 'nowrap' }}>
          {STATUS_LABEL[status]}
        </Text>
      )}
    </Box>
  );
}

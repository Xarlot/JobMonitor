/**
 * What auto-rerun has done to *this* PR, as a badge on the PR itself.
 *
 * It used to be one shared list at the top of the Failures tab, which put the information
 * in the wrong place twice over: you had to be on that tab to see it, and once more than
 * one PR was being retried the list said nothing about which. A re-run is a fact about a
 * pull request, so it belongs next to the pull request — visible while scanning, with the
 * detail in a hint rather than spending a row on it.
 *
 * Renders nothing at all when there is nothing to say, so a quiet PR stays quiet.
 */

import { Label } from '@primer/react';
import { Tooltip } from '@primer/react/next';
import { AlertIcon, SyncIcon } from '@primer/octicons-react';
import { useAutoRerun } from '../context/AutoRerunContext';
import type { AutoRerunState } from '../hooks/usePrAutoRerun';
import { formatRelative } from '../lib/format';
import styles from './AutoRerunLabel.module.css';
import { Icon } from './Icon';
import { tooltipWrapFixed } from '../lib/tooltipWrap';

/**
 * Why the engine is idle, if it is — kept because "it re-ran this twice and then stopped"
 * invites "why", and the answer is often that the feature was switched off or the token
 * changed. Mirrors IDLE_REASON_LOG in usePrAutoRerun.
 */
const IDLE_LABEL: Record<AutoRerunState['idleReason'], string> = {
  off: 'auto-rerun is switched off',
  'no-workflows': 'no workflows are configured',
  'no-permission': 'the token cannot re-run jobs',
  throttled: 'paused — GitHub rate limit',
  armed: 'armed',
};

/** Newest first, so the hint opens on the most recent thing that happened. */
function hintFor(prNumber: number, events: ReturnType<typeof useAutoRerun>['events']): string {
  return events
    .filter((e) => e.prNumber === prNumber)
    .map((e) => {
      const when = formatRelative(new Date(e.at).toISOString());
      const what =
        e.outcome === 'requested'
          ? `re-ran failed jobs · attempt ${e.attempt} → ${e.attempt + 1}`
          : e.outcome === 'failed'
            ? `re-run failed: ${e.detail ?? 'unknown error'}`
            : // Held: the engine wanted to re-run and stopped itself, which is the case
              // where the cause is the whole message.
              `held off at attempt ${e.attempt} — could not check the failure: ${e.detail ?? 'unknown reason'}`;
      return `${when} · ${e.workflowFile ?? 'workflow'} · ${what}`;
    })
    .join('\n');
}

export function AutoRerunLabel({ prNumber }: { prNumber: number }) {
  const { events, idleReason } = useAutoRerun();
  const mine = events.filter((e) => e.prNumber === prNumber);
  if (mine.length === 0) return null;

  const failed = mine.filter((e) => e.outcome === 'failed').length;
  const held = mine.filter((e) => e.outcome === 'held').length;
  const requested = mine.length - failed - held;
  // Counts are for *this session* — the event list is in memory, and saying "3 re-runs"
  // when the log knows about ten would be worse than saying nothing.
  const summary =
    [
      requested > 0 ? `re-run ×${requested}` : '',
      failed > 0 ? `${failed} failed` : '',
      held > 0 ? `${held} unchecked` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'auto-rerun';
  // A held re-run is a malfunction to look at, so it colours the badge like a failure.
  const bad = failed > 0 || held > 0;

  const tip = [
    `Auto-rerun · #${prNumber}`,
    hintFor(prNumber, events),
    idleReason === 'armed' ? '' : `Now idle — ${IDLE_LABEL[idleReason]}.`,
    'This session only. The full history is in the diagnostics log.',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    // Same shape as StatsBadge: TooltipV2 needs an interactive trigger to be reachable by
    // keyboard and to render in the top layer, and its default centred single-line styling
    // has to be overridden for a multi-line hint to read as a list.
    <div
      className={`${tooltipWrapFixed} ${styles.tipWide}`}
    >
      <Tooltip text={tip} type="description">
        <button
          type="button"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className={styles.centerDefault}
        >
          <Label variant={bad ? 'danger' : 'attention'}>
            <Icon icon={bad ? AlertIcon : SyncIcon} size={12} className={styles.mr1} />
            {summary}
          </Label>
        </button>
      </Tooltip>
    </div>
  );
}

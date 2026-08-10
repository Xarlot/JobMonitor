import { Text } from '@primer/react';
import { CheckCircleFillIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { OverallStatus, WorkflowRun } from '../api/types';
import { statusToOverall } from '../lib/status';
import styles from './GroupStatusCounts.module.css';
import { Icon } from './Icon';

/**
 * The verdict a group header reports for one item: passed, failed, or nothing.
 *
 * **The latest run only, and only when it reached a verdict.** A group header is read at a
 * glance to answer "is anything broken in here", and the two things that used to muddy it
 * were aggregation and intermediate states:
 *
 *  - the Flows board aggregated *every* run it held, with failure taking top precedence, so
 *    a flow that had failed five runs ago still counted as red after passing since — while
 *    the Overview, showing the same group, counted only the latest run and disagreed;
 *  - a run that is queued, in progress, cancelled or skipped has no verdict to report, and
 *    counting it as a third colour said only "something is happening", which the card itself
 *    already shows.
 *
 * So: take the last run, and count it only if it passed or failed. Everything else is absent
 * from the tally rather than represented by a shrug.
 */
export function groupVerdict(runs: readonly WorkflowRun[]): 'success' | 'failure' | null {
  const latest = runs[0];
  if (!latest) return null;
  const status = statusToOverall(latest.status, latest.conclusion);
  return status === 'success' || status === 'failure' ? status : null;
}

/** The same rule for an item whose status is already reduced, like a pull request. */
export function finalOnly(status: OverallStatus): 'success' | 'failure' | null {
  return status === 'success' || status === 'failure' ? status : null;
}

/**
 * Compact tally for a group header — passed / failed — so a collapsed group still shows
 * what is inside at a glance. Renders nothing when no member has reached a verdict.
 */
export function GroupStatusCounts({ verdicts }: { verdicts: ('success' | 'failure' | null)[] }) {
  const passed = verdicts.filter((v) => v === 'success').length;
  const failed = verdicts.filter((v) => v === 'failure').length;
  if (passed === 0 && failed === 0) return null;

  const item = (icon: typeof CheckCircleFillIcon, color: string, count: number, label: string) =>
    count > 0 ? (
      <span
        title={`${count} ${label}`}
        className={styles.count} style={{ color }}
      >
        <Icon icon={icon} size={12} />
        <Text className={styles.small}>{count}</Text>
      </span>
    ) : null;

  return (
    <span className={styles.centerGap2}>
      {item(CheckCircleFillIcon, 'success.fg', passed, 'passed')}
      {item(XCircleFillIcon, 'danger.fg', failed, 'failed')}
    </span>
  );
}

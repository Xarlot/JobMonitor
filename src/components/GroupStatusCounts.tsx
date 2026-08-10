import { Text } from '@primer/react';
import { CheckCircleFillIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { OverallStatus, WorkflowRun } from '../api/types';
import { latestFinalStatus } from '../lib/status';
import styles from './GroupStatusCounts.module.css';
import { Icon } from './Icon';

/**
 * The verdict a group header reports for one item: passed, failed, or nothing.
 *
 * **The last run that finished, counted only if it passed or failed.** A group header is read at a
 * glance to answer "is anything broken in here", and three things muddied that in turn:
 *
 *  - the Flows board aggregated *every* run it held, failure first, so a flow that failed five runs
 *    ago still counted as red after passing since — while the Overview, showing the same group,
 *    disagreed;
 *  - then the newest run alone, which meant a flow mid-build contributed nothing: a group of three
 *    showed two verdicts, and the third read as missing rather than as its last result;
 *  - a run that is queued or in progress has no verdict of its own, and counting it as a third
 *    colour said only "something is happening", which the card already shows.
 *
 * So: the last *finished* run, counted when it passed or failed. Cancelled and skipped are final but
 * are not verdicts, so they are absent from the tally rather than represented by a shrug.
 */
export function groupVerdict(runs: readonly WorkflowRun[]): 'success' | 'failure' | null {
  return finalOnly(latestFinalStatus(runs));
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

  const item = (icon: typeof CheckCircleFillIcon, className: string, count: number, label: string) =>
    count > 0 ? (
      <span title={`${count} ${label}`} className={className}>
        <Icon icon={icon} size={12} />
        <Text className={styles.small}>{count}</Text>
      </span>
    ) : null;

  return (
    <span className={styles.centerGap2}>
      {item(CheckCircleFillIcon, styles.passed, passed, 'passed')}
      {item(XCircleFillIcon, styles.failed, failed, 'failed')}
    </span>
  );
}

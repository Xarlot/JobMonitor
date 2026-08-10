/**
 * Marks a pull request or flow whose failures already have a stored Claude analysis.
 *
 * The point is to stop paying twice. Analyses are kept for a week, so by the time you come
 * back to a red board some of it has already been looked at — and without a marker the
 * only way to find out is to open each failure and check. One glance here says which ones
 * are already understood.
 *
 * Read straight from the cache rather than tracked in state: the keys already encode the
 * origin, so the answer is a scan over a few dozen entries. It follows that the badge
 * appears on the next render rather than the instant an analysis lands, which is fine —
 * these lists re-render on every poll.
 */

import { Text, Tooltip } from '@primer/react';
import { SparkleFillIcon } from '@primer/octicons-react';
import { analysedOrigins } from '../storage/failureCaches';
import styles from './AnalysedBadge.module.css';

/** `pr:37977` / `flow:abc-123` — the prefix `FailedJobRef.key` is built from. */
export function originKey(kind: 'pr' | 'flow', id: string | number): string {
  return `${kind}:${id}`;
}

export function AnalysedBadge({
  kind,
  id,
  /** Pass a set fetched once when rendering a whole list, to avoid a scan per row. */
  origins,
}: {
  kind: 'pr' | 'flow';
  id: string | number;
  origins?: ReadonlySet<string>;
}) {
  const known = origins ?? analysedOrigins();
  if (!known.has(originKey(kind, id))) return null;

  return (
    <Tooltip text="Claude has already analysed a failure here" direction="n">
      <button type="button" className={`${styles.trigger} ${styles.centerGap1}`}>
        <SparkleFillIcon size={12} />
        <Text className={styles.small}>analysed</Text>
      </button>
    </Tooltip>
  );
}

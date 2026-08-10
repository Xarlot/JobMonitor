/**
 * A CI log, coloured.
 *
 * Rendered as React nodes rather than injected HTML for two reasons: log text is
 * untrusted (it is whatever the build printed, including anything that looks like
 * markup), and colours come from Primer's tokens so they follow the light/dark theme
 * instead of being baked in. The classification itself lives in `src/lib/logHighlight.ts`
 * so it can be tested without a DOM.
 */

import { Text } from '@primer/react';
import { highlightLog, type LogLineKind } from '../lib/logHighlight';
import { subtleScrollbar } from '../lib/scrollbar';
import styles from './LogLines.module.css';

/**
 * Colour per kind, as Primer tokens.
 *
 * Only what carries meaning is coloured: a log where every line is tinted reads no better
 * than one with no colour at all, it just takes longer to scan. `plain` stays default on
 * purpose — it is the majority of any log.
 */
/** A parsed line kind → the class that colours it. `plain` is deliberately absent: no class. */
const KIND_CLASS: Partial<Record<LogLineKind, string>> = {
  error: styles.error,
  failure: styles.failure,
  warning: styles.warning,
  notice: styles.notice,
  group: styles.group,
  endgroup: styles.endgroup,
  command: styles.command,
  section: styles.section,
  success: styles.success,
  stack: styles.stack,
};

export function LogLines({
  text,
  showTimestamps = false,
  maxHeight,
}: {
  text: string;
  showTimestamps?: boolean;
  maxHeight?: number | string;
}) {
  const lines = highlightLog(text);

  return (
    <pre
      className={`${styles.log} ${subtleScrollbar}`}
      // The height is a prop, so it cannot be a class; `overflow-y` follows it, because a pane with
      // no cap should grow rather than scroll inside a parent that is already scrolling.
      style={{ maxHeight, overflowY: maxHeight ? 'auto' : undefined }}
    >
      {lines.map((line, i) => (
        // Index keys are right here: these rows have no identity of their own, and the
        // list is replaced wholesale whenever the text changes.
        <span key={i} className={`${styles.line} ${KIND_CLASS[line.kind] ?? ''}`}>
          {showTimestamps && line.timestamp && (
            <Text as="span" className={styles.timestamp}>
              {line.timestamp.slice(11, 19)}
            </Text>
          )}
          {/* A trailing space keeps a blank line from collapsing to zero height. */}
          {line.text || ' '}
        </span>
      ))}
    </pre>
  );
}

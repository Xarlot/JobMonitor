/**
 * A CI log, coloured — and, when Claude has been asked to read it, mapped.
 *
 * Rendered as React nodes rather than injected HTML for two reasons: log text is
 * untrusted (it is whatever the build printed, including anything that looks like
 * markup), and colours come from Primer's tokens so they follow the light/dark theme
 * instead of being baked in. The classification itself lives in `src/lib/logHighlight.ts`
 * so it can be tested without a DOM.
 *
 * The marker stripe down the right edge is the same idea as an IDE's: a whole-file view of
 * where the trouble is, at a glance, with somewhere to click. It carries Claude's findings
 * rather than the highlighter's classifications on purpose — the highlighter tints every red
 * line, and forty ticks would be a bar chart of how noisy the log is instead of a map of what
 * broke. See src/lib/logMarks.ts.
 */

import { useEffect, useRef } from 'react';
import { Text } from '@primer/react';
import { highlightLog, type LogLineKind } from '../lib/logHighlight';
import type { LogMark } from '../lib/logMarks';
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

/** A found line's own marker in the gutter, and its tick on the stripe. */
const MARK_CLASS = {
  error: styles.markError,
  warning: styles.markWarning,
  notice: styles.markNotice,
} as const;

const TICK_CLASS = {
  error: styles.tickError,
  warning: styles.tickWarning,
  notice: styles.tickNotice,
} as const;

export function LogLines({
  text,
  showTimestamps = false,
  maxHeight,
  marks,
  focusLine = null,
  onPickMark,
}: {
  text: string;
  showTimestamps?: boolean;
  maxHeight?: number | string;
  /** Claude's findings, already anchored to lines of *this* text. */
  marks?: readonly LogMark[];
  /** 1-based line to scroll to and hold highlighted — the mark being visited. */
  focusLine?: number | null;
  /** A tick was clicked; the index is into `marks`. */
  onPickMark?: (index: number) => void;
}) {
  const lines = highlightLog(text);
  const preRef = useRef<HTMLPreElement>(null);

  /** line number → the finding on it, for the row rendering below. */
  const byLine = new Map<number, LogMark>();
  for (const mark of marks ?? []) byLine.set(mark.line, mark);

  /**
   * Bring the visited mark into view.
   *
   * Scrolls the `<pre>` itself when it is the scrolling box, and falls back to
   * `scrollIntoView` when it isn't — this pane is used both with a height cap (the failures
   * view) and without one (inside a rendered Markdown block), and the two scroll in different
   * elements. Moving the ancestor's scroll position would yank the whole page, which is what
   * `scrollIntoView` alone does here.
   */
  useEffect(() => {
    const pre = preRef.current;
    if (!pre || focusLine === null) return;
    const row = pre.children[focusLine - 1] as HTMLElement | undefined;
    if (!row) return;
    if (pre.scrollHeight > pre.clientHeight) {
      pre.scrollTo({ top: Math.max(0, row.offsetTop - pre.clientHeight / 2), behavior: 'smooth' });
    } else {
      row.scrollIntoView({ block: 'center' });
    }
  }, [focusLine]);

  const striped = (marks?.length ?? 0) > 0;
  // The denominator, so the first line sits at the top of the stripe and the last at the
  // bottom. `max(1, …)` keeps a one-line log from dividing by zero.
  const span = Math.max(1, lines.length - 1);

  return (
    <div className={styles.wrap}>
      <pre
        ref={preRef}
        className={`${styles.log} ${striped ? styles.logStriped : ''} ${subtleScrollbar}`}
        // The height is a prop, so it cannot be a class; `overflow-y` follows it, because a pane with
        // no cap should grow rather than scroll inside a parent that is already scrolling.
        style={{ maxHeight, overflowY: maxHeight ? 'auto' : undefined }}
      >
        {lines.map((line, i) => {
          const mark = byLine.get(i + 1);
          const focused = focusLine === i + 1;
          return (
            // Index keys are right here: these rows have no identity of their own, and the
            // list is replaced wholesale whenever the text changes.
            <span
              key={i}
              className={[
                styles.line,
                KIND_CLASS[line.kind] ?? '',
                mark ? MARK_CLASS[mark.severity] : '',
                focused ? styles.lineFocused : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={mark ? [mark.label, mark.note].filter(Boolean).join(' — ') : undefined}
            >
              {showTimestamps && line.timestamp && (
                <Text as="span" className={styles.timestamp}>
                  {line.timestamp.slice(11, 19)}
                </Text>
              )}
              {/* A trailing space keeps a blank line from collapsing to zero height. */}
              {line.text || ' '}
            </span>
          );
        })}
      </pre>

      {striped && (
        <div className={styles.stripe}>
          {marks?.map((mark, i) => (
            <button
              key={`${mark.line}-${i}`}
              type="button"
              className={`${styles.tick} ${TICK_CLASS[mark.severity]} ${
                focusLine === mark.line ? styles.tickActive : ''
              }`}
              style={{ top: `${((mark.line - 1) / span) * 100}%` }}
              title={`Line ${mark.line}: ${[mark.label, mark.note].filter(Boolean).join(' — ')}`}
              aria-label={`Go to line ${mark.line}: ${mark.label}`}
              onClick={() => onPickMark?.(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

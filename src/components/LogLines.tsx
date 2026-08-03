/**
 * A CI log, coloured.
 *
 * Rendered as React nodes rather than injected HTML for two reasons: log text is
 * untrusted (it is whatever the build printed, including anything that looks like
 * markup), and colours come from Primer's tokens so they follow the light/dark theme
 * instead of being baked in. The classification itself lives in `src/lib/logHighlight.ts`
 * so it can be tested without a DOM.
 */

import { Box, Text } from '@primer/react';
import { highlightLog, type LogLineKind } from '../lib/logHighlight';
import { subtleScrollbarSx } from '../lib/scrollbar';

/**
 * Colour per kind, as Primer tokens.
 *
 * Only what carries meaning is coloured: a log where every line is tinted reads no better
 * than one with no colour at all, it just takes longer to scan. `plain` stays default on
 * purpose — it is the majority of any log.
 */
const KIND_SX: Record<LogLineKind, Record<string, unknown>> = {
  error: { color: 'danger.fg', fontWeight: 'bold' },
  failure: { color: 'danger.fg' },
  warning: { color: 'attention.fg' },
  notice: { color: 'accent.fg' },
  group: { color: 'fg.default', fontWeight: 'bold' },
  endgroup: { color: 'fg.subtle' },
  command: { color: 'accent.fg' },
  section: { color: 'done.fg' },
  success: { color: 'success.fg' },
  stack: { color: 'fg.muted' },
  plain: {},
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
    <Box
      as="pre"
      sx={{
        m: 0,
        p: 2,
        fontFamily: 'mono',
        fontSize: 0,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        bg: 'canvas.inset',
        borderRadius: 2,
        // Outlined, because a log block is often nested inside another inset panel — the
        // analysis dialog and the report's collapsible both are — where a shared
        // background alone leaves no edge to read it against.
        border: '1px solid',
        borderColor: 'border.muted',
        maxHeight,
        overflowY: maxHeight ? 'auto' : undefined,
        ...subtleScrollbarSx,
      }}
    >
      {lines.map((line, i) => (
        // Index keys are right here: these rows have no identity of their own, and the
        // list is replaced wholesale whenever the text changes.
        <Box key={i} as="span" sx={{ display: 'block', ...KIND_SX[line.kind] }}>
          {showTimestamps && line.timestamp && (
            <Text as="span" sx={{ color: 'fg.subtle', mr: 2 }}>
              {line.timestamp.slice(11, 19)}
            </Text>
          )}
          {/* A trailing space keeps a blank line from collapsing to zero height. */}
          {line.text || ' '}
        </Box>
      ))}
    </Box>
  );
}

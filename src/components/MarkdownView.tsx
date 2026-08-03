/**
 * Render the Markdown subset the app produces and asks Claude for.
 *
 * React nodes rather than `dangerouslySetInnerHTML`: the content embeds log text, which is
 * whatever the build printed, and a report can carry a model's output. Both are untrusted
 * as markup. Rendering through React escapes everything by construction and lets fenced
 * blocks be handed to the log highlighter, so a quoted log inside an explanation is
 * coloured the same as the log itself.
 */

import { Box, Link, Text } from '@primer/react';
import {
  parseInline,
  parseMarkdownBlocks,
  type InlineSpan,
  type MarkdownBlock,
} from '../lib/markdownBlocks';
import { subtleScrollbarSx } from '../lib/scrollbar';
import { LogLines } from './LogLines';

/** Fence languages whose contents are CI log text rather than source code. */
const LOG_FENCES = new Set(['', 'log', 'text', 'txt', 'console', 'shell', 'sh', 'bash']);

const codeSx = {
  fontFamily: 'mono',
  fontSize: 0,
  bg: 'neutral.muted',
  borderRadius: 1,
  px: 1,
  py: '1px',
} as const;

function Inline({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'code':
            return (
              <Text key={i} as="code" sx={codeSx}>
                {span.text}
              </Text>
            );
          case 'bold':
            return (
              <Text key={i} as="strong" sx={{ fontWeight: 'bold' }}>
                {span.text}
              </Text>
            );
          case 'italic':
            // The model's annotations arrive as italics, so they are tinted as well as
            // slanted — they are commentary on the log, not part of it.
            return (
              <Text key={i} as="em" sx={{ fontStyle: 'italic', color: 'accent.fg' }}>
                {span.text}
              </Text>
            );
          case 'mention':
            // The blame report is about a person, so the name is the thing the eye should
            // land on first — chipped rather than merely coloured, since it sits inside
            // ordinary prose and a colour alone reads as a link.
            return (
              <Text
                key={i}
                as="span"
                sx={{
                  fontWeight: 'bold',
                  color: 'severe.fg',
                  bg: 'severe.subtle',
                  borderRadius: 2,
                  px: 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {span.text}
              </Text>
            );
          case 'link':
            return (
              <Link key={i} href={span.href} target="_blank" rel="noreferrer">
                {span.text}
              </Link>
            );
          default:
            return <Text key={i} as="span">{span.text}</Text>;
        }
      })}
    </>
  );
}

export function MarkdownView({ markdown }: { markdown: string }) {
  return (
    <Box sx={{ fontSize: 1, lineHeight: 1.5 }}>
      <Blocks blocks={parseMarkdownBlocks(markdown)} />
    </Box>
  );
}

/** Extracted so a <details> can render its own contents the same way. */
function Blocks({ blocks }: { blocks: MarkdownBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <Text
                key={i}
                as="div"
                sx={{
                  fontWeight: 'bold',
                  // Only two visual weights: deeper nesting than that is noise in a pane
                  // this size, and the model is asked for `##` anyway.
                  fontSize: block.level <= 2 ? 2 : 1,
                  mt: i === 0 ? 0 : 3,
                  mb: 2,
                  pb: block.level <= 2 ? 1 : 0,
                  borderBottom: block.level <= 2 ? '1px solid' : undefined,
                  borderColor: 'border.muted',
                }}
              >
                <Inline spans={parseInline(block.text)} />
              </Text>
            );

          case 'code':
            return LOG_FENCES.has(block.info.toLowerCase()) ? (
              <Box key={i} sx={{ mb: 2 }}>
                <LogLines text={block.text} />
              </Box>
            ) : (
              <Box
                key={i}
                as="pre"
                sx={{
                  m: 0,
                  mb: 2,
                  p: 2,
                  fontFamily: 'mono',
                  fontSize: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  bg: 'canvas.inset',
                  borderRadius: 2,
                }}
              >
                {block.text}
              </Box>
            );

          case 'list':
            return (
              <Box key={i} as="ul" sx={{ pl: 3, mt: 0, mb: 2 }}>
                {block.items.map((item, j) => (
                  <Box key={j} as="li" sx={{ mb: 1 }}>
                    <Inline spans={parseInline(item)} />
                  </Box>
                ))}
              </Box>
            );

          case 'table':
            return (
              // Scrolls inside its own container: a flaky-test table carries run links and
              // is easily wider than the pane, and the page itself must never scroll
              // sideways.
              <Box key={i} sx={{ overflowX: 'auto', mb: 2, ...subtleScrollbarSx }}>
                <Box
                  as="table"
                  sx={{ borderCollapse: 'collapse', fontSize: 0, width: '100%' }}
                >
                  <Box as="thead">
                    <Box as="tr">
                      {block.header.map((cell, j) => (
                        <Box
                          key={j}
                          as="th"
                          sx={{
                            textAlign: 'left',
                            fontWeight: 'bold',
                            p: 2,
                            borderBottom: '1px solid',
                            borderColor: 'border.default',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <Inline spans={parseInline(cell)} />
                        </Box>
                      ))}
                    </Box>
                  </Box>
                  <Box as="tbody">
                    {block.rows.map((row, r) => (
                      <Box key={r} as="tr">
                        {row.map((cell, c) => (
                          <Box
                            key={c}
                            as="td"
                            sx={{
                              p: 2,
                              borderBottom: '1px solid',
                              borderColor: 'border.muted',
                              verticalAlign: 'top',
                            }}
                          >
                            <Inline spans={parseInline(cell)} />
                          </Box>
                        ))}
                      </Box>
                    ))}
                  </Box>
                </Box>
              </Box>
            );

          case 'details':
            // A real collapsible, closed by default — which is how GitHub will render it
            // and why the report puts the log tail and the suggested fix in one.
            return (
              <Box
                key={i}
                as="details"
                sx={{
                  mb: 2,
                  border: '1px solid',
                  borderColor: 'border.muted',
                  borderRadius: 2,
                  p: 2,
                }}
              >
                <Box as="summary" sx={{ cursor: 'pointer', fontSize: 1, color: 'fg.muted' }}>
                  <Inline spans={parseInline(block.summary)} />
                </Box>
                <Box sx={{ mt: 2 }}>
                  <Blocks blocks={block.blocks} />
                </Box>
              </Box>
            );

          default:
            return (
              <Text key={i} as="p" sx={{ mt: 0, mb: 2, whiteSpace: 'pre-wrap' }}>
                <Inline spans={parseInline(block.text)} />
              </Text>
            );
        }
      })}
    </>
  );
}

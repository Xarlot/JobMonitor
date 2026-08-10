/**
 * Render the Markdown subset the app produces and asks Claude for.
 *
 * React nodes rather than `dangerouslySetInnerHTML`: the content embeds log text, which is
 * whatever the build printed, and a report can carry a model's output. Both are untrusted
 * as markup. Rendering through React escapes everything by construction and lets fenced
 * blocks be handed to the log highlighter, so a quoted log inside an explanation is
 * coloured the same as the log itself.
 */

import { Link, Text } from '@primer/react';
import {
  parseInline,
  parseMarkdownBlocks,
  type InlineSpan,
  type MarkdownBlock,
} from '../lib/markdownBlocks';
import { subtleScrollbar } from '../lib/scrollbar';
import { LogLines } from './LogLines';
import styles from './MarkdownView.module.css';

/** Fence languages whose contents are CI log text rather than source code. */
const LOG_FENCES = new Set(['', 'log', 'text', 'txt', 'console', 'shell', 'sh', 'bash']);

function Inline({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'code':
            return (
              <Text key={i} as="code" className={styles.monoSmall}>
                {span.text}
              </Text>
            );
          case 'bold':
            return (
              <Text key={i} as="strong" className={styles.bold}>
                {span.text}
              </Text>
            );
          case 'italic':
            // The model's annotations arrive as italics, so they are tinted as well as
            // slanted — they are commentary on the log, not part of it.
            return (
              <Text key={i} as="em" className={styles.accentFg}>
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
                className={styles.boldSevereFg}
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
    <div className={styles.body}>
      <Blocks blocks={parseMarkdownBlocks(markdown)} />
    </div>
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
                className={`${block.level <= 2 ? styles.headingMajor : styles.heading} ${i === 0 ? styles.headingFirst : ''}`}
              >
                <Inline spans={parseInline(block.text)} />
              </Text>
            );

          case 'code':
            return LOG_FENCES.has(block.info.toLowerCase()) ? (
              <div key={i} className={styles.mb2}>
                <LogLines text={block.text} />
              </div>
            ) : (
              <pre
                key={i}
                className={styles.m0Mb2}
              >
                {block.text}
              </pre>
            );

          case 'list':
            return (
              <ul key={i} className={styles.pl3Mt0}>
                {block.items.map((item, j) => (
                  <li key={j} className={styles.mb1}>
                    <Inline spans={parseInline(item)} />
                  </li>
                ))}
              </ul>
            );

          case 'table':
            return (
              // Scrolls inside its own container: a flaky-test table carries run links and
              // is easily wider than the pane, and the page itself must never scroll
              // sideways.
              <div key={i} className={`${styles.scrollX} ${subtleScrollbar}`}>
                <table
                  className={styles.small}
                >
                  <thead>
                    <tr>
                      {block.header.map((cell, j) => (
                        <th
                          key={j}
                          className={styles.textLeftBold}
                        >
                          <Inline spans={parseInline(cell)} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            className={styles.p2}
                          >
                            <Inline spans={parseInline(cell)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case 'details':
            // A real collapsible, closed by default — which is how GitHub will render it
            // and why the report puts the log tail and the suggested fix in one.
            return (
              <details
                key={i}
                className={styles.mb2Rounded}
              >
                <summary className={styles.pointerBody}>
                  <Inline spans={parseInline(block.summary)} />
                </summary>
                <div className={styles.mt2}>
                  <Blocks blocks={block.blocks} />
                </div>
              </details>
            );

          default:
            return (
              <Text key={i} as="p" className={styles.mt0Mb2}>
                <Inline spans={parseInline(block.text)} />
              </Text>
            );
        }
      })}
    </>
  );
}

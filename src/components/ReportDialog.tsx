/**
 * The finished report, on its own, at full width.
 *
 * The split pane shows this document already, in a column beside the failure list and under the
 * band that leads it — fine for glancing at, cramped for reading the thing you are about to paste
 * into an issue. This is the same text with the furniture taken away.
 *
 * It is also where the band's one-way action is undone. Carrying the extracted list into the
 * report **hides** the band, since showing the same list twice on one screen is what made the pane
 * feel duplicated — but an action that hides its own control needs its reverse somewhere, and the
 * right somewhere is the document the list was carried into.
 */

import { Button, Text } from '@primer/react';
import { CopyIcon, TrashIcon } from '@primer/octicons-react';
import { markdownToHtml } from '../lib/markdownToHtml';
import { MarkdownView } from './MarkdownView';
import { Modal } from './Modal';
import type { ReportFormat } from '../lib/failureReport';
import styles from './ReportDialog.module.css';

export function ReportDialog({
  jobName,
  report,
  format,
  raw,
  onRemoveFromReport,
  onCopy,
  onClose,
}: {
  jobName: string;
  report: string;
  format: ReportFormat;
  /** Show the literal Markdown instead of rendering it — the pane's own choice, carried in. */
  raw: boolean;
  /**
   * Take the extracted list back out, or null when there is none in the document.
   *
   * Null rather than a disabled button: a control for something that isn't there is noise, and
   * this footer is read while deciding whether to paste.
   */
  onRemoveFromReport: (() => void) | null;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Report — ${jobName}`}
      subtitle={
        format === 'teams'
          ? 'Copies as rich text, which is what Teams pastes'
          : 'Copies as Markdown, which is what a GitHub issue renders'
      }
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          {onRemoveFromReport ? (
            <>
              <Button leadingVisual={TrashIcon} onClick={onRemoveFromReport}>
                Take what failed back out
              </Button>
              <Text className={styles.note}>
                It returns to the band at the top of the pane.
              </Text>
            </>
          ) : null}
          <div className={styles.grow} />
          <Button variant="primary" leadingVisual={CopyIcon} onClick={onCopy}>
            {format === 'teams' ? 'Copy for Teams' : 'Copy markdown'}
          </Button>
        </div>
      }
    >
      {/*
        Teams gets the rendered HTML because that is literally what goes on its clipboard, so the
        window doubles as the fallback: select this, copy by hand, and Teams receives the same
        rich text. Everything else renders through React — see MarkdownView on why the report is
        never injected as markup.
      */}
      {format === 'teams' ? (
        <div className={styles.rich} dangerouslySetInnerHTML={{ __html: markdownToHtml(report) }} />
      ) : raw ? (
        <pre className={styles.mono}>{report}</pre>
      ) : (
        <div className={styles.rendered}>
          <MarkdownView markdown={report} />
        </div>
      )}
    </Modal>
  );
}

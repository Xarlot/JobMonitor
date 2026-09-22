/**
 * Why this job is red, at the top of the pane you land on.
 *
 * The problem it solves: the report is a Markdown document, and the cause was a sentence
 * somewhere inside it — under a heading, above some metadata, competing with a link to the run.
 * A reader arriving at a red job wants one line before anything else, and then the specifics.
 * So this is a band across the top of the report pane: a loud headline, then one row per
 * concrete thing that broke.
 *
 * Not "failing tests". Often it is tests; often it is a compile error, a dead runner, a step
 * that timed out. Each row therefore says what *kind* of thing it is, which is the difference
 * between "assign this to whoever owns the exporter" and "restart the runner".
 *
 * Rendered as React nodes, never as injected markup: every string here came out of a log or a
 * test report by way of a language model.
 */

import { Button, Label, Spinner, Text } from '@primer/react';
import {
  AlertFillIcon,
  CopyIcon,
  PlusIcon,
  SearchIcon,
  SyncIcon,
} from '@primer/octicons-react';
import {
  failureItemCount,
  groupItems,
  type FailureCause,
  type FailureItem,
  type FailureItemKind,
} from '../lib/failureCause';
import type { ClaudeAnalysis } from '../lib/claudePrompt';
import { describeTestReportHint, type TestReportHint } from '../lib/testReportHint';
import { subtleScrollbar } from '../lib/scrollbar';
import styles from './FailureCauseCard.module.css';
import { Icon } from './Icon';

/**
 * Kind → badge colour. Deliberately not all danger: whether a job died on an assertion or on a
 * runner losing its connection decides who picks it up, and that difference is worth a colour.
 */
const KIND_VARIANT: Record<FailureItemKind, 'danger' | 'severe' | 'attention' | 'secondary'> = {
  test: 'danger',
  assertion: 'danger',
  error: 'danger',
  failure: 'danger',
  compile: 'severe',
  crash: 'severe',
  timeout: 'attention',
  infrastructure: 'attention',
  dependency: 'attention',
  lint: 'secondary',
  skipped: 'secondary',
};

/**
 * The headline as one line of plain text.
 *
 * Markdown emphasis is stripped rather than rendered: this is a single sentence set large and
 * bold, and a `code span` inside it would either fight that weight or need the prose renderer's
 * paragraph styling, which is the styling this line exists to escape. The verbatim text lives in
 * the rows below, in monospace, where it belongs.
 */
function plainLine(text: string): string {
  return text
    .split('\n')[0]
    .replace(/[`*_]/g, '')
    .trim();
}

/**
 * Split a group name into the part nobody reads and the part everybody does.
 *
 * `com.devexpress.drawing.docs.PdfExportTest` is one identifier, but only its last segment
 * identifies anything to someone scanning twelve rows. Dimming the package rather than
 * truncating it keeps the whole name selectable, which is what you want the moment you go
 * looking for the file.
 */
function GroupName({ group }: { group: string }) {
  const at = Math.max(group.lastIndexOf('.'), group.lastIndexOf('/'), group.lastIndexOf('\\'));
  const split = at > 0 && at < group.length - 1;
  return (
    <>
      {split && (
        <Text as="span" className={styles.groupPrefix}>
          {group.slice(0, at + 1)}
        </Text>
      )}
      <Text as="span" className={styles.groupTail}>
        {split ? group.slice(at + 1) : group}
      </Text>
    </>
  );
}

function ItemRow({ item }: { item: FailureItem }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <Label variant={KIND_VARIANT[item.kind]} className={styles.kind}>
          {item.kind}
        </Label>
        <Text className={styles.what}>{item.what}</Text>
        {item.where && (
          <Text className={styles.where} title={item.where}>
            {item.where}
          </Text>
        )}
      </div>
      {/*
        The decisive line, verbatim and monospaced. `pre-wrap` rather than `pre`: these are single
        lines by contract, but a long expected/actual pair has to wrap somewhere, and wrapping
        beats a pane that scrolls sideways.
      */}
      {item.message && <div className={styles.message}>{item.message}</div>}
    </div>
  );
}

/** The items, grouped under whatever they belong to. */
function FailureItems({
  items,
  maxHeight,
}: {
  items: readonly FailureItem[];
  maxHeight?: number | string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`${styles.groups} ${subtleScrollbar}`} style={{ maxHeight }}>
      {groupItems(items).map((group, i) => (
        <div key={group.group ?? `ungrouped-${i}`} className={styles.group}>
          {group.group && (
            <div className={styles.groupHead} title={group.group}>
              <GroupName group={group.group} />
              <Text as="span" className={styles.groupCount}>
                {group.items.length}
              </Text>
            </div>
          )}
          {group.items.map((item, j) => (
            // Index keys: the list is replaced wholesale whenever the analysis changes, and two
            // shards can legitimately report the same name twice.
            <ItemRow key={`${item.what}-${j}`} item={item} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function FailureCauseCard({
  cause,
  analysis,
  running,
  error,
  searched,
  reportHint,
  onFind,
  onAddToReport,
  onCopy,
}: {
  cause: FailureCause | null;
  /**
   * The quick or deep read, when one exists.
   *
   * Used for the headline when this task has not been run: that analysis already opens with a
   * sentence saying what went wrong, and leaving it buried in the document below while this band
   * says "nothing yet" would be the same complaint in a new place.
   */
  analysis: ClaudeAnalysis | null;
  running: boolean;
  error: string | null;
  /**
   * Whether the pass that can read the run's artifacts has actually run.
   *
   * Separate from `cause` being present, because the quick read now fills this band too and the
   * two lists are not equivalent: the quick read sees only the log, so when a sharded suite keeps
   * its test names in a JUnit XML its list is short or empty. The button therefore offers to look
   * *further* rather than to look *again*, which is the difference between a useful click and one
   * that repeats work.
   */
  searched: boolean;
  /**
   * The runner's own statement that it kept the test names out of the log.
   *
   * Shown when there is nothing to list, because "no failing tests" is then the wrong thing for
   * this band to imply: a Gradle task that writes its results to `build/reports` and says so is
   * not a job without failing tests, it is a job whose failing tests are one artifact away. The
   * annotations cannot say that, and the quick read — which can only read the log — correctly
   * reports that it does not know.
   */
  reportHint: TestReportHint | null;
  onFind: () => void;
  /**
   * Carry the list into the bug report.
   *
   * One-way from here: the band unmounts once the list is in the document, since showing the same
   * list twice on one screen is what made the pane feel like it was repeating itself. Taking it
   * back out lives in the report window, which is where the list now is — see `ReportDialog`.
   */
  onAddToReport: () => void;
  onCopy: () => void;
}) {
  const headline = cause?.headline ?? (analysis?.problem ? plainLine(analysis.problem) : null);
  const items = cause?.items ?? [];
  const counted = cause ? failureItemCount(cause) : 0;
  const hidden = counted - items.length;
  /**
   * The pointer is worth showing only while there is no list *and* nobody has been to look.
   *
   * Once the pass that reads the run's artifacts has run and still has nothing, pointing at the
   * report is worse than silence: that is the step it just took, and repeating it as advice
   * contradicts the answer sitting next to it.
   */
  const pointer = items.length === 0 && !running && !searched ? reportHint : null;

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <Icon icon={AlertFillIcon} size={16} className={styles.dangerFg} />
        {running ? (
          <>
            {/*
              No button and no dialog: this task starts on its own, and the strip at the top of the
              view carries the phase, the last command and Stop. Duplicating that here would put two
              progress reports on one screen for a call nobody asked for.
            */}
            <Text className={styles.working}>Working out what failed…</Text>
            <Spinner size="small" />
            <div className={styles.grow} />
          </>
        ) : headline ? (
          <>
            <Text className={styles.headline}>{headline}</Text>
            <div className={styles.grow} />
          </>
        ) : (
          <>
            {/*
              The invitation names what it will read and what it costs. "Analyse" would not: the
              point of this task is that it goes to the run's own test report, which is the part a
              reader cannot do from here.
            */}
            <Text className={styles.invite}>
              What actually failed? Claude can read it out of the log and the run’s test report.
            </Text>
            <div className={styles.grow} />
          </>
        )}
        {!running && (
          <Button
            size="small"
            leadingVisual={searched ? SyncIcon : SearchIcon}
            onClick={onFind}
          >
            {/*
              The label names the step the reader has not taken. "Look again" after a pass that
              only read the log would send them round the same loop; "Read the test report" is
              the one action that can answer, and it is worth saying so on the button.
            */}
            {searched
              ? 'Look again'
              : pointer
                ? 'Read the test report'
                : items.length > 0
                  ? 'Look in the artifacts'
                  : 'Find out'}
          </Button>
        )}
      </div>

      {error && !running && <Text className={styles.error}>{error}</Text>}

      {pointer && <Text className={styles.pointer}>{describeTestReportHint(pointer)}</Text>}

      {/*
        A cause with no items is a real answer — an infrastructure failure often has nothing to
        list — so the headline stands on its own rather than being followed by an empty box.
      */}
      <FailureItems items={items} maxHeight="34vh" />

      {(cause?.source || cause?.note || hidden > 0 || items.length > 0) && (
        <div className={styles.foot}>
          {items.length > 0 && (
            <Text className={styles.count}>
              {counted} {counted === 1 ? 'thing' : 'things'} failed
              {/*
                Said as its own clause: "12 things failed" when 400 did is a lie, and "12 of 400"
                reads as the list being complete at 12.
              */}
              {hidden > 0 ? ` — ${items.length} listed, ${hidden} not shown` : ''}
            </Text>
          )}
          {cause?.source && (
            <Text className={styles.source} title={`Read from ${cause.source}`}>
              from {cause.source}
            </Text>
          )}
          {cause?.note && <Text className={styles.note}>{cause.note}</Text>}
          <div className={styles.grow} />
          {cause && (
            <>
              <Button size="small" leadingVisual={CopyIcon} onClick={onCopy}>
                Copy
              </Button>
              {/*
                Carrying it into the bug report is the reader's decision, like the blame verdict:
                every other fact in that document was fetched from the API. There is no "in the
                report" state to show here, because by then this band is gone.
              */}
              <Button
                size="small"
                variant="primary"
                leadingVisual={PlusIcon}
                onClick={onAddToReport}
              >
                Add to the report
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { FailureCauseCard } from '../components/FailureCauseCard';
import { FAILURES_MARKER, parseFailureCause, type FailureCause } from '../lib/failureCause';

function cause(reply: string): FailureCause {
  const parsed = parseFailureCause(reply);
  if (!parsed) throw new Error('the fixture should parse');
  return parsed;
}

const FROM_THE_LOG = cause(`${FAILURES_MARKER}
source: the job log
- kind: assertion
  what: exportsRotatedPage
  group: com.example.reporting.ExportToPdfTests
  message: Expected 0 diffs but got 3
`);

function renderCard(over: Partial<Parameters<typeof FailureCauseCard>[0]> = {}) {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <FailureCauseCard
          cause={null}
          analysis={null}
          running={false}
          error={null}
          searched={false}
          reportHint={null}
          inReport={false}
          onFind={() => {}}
          onToggleInReport={() => {}}
          onCopy={() => {}}
          {...over}
        />
      </BaseStyles>
    </ThemeProvider>,
  );
}

describe('FailureCauseCard', () => {
  it('invites the reader to find out when nothing has been run', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /find out/i })).toBeTruthy();
  });

  /**
   * The point of the whole change: the failing test and its assertion are on the description
   * screen, from the log the quick read was already holding, without anybody opening a log.
   */
  it('shows what failed, with its suite and its assertion', () => {
    renderCard({ cause: FROM_THE_LOG });
    expect(screen.getByText('exportsRotatedPage')).toBeTruthy();
    expect(screen.getByText('Expected 0 diffs but got 3')).toBeTruthy();
    expect(screen.getByText(/ExportToPdfTests/)).toBeTruthy();
    expect(screen.getByText(/from the job log/)).toBeTruthy();
  });

  /**
   * A list from the quick read is the log's list, and the log is often not the whole truth — a
   * sharded suite keeps its names in a JUnit XML. So the button offers the step the reader has
   * not taken rather than repeating the one they have.
   */
  it('offers the artifacts when the list came from the log alone', () => {
    renderCard({ cause: FROM_THE_LOG, searched: false });
    expect(screen.getByRole('button', { name: /look in the artifacts/i })).toBeTruthy();
  });

  it('offers to look again once the artifacts have been read', () => {
    renderCard({ cause: FROM_THE_LOG, searched: true });
    expect(screen.getByRole('button', { name: /look again/i })).toBeTruthy();
  });

  /**
   * The failure this was all built for: a Gradle shard that failed on real assertions and named
   * not one test, because the runner wrote them to a report file and said so. An empty list there
   * reads as "nothing failed" unless the band says where they went — and "Find out" is the wrong
   * label for the one click that can answer.
   */
  it('says where the names went when the log withheld them', () => {
    renderCard({
      reportHint: { tool: 'Gradle', where: 'printing-core-tests/build/reports/tests/test' },
    });
    expect(screen.getByText(/Gradle wrote them to printing-core-tests/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /read the test report/i })).toBeTruthy();
  });

  /** Once the artifact has been read, saying where the names live answers nothing. */
  it('drops the pointer once there is a list', () => {
    renderCard({
      cause: FROM_THE_LOG,
      reportHint: { tool: 'Gradle', where: 'build/reports/tests/test' },
    });
    expect(screen.queryByText(/Gradle wrote them to/)).toBeNull();
  });

  /**
   * And once the artifact pass has been and found nothing, repeating "look in the artifacts"
   * contradicts the answer sitting beside it — that is the step it just took.
   */
  it('drops the pointer once somebody has been to look', () => {
    renderCard({
      searched: true,
      reportHint: { tool: 'Gradle', where: 'build/reports/tests/test' },
    });
    expect(screen.queryByText(/Gradle wrote them to/)).toBeNull();
    expect(screen.getByRole('button', { name: /look again/i })).toBeTruthy();
  });

  /** A cause with no records is a real answer — infrastructure failures often have none. */
  it('stands on the headline alone when there is nothing to list', () => {
    renderCard({
      cause: cause(`${FAILURES_MARKER}\ncause: the runner lost its connection mid-run`),
    });
    expect(screen.getByText(/runner lost its connection/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add to the report/i })).toBeNull();
  });

  /** Before this task has run, the prose read already opens with the sentence this band wants. */
  it('falls back to the analysis for its headline', () => {
    renderCard({
      analysis: { problem: 'The PDF comparison found three differing pages.\nThe rest follow.', solution: '' },
    });
    expect(screen.getByText('The PDF comparison found three differing pages.')).toBeTruthy();
  });
});

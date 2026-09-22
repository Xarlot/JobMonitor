import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { ReportDialog } from '../components/ReportDialog';

const REPORT = [
  '### `compare-exporttopdf-pdfs` failed',
  '',
  '#### What failed (3)',
  '- **assertion** `ExportToPdfTests` › `compareExportToPdfPdfs` — `Expected 0 diffs but got 3`',
].join('\n');

function renderDialog(over: Partial<Parameters<typeof ReportDialog>[0]> = {}) {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <ReportDialog
          jobName="compare-exporttopdf-pdfs"
          report={REPORT}
          format="github"
          raw={false}
          onRemoveFromReport={null}
          onCopy={() => {}}
          onClose={() => {}}
          {...over}
        />
      </BaseStyles>
    </ThemeProvider>,
  );
}

describe('ReportDialog', () => {
  it('shows the report rendered, with the job in the title', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Report — compare-exporttopdf-pdfs/ })).toBeTruthy();
    expect(screen.getByText(/What failed \(3\)/)).toBeTruthy();
  });

  /**
   * The other half of making the band one-way. The band hides itself once its list is in the
   * document, so the reverse has to exist somewhere the reader can still reach — and the document
   * is where the list went.
   */
  it('offers taking the extracted list back out', () => {
    const onRemoveFromReport = vi.fn();
    renderDialog({ onRemoveFromReport });
    fireEvent.click(screen.getByRole('button', { name: /take what failed back out/i }));
    expect(onRemoveFromReport).toHaveBeenCalledTimes(1);
  });

  /** A control for something that isn't in the document is noise in a footer read before pasting. */
  it('says nothing about removing what was never added', () => {
    renderDialog();
    expect(screen.queryByRole('button', { name: /take what failed back out/i })).toBeNull();
  });

  it('copies, and names the format it copies as', () => {
    const onCopy = vi.fn();
    const { unmount } = renderDialog({ onCopy });
    fireEvent.click(screen.getByRole('button', { name: /copy markdown/i }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    unmount();

    renderDialog({ format: 'teams' });
    expect(screen.getByRole('button', { name: /copy for teams/i })).toBeTruthy();
  });

  /** The raw view is the literal text the clipboard gets, headings and all. */
  it('shows the Markdown verbatim when the pane is set to raw', () => {
    renderDialog({ raw: true });
    expect(screen.getByText(/#### What failed \(3\)/)).toBeTruthy();
  });

  it('closes on the ✕', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * The viewer end to end, minus Electron: the `desktop.logs.read` bridge is stubbed, so
 * this covers the path that actually breaks — bridge shape, parse, filter, render — which
 * the app smoke test can't reach (the tab is opt-in and desktop-only).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { DiagnosticsView } from '../components/DiagnosticsView';
import { ConfigProvider } from '../context/ConfigContext';

const RECORDS = [
  '{"at":"2026-08-03T12:42:41.230Z","scope":"renderer:auto-rerun","message":"armed","detail":{"canWrite":true}}',
  '{"at":"2026-08-03T12:42:42.298Z","scope":"renderer:auto-rerun","message":"#41763 not re-run — the run is older than the configured window","detail":{"runId":30619940666,"ageHours":75.3}}',
  '{"at":"2026-08-03T12:42:43.000Z","scope":"claude","message":"WARN: gh could not produce the run log"}',
].join('\n');

function stubBridge(tail: { text: string; truncated: boolean; size: number } | null) {
  const read = vi.fn().mockResolvedValue(tail);
  (globalThis as { desktop?: unknown }).desktop = {
    isDesktop: true,
    logs: {
      read,
      path: vi.fn().mockResolvedValue({ file: '/tmp/logs/job-monitor.ndjson', dir: '/tmp/logs' }),
      reveal: vi.fn(),
    },
  };
  return read;
}

function renderView() {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <ConfigProvider>
          <DiagnosticsView />
        </ConfigProvider>
      </BaseStyles>
    </ThemeProvider>,
  );
}

describe('DiagnosticsView', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    delete (globalThis as { desktop?: unknown }).desktop;
    vi.restoreAllMocks();
  });

  it('shows the tail newest first, with the scope on each row', async () => {
    stubBridge({ text: RECORDS, truncated: false, size: RECORDS.length });
    const { container } = renderView();

    await waitFor(() => expect(screen.getByText(/3 records/)).toBeTruthy());
    expect(screen.getByText('armed')).toBeTruthy();
    // The WARN prefix is rendered as a badge, so the message loses it.
    expect(screen.getByText('gh could not produce the run log')).toBeTruthy();

    const text = container.textContent ?? '';
    expect(text.indexOf('gh could not produce')).toBeLessThan(text.indexOf('armed'));
  });

  /** The id being chased is in the detail, which is why the search covers it. */
  it('filters by a detail value that never appears in a message', async () => {
    stubBridge({ text: RECORDS, truncated: false, size: RECORDS.length });
    renderView();
    await waitFor(() => expect(screen.getByText(/3 records/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/message, run id/), {
      target: { value: '30619940666' },
    });

    await waitFor(() => expect(screen.getByText(/1 of 3 records/)).toBeTruthy());
    expect(screen.queryByText('armed')).toBeNull();
  });

  it('expands a row into its detail', async () => {
    stubBridge({ text: RECORDS, truncated: false, size: RECORDS.length });
    renderView();
    await waitFor(() => expect(screen.getByText('armed')).toBeTruthy());

    expect(screen.queryByText(/"canWrite": true/)).toBeNull();
    const rows = screen.getAllByLabelText('Show detail');
    fireEvent.click(rows[rows.length - 1]); // oldest row: 'armed'
    expect(screen.getByText(/"canWrite": true/)).toBeTruthy();
  });

  it('offers a way out when the filters match nothing', async () => {
    stubBridge({ text: RECORDS, truncated: false, size: RECORDS.length });
    renderView();
    await waitFor(() => expect(screen.getByText(/3 records/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/message, run id/), {
      target: { value: 'no such thing' },
    });
    await waitFor(() => expect(screen.getByText(/No record matches/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /clear the filters/i }));
    await waitFor(() => expect(screen.getByText(/3 records/)).toBeTruthy());
  });

  it('says the window is partial rather than implying it is everything', async () => {
    stubBridge({ text: RECORDS, truncated: true, size: 5_000_000 });
    renderView();
    await waitFor(() =>
      expect(screen.getByText(/earlier records are in the file, not here/)).toBeTruthy(),
    );
  });

  /** An empty file is the normal state of a fresh install, not an error. */
  it('explains an empty log', async () => {
    stubBridge({ text: '', truncated: false, size: 0 });
    renderView();
    await waitFor(() => expect(screen.getByText(/Nothing logged yet/)).toBeTruthy());
  });

  /** No bridge at all: a browser tab, or a preload too old to have logs.read. */
  it('explains that a browser has no such file', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText(/no such file in a browser tab/)).toBeTruthy());
  });
});

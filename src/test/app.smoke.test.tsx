import { fireEvent, render, screen } from '@testing-library/react';
import { BaseStyles, ThemeProvider } from '@primer/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../context/AuthContext';
import { ConfigProvider } from '../context/ConfigContext';
import { setFetchImpl } from '../api/githubClient';
import { mockFetch } from '../mocks/mockFetch';

/**
 * Mounts the full component tree under Primer in mock mode. Catches runtime
 * wiring problems (provider/context misuse, bad Primer props) that typechecking
 * alone won't surface.
 */
describe('App smoke', () => {
  beforeAll(() => {
    vi.stubEnv('VITE_MOCK', '1');
    setFetchImpl(mockFetch as unknown as typeof fetch);
  });

  it('renders Overview and navigates to PRs and Flows', async () => {
    render(
      <ThemeProvider>
        <BaseStyles>
          <ConfigProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ConfigProvider>
        </BaseStyles>
      </ThemeProvider>,
    );

    // Overview is the default tab: a tile per PR (by name) and per flow.
    expect(await screen.findByText('Job Monitor')).toBeInTheDocument();
    expect(await screen.findByText('space handling')).toBeInTheDocument(); // PR tile
    expect(await screen.findByText('java')).toBeInTheDocument(); // flow tile
    // The regex flow expands into one tile per matching workflow (nightly-*.yml),
    // which exercises the whole resolve path: workflow list → match → runtime.
    expect(await screen.findByText('Nightly Linux')).toBeInTheDocument();

    // Navigate to the Flows tab; cards start collapsed (accordion), so expand
    // one and confirm the master-detail run grid renders.
    fireEvent.click(screen.getByRole('link', { name: /Flows/ }));
    fireEvent.click(await screen.findByText('java-cron'));
    expect(await screen.findByText('workflow_dispatch')).toBeInTheDocument();

    // The Failures tab derives from the same PR and flow state, and its report
    // builder touches the annotation/log plumbing — worth a mount to catch wiring
    // breaks.
    fireEvent.click(screen.getByRole('link', { name: /Failures/ }));
    // Groups start collapsed, so nothing is focused and no report is shown yet.
    expect(await screen.findByText(/\d+ failing jobs?/)).toBeInTheDocument();
    expect(screen.getByText(/Open a group and pick a failing job/)).toBeInTheDocument();

    // Expanding a group reveals its rows; picking one renders that job's report.
    const group = await screen.findByRole('button', { name: /visual tests refactoring/ });
    fireEvent.click(group);
    fireEvent.click(await screen.findByText('compare-exporttopdf-pdfs'));
    // The report renders as Markdown, so the heading arrives as text rather than `####`.
    expect(await screen.findByText('Failed tests')).toBeInTheDocument();

    // …and the raw Markdown is still reachable, because it is what Copy puts on the
    // clipboard — a preview you cannot check against the copied text is worth less.
    fireEvent.click(screen.getByRole('button', { name: /Raw Markdown/ }));
    expect(await screen.findByText(/#### Failed tests/)).toBeInTheDocument();
    // Mounts the whole tree and walks four tabs, each step waiting on mock-latency
    // requests — comfortably past vitest's 5s default.
  }, 30_000);
});

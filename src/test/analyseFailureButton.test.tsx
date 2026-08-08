/**
 * The jump from a failing check or job to the same failure in the Failures tab.
 *
 * Two conditions, and both exist so it is never a dead end: the AI integration has to be on
 * (that tab is where a failure gets explained, which is the point of going), and the failure
 * has to actually be in that tab — its list is bounded, so a job failing outside those
 * bounds has no row to land on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { AnalyseFailureButton } from '../components/AnalyseFailureButton';
import { ConfigProvider } from '../context/ConfigContext';
import { NavigationProvider } from '../context/NavigationContext';
import { resetAiProbe } from '../hooks/useAiAvailable';
import { DEFAULT_CONFIG } from '../storage/configStore';

let failures: { key: string; checkRunId: number | null; jobId: number | null }[] = [];
vi.mock('../context/FailuresContext', () => ({
  useFailures: () => ({ failures, groups: [] }),
}));

/** The desktop bridge, with `claude` present or not. */
function stubBridge(claude: boolean) {
  (globalThis as { desktop?: unknown }).desktop = {
    isDesktop: true,
    claude: {
      probe: vi.fn().mockResolvedValue({
        gh: true,
        ghVersion: '2',
        ghAuthenticated: true,
        claude,
        claudeVersion: claude ? '1' : null,
      }),
      analyze: vi.fn(),
      cancel: vi.fn(),
      onProgress: () => () => {},
    },
  };
}

function show(props: { checkRunId?: number | null; jobId?: number | null }, openFailure = vi.fn()) {
  render(
    <ThemeProvider>
      <BaseStyles>
        <ConfigProvider>
          <NavigationProvider value={{ openPr: () => {}, openFailure }}>
            <AnalyseFailureButton {...props} />
          </NavigationProvider>
        </ConfigProvider>
      </BaseStyles>
    </ThemeProvider>,
  );
  return openFailure;
}

const button = () => screen.queryByRole('button', { name: /analyse in failures/i });

beforeEach(() => {
  resetAiProbe();
  localStorage.clear();
  localStorage.setItem('job-monitor.config', JSON.stringify(DEFAULT_CONFIG));
  failures = [{ key: 'pr:7:100', checkRunId: 100, jobId: 900 }];
  stubBridge(true);
});

afterEach(() => {
  delete (globalThis as { desktop?: unknown }).desktop;
  resetAiProbe();
  vi.restoreAllMocks();
});

describe('AnalyseFailureButton', () => {
  it('navigates to the failure it stands for', async () => {
    const openFailure = show({ checkRunId: 100 });

    fireEvent.click(await screen.findByRole('button', { name: /analyse in failures/i }));

    expect(openFailure).toHaveBeenCalledWith('pr:7:100');
  });

  /** A flow's failures are keyed on the job; a pull request's on the check run. */
  it('matches on the job id too', async () => {
    const openFailure = show({ jobId: 900 });

    fireEvent.click(await screen.findByRole('button', { name: /analyse in failures/i }));

    expect(openFailure).toHaveBeenCalledWith('pr:7:100');
  });

  /** The Failures tab is bounded; a job outside it has no row to land on. */
  it('is absent for a check that is not in the Failures tab', async () => {
    show({ checkRunId: 999 });
    await waitFor(() => expect(button()).toBeNull());
  });

  it('is absent for a passing check, which has no failure at all', async () => {
    show({ checkRunId: null, jobId: null });
    await waitFor(() => expect(button()).toBeNull());
  });

  /**
   * Without the CLI the Failures tab still works, but the thing this button is *for* —
   * going somewhere to have the failure explained — is not there.
   */
  it('is absent when `claude` is not installed', async () => {
    stubBridge(false);
    show({ checkRunId: 100 });
    await waitFor(() => expect(button()).toBeNull());
  });

  it('is absent in a browser, which has no bridge at all', async () => {
    delete (globalThis as { desktop?: unknown }).desktop;
    show({ checkRunId: 100 });
    await waitFor(() => expect(button()).toBeNull());
  });

  it('is absent when the AI integration is switched off', async () => {
    localStorage.setItem(
      'job-monitor.config',
      JSON.stringify({ ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai, enabled: false } }),
    );
    show({ checkRunId: 100 });
    await waitFor(() => expect(button()).toBeNull());
  });

  /** Rendered outside the provider — a dialog with nowhere to navigate — it simply isn't there. */
  it('is absent with no navigation to offer', async () => {
    render(
      <ThemeProvider>
        <BaseStyles>
          <ConfigProvider>
            <AnalyseFailureButton checkRunId={100} />
          </ConfigProvider>
        </BaseStyles>
      </ThemeProvider>,
    );
    await waitFor(() => expect(button()).toBeNull());
  });
});

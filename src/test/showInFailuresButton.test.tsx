/**
 * The jump from a failing check or job to the same failure in the Failures tab.
 *
 * One condition, and it exists so the jump is never a dead end: the failure has to actually be in
 * that tab — its list is bounded, so a job failing outside those bounds has no row to land on.
 *
 * It used to also require the AI integration. The three cases below that assert the button is
 * *present* without a CLI, without a bridge and with the integration off are that change: the
 * coloured log, the annotations and the report are all in that tab without a model, and gating the
 * only way out of a job row on the model left browser users with none.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { ShowInFailuresButton } from '../components/ShowInFailuresButton';
import { ConfigProvider } from '../context/ConfigContext';
import { NavigationProvider } from '../context/NavigationContext';
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
            <ShowInFailuresButton {...props} />
          </NavigationProvider>
        </ConfigProvider>
      </BaseStyles>
    </ThemeProvider>,
  );
  return openFailure;
}

const button = () => screen.queryByRole('button', { name: /show in failures/i });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('job-monitor.config', JSON.stringify(DEFAULT_CONFIG));
  failures = [{ key: 'pr:7:100', checkRunId: 100, jobId: 900 }];
  stubBridge(true);
});

afterEach(() => {
  delete (globalThis as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

describe('ShowInFailuresButton', () => {
  it('navigates to the failure it stands for', async () => {
    const openFailure = show({ checkRunId: 100 });

    fireEvent.click(await screen.findByRole('button', { name: /show in failures/i }));

    expect(openFailure).toHaveBeenCalledWith('pr:7:100');
  });

  /** A flow's failures are keyed on the job; a pull request's on the check run. */
  it('matches on the job id too', async () => {
    const openFailure = show({ jobId: 900 });

    fireEvent.click(await screen.findByRole('button', { name: /show in failures/i }));

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
   * The three cases the AI gate used to suppress.
   *
   * All of them are the same point: what the Failures tab offers without a model — the coloured
   * log, the annotations, the copyable report — is most of what it offers at all, so the way to
   * reach it must not depend on one.
   */
  it('is present when `claude` is not installed', async () => {
    stubBridge(false);
    show({ checkRunId: 100 });
    await waitFor(() => expect(button()).not.toBeNull());
  });

  it('is present in a browser, which has no bridge at all', async () => {
    delete (globalThis as { desktop?: unknown }).desktop;
    show({ checkRunId: 100 });
    await waitFor(() => expect(button()).not.toBeNull());
  });

  it('is present when the AI integration is switched off', async () => {
    localStorage.setItem(
      'job-monitor.config',
      JSON.stringify({ ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai, enabled: false } }),
    );
    show({ checkRunId: 100 });
    await waitFor(() => expect(button()).not.toBeNull());
  });

  /** Rendered outside the provider — a dialog with nowhere to navigate — it simply isn't there. */
  it('is absent with no navigation to offer', async () => {
    render(
      <ThemeProvider>
        <BaseStyles>
          <ConfigProvider>
            <ShowInFailuresButton checkRunId={100} />
          </ConfigProvider>
        </BaseStyles>
      </ThemeProvider>,
    );
    await waitFor(() => expect(button()).toBeNull());
  });
});

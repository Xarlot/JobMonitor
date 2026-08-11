/**
 * The Telemetry pane's controls appear only in a development build.
 *
 * The pane as a whole is now development-only too — `DiagnosticsView` does not offer it otherwise,
 * which is what `diagnosticsView.test.tsx` covers. This file stays because the two gates are
 * independent: this one guards the controls *within* the pane, so a future caller that renders it
 * somewhere else cannot accidentally expose a switch that turns collection off and a button that
 * publishes on demand.
 *
 * The flag is computed in the **main process** (`devBuild = !app.isPackaged`) rather than in the
 * renderer, and the main process refuses `setCollecting` in a packaged build regardless — so this is
 * defence in depth rather than the only thing standing between a user and an opt-out. It still has to
 * hold: a switch that appears and then silently refuses is worse than no switch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BaseStyles, ThemeProvider } from '@primer/react';
import { TelemetryPane } from '../components/TelemetryPane';
import type { TelemetryMeta, TelemetrySnapshot } from '../storage/desktopTelemetry';

const meta = (over: Partial<TelemetryMeta> = {}): TelemetryMeta => ({
  installationId: '0'.repeat(32),
  appVersion: '3.0.0',
  platform: 'linux',
  arch: 'x64',
  electronVersion: '43.3.0',
  sendEnabled: true,
  devBuild: false,
  collecting: true,
  disabled: false,
  crashesThisSession: 0,
  ...over,
});

function stubBridge(snapshot: Partial<TelemetrySnapshot>): void {
  (globalThis as { desktop?: unknown }).desktop = {
    telemetry: {
      read: async () => ({ available: true, records: [], stats: null, ...snapshot }),
      setCollecting: async () => ({ ok: true, collecting: false }),
      sendNow: async () => ({ ok: true, sent: 0 }),
    },
  };
}

function show(): void {
  render(
    <ThemeProvider>
      <BaseStyles>
        <TelemetryPane />
      </BaseStyles>
    </ThemeProvider>,
  );
}

const collectSwitch = () => screen.queryByLabelText(/collect telemetry this session/i);
const sendNow = () => screen.queryByRole('button', { name: /send now/i });

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  delete (globalThis as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

describe('TelemetryPane', () => {
  it('hides the collection switch and Send now in a packaged build', async () => {
    stubBridge({ meta: meta({ devBuild: false }) });
    show();

    /*
     * The `installation` assertion is what makes the two below mean anything: it waits for the
     * snapshot to arrive. Asserting "absent" immediately would pass before the flag had been read
     * and would prove nothing at all.
     */
    await waitFor(() => expect(screen.getByText(/installation/i)).toBeInTheDocument());
    expect(collectSwitch()).toBeNull();
    expect(sendNow()).toBeNull();
  });

  it('shows them in a development build', async () => {
    stubBridge({ meta: meta({ devBuild: true, collecting: false }) });
    show();

    await waitFor(() => expect(collectSwitch()).not.toBeNull());
    expect(sendNow()).not.toBeNull();
  });
});

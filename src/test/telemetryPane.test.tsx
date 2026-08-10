/**
 * The development-only controls in the Telemetry pane are not in a packaged build.
 *
 * There was no test for this, which is the wrong shape of gap for what it guards. The pane itself is
 * *meant* to be visible in a packaged build — collection has no opt-out, so being able to read every
 * record queued on your own machine is the whole of the transparency the README promises. What must
 * not appear there is the pair of controls beneath it: a switch that turns collection off and a
 * button that publishes on demand.
 *
 * The flag is computed in the **main process** (`devBuild = !app.isPackaged`) rather than in the
 * renderer, and the main process refuses `setCollecting` in a packaged build regardless — so hiding
 * these is defence in depth rather than the only thing standing between a user and an opt-out. It
 * still has to hold: a switch that appears and then silently refuses is worse than no switch.
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
     * The `installation` assertion is doing two jobs. It waits for the snapshot — asserting
     * "absent" immediately would pass before the flag had even arrived and prove nothing — and it
     * pins the other half of the requirement: the pane itself stays. Collection has no opt-out, so
     * being able to read the records queued on your own machine is the whole of the transparency
     * the README promises, and hiding it along with the controls would remove it.
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

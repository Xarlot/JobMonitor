/**
 * The renderer's view of the telemetry bridge.
 *
 * Follows the pattern already established by `src/storage/desktopSecret.ts` and
 * `desktopUpdates.ts`: probe for `window.desktop` once, and when it is absent every call is an
 * early return. That is what makes the GitHub Pages build inert — not a flag, not a config value,
 * but the structural absence of anything to call.
 *
 * Both channels are `send`, never `invoke`. `preload.cjs` already states the reason for the
 * diagnostics log and it applies with more force here: a telemetry call must not be able to delay
 * or fail the thing it is describing, and an `invoke` returns a promise that some future caller
 * will inevitably await.
 */

export interface TelemetryDelta {
  /** [featureId, count] */
  features: [number, number][];
  /** [operationId, elapsedMs[]] — raw samples; the main process builds the histogram. */
  operations: [number, number[]][];
  /** [operationId, errorCategory] */
  failures: [number, number][];
}

export interface CrashReport {
  name: string;
  stack?: string;
  componentStack?: string;
  source: number;
}

interface TelemetryBridge {
  flush(delta: TelemetryDelta): void;
  crash(report: CrashReport): void;
}

interface DesktopWindow {
  desktop?: { telemetry?: TelemetryBridge };
}

function bridge(): TelemetryBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as DesktopWindow).desktop?.telemetry;
}

/**
 * Whether anything is collected at all.
 *
 * Computed per call rather than cached at module load so that tests can mount and unmount the
 * bridge, and so a preload that arrives late cannot leave the facade permanently disabled.
 */
export function isTelemetryAvailable(): boolean {
  return bridge() !== undefined;
}

export function sendDelta(delta: TelemetryDelta): void {
  try {
    bridge()?.flush(delta);
  } catch {
    // A failed IPC send must be indistinguishable from no telemetry at all.
  }
}

export function sendCrash(report: CrashReport): void {
  try {
    bridge()?.crash(report);
  } catch {
    /* see above — and this one runs inside an error handler, where throwing would be worse */
  }
}

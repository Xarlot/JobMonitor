/**
 * Read-only view of the local telemetry queue, for the Diagnostics tab.
 *
 * Same shape as `desktopSecret.ts` and `desktopUpdates.ts`: probe for the bridge, return `null`
 * when it is absent. In a browser tab there is no queue to read because nothing is collected.
 */

export interface SpoolRecord {
  /** Record format version. */
  v: number;
  /** Priority index — 0 crash, 1 failure, 2 usage. */
  p: number;
  /** When it was queued, epoch ms. */
  at: number;
  kind: string;
  body: unknown;
  priority: string;
}

export interface SpoolFileStats {
  bytes: number;
  records: number;
}

export interface SpoolStats {
  dir: string;
  disabled: boolean;
  dropped: number;
  files: Record<string, SpoolFileStats>;
}

export interface TelemetryMeta {
  installationId: string;
  appVersion: string;
  platform: string;
  arch: string;
  electronVersion: string;
  sendEnabled: boolean;
  /** A development build: collection is off by default and the controls below are shown. */
  devBuild: boolean;
  /** Whether anything is being recorded right now. Always true in a packaged build. */
  collecting: boolean;
  disabled: boolean;
  crashesThisSession: number;
}

export interface CollectingResult {
  ok: boolean;
  collecting: boolean;
  reason?: string;
}

export interface SendNowResult {
  ok: boolean;
  sent?: number;
  queued?: number;
  reason?: string;
}

export interface TelemetrySnapshot {
  available: boolean;
  records: SpoolRecord[];
  stats: SpoolStats | null;
  meta?: TelemetryMeta;
}

interface Bridge {
  read(): Promise<TelemetrySnapshot>;
  setCollecting(next: boolean): Promise<CollectingResult>;
  sendNow(): Promise<SendNowResult>;
}

function bridge(): Bridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { desktop?: { telemetry?: Bridge } }).desktop?.telemetry;
}

export async function readTelemetrySpool(): Promise<TelemetrySnapshot | null> {
  const api = bridge();
  if (!api?.read) return null;
  try {
    return await api.read();
  } catch {
    // A failed read is indistinguishable from no desktop bridge as far as this screen cares.
    return null;
  }
}

export async function setTelemetryCollecting(next: boolean): Promise<CollectingResult> {
  const api = bridge();
  if (!api?.setCollecting) return { ok: false, collecting: false, reason: 'no desktop bridge' };
  try {
    return await api.setCollecting(next);
  } catch (err) {
    return { ok: false, collecting: false, reason: String((err as Error)?.message ?? err) };
  }
}

export async function sendTelemetryNow(): Promise<SendNowResult> {
  const api = bridge();
  if (!api?.sendNow) return { ok: false, reason: 'no desktop bridge' };
  try {
    return await api.sendNow();
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err) };
  }
}

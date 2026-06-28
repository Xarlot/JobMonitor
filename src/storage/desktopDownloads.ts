/**
 * Bridge to the Electron shell's download saver (exposed on
 * `window.desktop.downloads`). In a plain browser the bridge is absent, so the
 * caller falls back to a normal browser download instead.
 */

interface DesktopDownloadsApi {
  save: (filename: string, data: Uint8Array) => Promise<string>;
  showInFolder: (fullPath: string) => Promise<boolean>;
}

interface DesktopBridge {
  isDesktop?: boolean;
  downloads?: DesktopDownloadsApi;
}

function bridge(): DesktopBridge | undefined {
  return (globalThis as unknown as { desktop?: DesktopBridge }).desktop;
}

/** True only in the desktop app, where downloads are saved + tracked by the app. */
export function canSaveToDisk(): boolean {
  return Boolean(bridge()?.isDesktop && bridge()?.downloads);
}

/** Write bytes to the OS Downloads folder; returns the saved path (or null on failure). */
export async function saveToDisk(filename: string, data: Uint8Array): Promise<string | null> {
  const api = bridge()?.downloads;
  if (!api) return null;
  try {
    return await api.save(filename, data);
  } catch {
    return null;
  }
}

/** Reveal a saved file in the OS file manager. */
export async function showInFolder(fullPath: string): Promise<void> {
  const api = bridge()?.downloads;
  if (!api) return;
  try {
    await api.showInFolder(fullPath);
  } catch {
    /* ignore */
  }
}

/**
 * Bridge to the Electron desktop shell's auto-update control
 * (`window.desktop.updates`). In a plain browser the bridge is absent, so
 * `autoUpdateSupported()` is false and `setAutoUpdateEnabled` is a no-op.
 */

interface UpdatesApi {
  supported: () => Promise<boolean>;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  setToken: (token: string | null) => Promise<boolean>;
}

function api(): UpdatesApi | undefined {
  return (globalThis as unknown as { desktop?: { updates?: UpdatesApi } }).desktop?.updates;
}

/** True only in the desktop app AND when this build/OS can self-update. */
export async function autoUpdateSupported(): Promise<boolean> {
  const u = api();
  if (!u) return false;
  try {
    return await u.supported();
  } catch {
    return false;
  }
}

/** Push the user's auto-update preference to the main process. */
export async function setAutoUpdateEnabled(enabled: boolean): Promise<void> {
  const u = api();
  if (!u) return;
  try {
    await u.setEnabled(enabled);
  } catch {
    /* ignore */
  }
}
export async function setUpdateToken(token: string | null): Promise<void> {
  const u = api();
  if (!u?.setToken) return;
  try {
    await u.setToken(token);
  } catch {
    /* ignore */
  }
}

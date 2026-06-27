/**
 * Bridge to the Electron desktop shell's OS-keychain "remember password" store
 * (exposed on `window.desktop.secret`). In a plain browser the bridge is absent,
 * so every call is a safe no-op and the app behaves exactly as before.
 */

interface DesktopSecretApi {
  available: () => Promise<boolean>;
  get: () => Promise<string | null>;
  set: (value: string) => Promise<boolean>;
  clear: () => Promise<boolean>;
}

interface DesktopBridge {
  isDesktop?: boolean;
  secret?: DesktopSecretApi;
}

function bridge(): DesktopBridge | undefined {
  return (globalThis as unknown as { desktop?: DesktopBridge }).desktop;
}

export function isDesktop(): boolean {
  return Boolean(bridge()?.isDesktop);
}

/** True only in the desktop app AND when the OS keychain is usable. */
export async function canRememberSecret(): Promise<boolean> {
  const api = bridge()?.secret;
  if (!api) return false;
  try {
    return await api.available();
  } catch {
    return false;
  }
}

export async function rememberSecret(value: string): Promise<boolean> {
  const api = bridge()?.secret;
  if (!api) return false;
  try {
    return await api.set(value);
  } catch {
    return false;
  }
}

export async function recallSecret(): Promise<string | null> {
  const api = bridge()?.secret;
  if (!api) return null;
  try {
    return await api.get();
  } catch {
    return null;
  }
}

export async function forgetSecret(): Promise<void> {
  const api = bridge()?.secret;
  if (!api) return;
  try {
    await api.clear();
  } catch {
    /* ignore */
  }
}

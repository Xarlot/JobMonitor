'use strict';

/**
 * Minimal, sandboxed preload. Exposes a tiny read-only marker so the web app can
 * tell it's running inside the desktop shell (e.g. notifications are always
 * available here — Electron grants the Notification permission by default).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  // OS-keychain-backed "remember password" (see main.cjs registerSecretIpc).
  secret: {
    available: () => ipcRenderer.invoke('secret:available'),
    get: () => ipcRenderer.invoke('secret:get'),
    set: (value) => ipcRenderer.invoke('secret:set', value),
    clear: () => ipcRenderer.invoke('secret:clear'),
  },
  // Auto-update control (see main.cjs registerUpdateIpc).
  updates: {
    supported: () => ipcRenderer.invoke('updates:supported'),
    setEnabled: (enabled) => ipcRenderer.invoke('updates:setEnabled', enabled),
    setToken: (token) => ipcRenderer.invoke('updates:setToken', token),
  },
  // Local `gh` + `claude` CLIs, for triaging a failed job (see claudeBridge.cjs).
  // Desktop only, and only ever on an explicit click — it sends log text to the
  // user's own Claude CLI.
  claude: {
    probe: () => ipcRenderer.invoke('claude:probe'),
    analyze: (payload) => ipcRenderer.invoke('claude:analyze', payload),
    /** A pull request's title and description, from material the renderer supplies. */
    compose: (payload) => ipcRenderer.invoke('claude:compose', payload),
    cancel: (requestId) => ipcRenderer.invoke('claude:cancel', requestId),
    /** The whole run's failed-step log via `gh`, for the log viewer (see runLog). */
    runLog: (payload) => ipcRenderer.invoke('claude:runLog', payload),
    /**
     * Phase + streaming-output events for the progress dialog. Returns an
     * unsubscribe; only the payload is forwarded, never the IpcRendererEvent, so no
     * privileged object crosses the bridge.
     */
    onProgress: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('claude:progress', handler);
      return () => ipcRenderer.removeListener('claude:progress', handler);
    },
    /**
     * Main-process diagnostics — the argv it spawned, exit codes, stderr — so what `gh`
     * and `claude` actually did is readable in the renderer's DevTools console instead of
     * only in the terminal that launched the app. Same shape as onProgress: payload only,
     * returns an unsubscribe.
     */
    onLog: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('claude:log', handler);
      return () => ipcRenderer.removeListener('claude:log', handler);
    },
  },
  /**
   * The on-disk diagnostics log (see electron/runLog.cjs). `write` is fire-and-forget so a
   * log line can never delay or fail the thing it is describing.
   */
  logs: {
    path: () => ipcRenderer.invoke('logs:path'),
    reveal: () => ipcRenderer.invoke('logs:reveal'),
    write: (scope, message, detail) => ipcRenderer.send('logs:write', { scope, message, detail }),
    read: (maxBytes) => ipcRenderer.invoke('logs:read', maxBytes),
  },
  // Save already-fetched bytes to the Downloads folder (see registerDownloadIpc).
  downloads: {
    save: (filename, data) => ipcRenderer.invoke('downloads:save', { filename, data }),
    showInFolder: (fullPath) => ipcRenderer.invoke('downloads:showInFolder', fullPath),
  },
});

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
  },
  // Save already-fetched bytes to the Downloads folder (see registerDownloadIpc).
  downloads: {
    save: (filename, data) => ipcRenderer.invoke('downloads:save', { filename, data }),
    showInFolder: (fullPath) => ipcRenderer.invoke('downloads:showInFolder', fullPath),
  },
});

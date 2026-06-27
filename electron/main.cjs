'use strict';

/**
 * Electron main process for the Job Monitor desktop app.
 *
 *  - Bundles the built Vite SPA (dist/) and serves it over a privileged `app://`
 *    origin, so the page CSP behaves like https (`'self'` resolves, api.github.com
 *    stays allowed) instead of the quirky file:// origin.
 *  - Lives in the system tray: closing the window hides it; the app keeps polling
 *    in the background (backgroundThrottling off) so notifications still fire.
 *  - Auto-updates from GitHub Releases via electron-updater.
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  ipcMain,
  protocol,
  nativeImage,
  safeStorage,
  screen,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { autoUpdater } = require('electron-updater');
const windowState = require('./windowState.cjs');

const APP_ID = 'com.devexpress.javajobmonitor'; // must match electron-builder appId
const DIST = path.join(__dirname, '..', 'dist');
const TRAY_ICON = path.join(__dirname, 'tray.png');
const isDev = !app.isPackaged;
// Set to the Vite dev server (e.g. http://localhost:5173) for live HMR; when
// unset the app loads the bundled build over app://.
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const REPO_URL = 'https://github.com/DevExpress/JavaJobMonitor';

let mainWindow = null;
let tray = null;
app.isQuitting = false;

// Single instance: focus the existing window instead of launching a second copy.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  // Must be called before app `ready`.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID); // Windows: needed for notifications + taskbar identity
    Menu.setApplicationMenu(null); // remove the default shell menu bar (File/Edit/View…)
    registerAppProtocol();
    registerSecretIpc();
    createWindow();
    createTray();
    setupAutoUpdate();

    app.on('activate', () => (mainWindow ? showWindow() : createWindow()));
  });

  // Keep running in the tray after the window is closed; quit only explicitly.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    app.isQuitting = true;
    persistWindowState(); // final flush in case a debounced save is pending
  });
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    let filePath = path.normalize(path.join(DIST, pathname));
    // Block path traversal outside the bundled dist.
    if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(DIST, 'index.html'); // SPA fallback
    }
    const ext = path.extname(filePath).toLowerCase();
    return new Response(fs.readFileSync(filePath), {
      headers: { 'content-type': MIME[ext] || 'application/octet-stream' },
    });
  });
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // getNormalBounds() = restored bounds (ignores maximize), so we can re-apply
  // both the size and the maximized flag on next launch.
  const b = mainWindow.getNormalBounds();
  windowState.save(stateFile(), { ...b, isMaximized: mainWindow.isMaximized() });
}

function createWindow() {
  // Restore last bounds, validated against the *current* displays so the window
  // can't reopen off-screen (e.g. a monitor was unplugged or resolution changed).
  const saved = windowState.load(stateFile());
  const { x, y, width, height, isMaximized } = windowState.computeBounds(
    saved,
    screen.getAllDisplays(),
  );

  mainWindow = new BrowserWindow({
    x, // undefined when the saved position isn't visible -> Electron centers it
    y,
    width,
    height,
    minWidth: windowState.MIN_W,
    minHeight: windowState.MIN_H,
    show: false,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true, // no menu bar (revealed with Alt if a menu existed)
    icon: fs.existsSync(TRAY_ICON) ? TRAY_ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep polling/notifications alive when hidden in tray
    },
  });

  if (isMaximized) mainWindow.maximize();

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL); // live Vite dev server (HMR)
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('app://bundle/index.html'); // bundled build
  }
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Persist position/size (debounced) as the user moves/resizes the window.
  const debouncedPersist = debounce(persistWindowState, 400);
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) {
    mainWindow.on(ev, debouncedPersist);
  }

  // Open external links (GitHub, etc.) in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides it to the tray instead of quitting.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Minimizing also tucks the window into the tray instead of the taskbar.
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function showAbout() {
  const detail = [
    `Version: ${app.getVersion()}`,
    `Electron: ${process.versions.electron}`,
    `Chromium: ${process.versions.chrome}`,
    `Node: ${process.versions.node}`,
    `Platform: ${process.platform}-${process.arch}`,
    '',
    'A GitHub Actions PR & workflow dashboard.',
    `Repository: ${REPO_URL}`,
  ].join('\n');

  dialog
    .showMessageBox(mainWindow ?? undefined, {
      type: 'info',
      title: 'About Job Monitor',
      message: 'Job Monitor',
      detail,
      icon: nativeImage.createFromPath(TRAY_ICON),
      buttons: ['Open repository', 'Releases', 'Report an issue', 'Close'],
      defaultId: 3,
      cancelId: 3,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === 0) shell.openExternal(REPO_URL);
      else if (response === 1) shell.openExternal(`${REPO_URL}/releases`);
      else if (response === 2) shell.openExternal(`${REPO_URL}/issues`);
    })
    .catch(() => {});
}

function createTray() {
  const image = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Job Monitor');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Job Monitor', click: showWindow },
      { label: 'Check for updates…', click: () => autoUpdater.checkForUpdates().catch(() => {}) },
      { label: 'About', click: showAbout },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  // Left-click toggles the window (Windows/Linux); macOS shows the menu.
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() && mainWindow.isFocused() ? mainWindow.hide() : showWindow();
  });
}

// --- "Remember password on this device" ------------------------------------
// Stores the unlock passphrase encrypted by the OS keychain (safeStorage), tied
// to the current OS user. The renderer recalls it on launch to auto-unlock.
function secretFile() {
  return path.join(app.getPath('userData'), 'remembered.bin');
}

function registerSecretIpc() {
  ipcMain.handle('secret:available', () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  });
  ipcMain.handle('secret:get', () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(fs.readFileSync(secretFile()));
    } catch {
      return null; // no file / wrong OS user / corrupt
    }
  });
  ipcMain.handle('secret:set', (_e, value) => {
    try {
      if (!safeStorage.isEncryptionAvailable() || typeof value !== 'string') return false;
      fs.writeFileSync(secretFile(), safeStorage.encryptString(value));
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('secret:clear', () => {
    try {
      fs.rmSync(secretFile(), { force: true });
    } catch {
      /* ignore */
    }
    return true;
  });
}

function setupAutoUpdate() {
  if (isDev) return; // updater needs a packaged app + published GitHub releases
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Downloads in the background and shows a native notification when ready;
  // installs on the next quit.
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 60 * 60 * 1000);
}

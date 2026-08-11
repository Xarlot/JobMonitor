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
  Notification,
  protocol,
  nativeImage,
  safeStorage,
  screen,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { autoUpdater } = require('electron-updater');
const windowState = require('./windowState.cjs');
const { resolveAppAsset } = require('./appAssets.cjs');
const { registerClaudeIpc } = require('./claudeBridge.cjs');
const { initRunLog, logEvent, readRunLogTail, runLogDir, runLogPath } = require('./runLog.cjs');

const APP_ID = 'com.devexpress.javajobmonitor'; // must match electron-builder appId
const DIST = path.join(__dirname, '..', 'dist');
/*
 * Two icons, not one.
 *
 * The tray draws its icon *on* the panel, so it gets the mark alone on transparency
 * (`build/tray.svg`). Everywhere the icon appears inside a frame of its own — window and taskbar,
 * notifications, the About dialog — gets the full app tile, because a bare mark there reads as a
 * missing icon rather than as a minimal one.
 *
 * These were the same file until the tray showed it: the tile's dark rounded square looks pasted on
 * a light panel, all but disappears on a dark one, and at 16px leaves the mark about ten pixels to
 * be legible in.
 */
const TRAY_ICON = path.join(__dirname, 'tray.png');
const APP_ICON = path.join(__dirname, 'appicon.png');
const isDev = !app.isPackaged;
// Set to the Vite dev server (e.g. http://localhost:5173) for live HMR; when
// unset the app loads the bundled build over app://.
const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const REPO_URL = 'https://github.com/DevExpress/JavaJobMonitor';
/** Tail handed to the in-app log viewer when it doesn't ask for a specific size. */
const DEFAULT_LOG_TAIL_BYTES = 512 * 1024;
// The app's own repo (for auto-update). It's an internal/private repo, so the
// updater must authenticate with the user's token (see configureUpdaterFeed).
const UPDATE_OWNER = 'DevExpress';
const UPDATE_REPO = 'JavaJobMonitor';
// Auto-update is only possible in a packaged build whose format supports self-
// update: NSIS (Windows), dmg/zip (macOS), AppImage (Linux). A .deb install is
// managed by apt and a dev run isn't packaged — so those can't auto-update.
const CAN_AUTO_UPDATE =
  app.isPackaged && (process.platform !== 'linux' || Boolean(process.env.APPIMAGE));

let mainWindow = null;
let tray = null;
app.isQuitting = false;

/**
 * Feature ids used from this file, mirroring packages/telemetry-schema/src/registry/features.ts.
 *
 * Restated rather than imported because the registry lives in the bundled ESM telemetry module and
 * this file is CommonJS. That is safe in one direction only: the main process validates every id
 * against the real registry before recording it, so a number that drifts here is silently dropped
 * rather than stored under the wrong name.
 */
const FEATURE = {
  APP_LAUNCHED: 100,
  APP_SECOND_INSTANCE: 101,
  WINDOW_SHOWN: 102,
  WINDOW_HIDDEN_TO_TRAY: 103,
  TRAY_MENU_OPENED: 104,
  UPDATE_CHECK_MANUAL: 108,
  UPDATE_INSTALLED: 109,
};

/** Operation ids, mirrored from the same registry and validated there just as the features are. */
const OPERATION = {
  APP_STARTUP: 1300,
  UPDATE_DOWNLOAD: 1304,
};

/** Mirrors CrashSource in the telemetry wire schema (packages/telemetry-schema). */
const CRASH_SOURCE = {
  MAIN_UNCAUGHT: 1,
  MAIN_REJECTION: 2,
  RENDERER_GONE: 3,
  CHILD_PROCESS_GONE: 7,
};

/**
 * Fatal-error capture, installed at module load so that a throw during `whenReady` — which is most
 * of the interesting ones — is still recorded.
 *
 * These handlers only *observe*. Electron registers its own `uncaughtException` listener in the
 * main process, and Node invokes every registered listener, so adding one here is additive: the
 * app's existing behaviour (error dialog, keep running) is unchanged. That matters more than it
 * might seem — a telemetry handler that accidentally suppressed a fatal error dialog would be a
 * regression in the app, introduced by the code that was supposed to be measuring it.
 */
process.on('uncaughtException', (error) => {
  recordFatal(error, CRASH_SOURCE.MAIN_UNCAUGHT);
});
process.on('unhandledRejection', (reason) => {
  recordFatal(reason, CRASH_SOURCE.MAIN_REJECTION);
});

function recordFatal(error, source) {
  try {
    const name = error instanceof Error ? error.name : typeof error;
    // Sizes and shapes, never the message — the same contract runLog.cjs already keeps.
    logEvent('telemetry', 'fatal', { source, name });
    telemetry?.recordMainCrash({
      name,
      stack: error instanceof Error ? error.stack : undefined,
      source,
    });
  } catch {
    // A crash handler that throws turns one failure into two.
  }
}

// Single instance: focus the existing window instead of launching a second copy.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    telemetry?.featureUsed(FEATURE.APP_SECOND_INSTANCE);
    showWindow();
  });

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
    registerUpdateIpc();
    // Before anything that might want to log. The path is printed because a diagnostics
    // file nobody can find is no better than no diagnostics file.
    const logFile = initRunLog(path.join(app.getPath('userData'), 'logs'));
    console.log(`[job-monitor] diagnostics log: ${logFile}`);
    logEvent('app', 'started', {
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      packaged: app.isPackaged,
    });

    registerDownloadIpc();
    registerLogIpc();
    registerClaudeIpc(ipcMain);
    initTelemetry();
    registerTelemetryIpc();
    telemetry?.featureUsed(FEATURE.APP_LAUNCHED);
    // Measured from process start, not from `whenReady`: what a person waits through is the whole
    // launch, and `process.uptime()` is the only clock that was running before this file was.
    telemetry?.operationCompleted(OPERATION.APP_STARTUP, process.uptime() * 1000);
    createWindow();
    createTray();
    setupAutoUpdate();

    // A GPU or utility process dying. Rarely fatal to the app, so it is recorded at failure
    // priority rather than competing with real crashes for room in the queue.
    app.on('child-process-gone', (_event, details) => {
      if (details?.reason === 'clean-exit') return;
      telemetry?.recordProcessCrash({
        exceptionType: `ChildProcessGone.${details?.type ?? 'unknown'}`,
        detail: `type=${details?.type ?? 'unknown'} reason=${details?.reason ?? 'unknown'}`,
        source: CRASH_SOURCE.CHILD_PROCESS_GONE,
        priority: 'failure',
      });
    });

    app.on('activate', () => (mainWindow ? showWindow() : createWindow()));
  });

  // Keep running in the tray after the window is closed; quit only explicitly.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    app.isQuitting = true;
    persistWindowState(); // final flush in case a debounced save is pending
    shutdownTelemetry(); // marks the session clean and flushes counters; never sends
  });
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const resolved = resolveAppAsset(decodeURIComponent(url.pathname), DIST);
    if (resolved.status === 403) return new Response('Forbidden', { status: 403 });

    // A JS or CSS request that fell through to index.html is a real fault — most likely a
    // chunk the build renamed — and it presents as a blank window otherwise, because the
    // browser will not execute HTML as a module. Say so where it can be found afterwards.
    if (resolved.fallback && /\.(js|mjs|css)$/i.test(url.pathname)) {
      logEvent('desktop', `WARN: no bundled asset for ${url.pathname}; served index.html`);
    }

    return new Response(fs.readFileSync(resolved.filePath), {
      headers: { 'content-type': resolved.contentType },
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
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
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

  // Foreground time, tracked from the main process.
  //
  // `document.visibilityState` in the renderer is not authoritative here: the app lives in the
  // tray and keeps polling with the window hidden (backgroundThrottling is off, below), and the
  // platforms disagree about what visibility means for a tray-hidden window. `isVisible()` and
  // the focus events do not.
  mainWindow.on('focus', () => telemetry?.windowFocused());
  mainWindow.on('blur', () => telemetry?.windowBlurred());
  mainWindow.on('hide', () => telemetry?.windowBlurred());
  mainWindow.on('minimize', () => telemetry?.windowBlurred());
  mainWindow.on('show', () => {
    telemetry?.featureUsed(FEATURE.WINDOW_SHOWN);
    if (mainWindow?.isFocused()) telemetry?.windowFocused();
  });

  // A renderer that died — OOM, a GPU fault, a killed process. There is no stack to collect, so
  // the reason and exit code are the fingerprint.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logEvent('telemetry', 'renderer gone', details);
    telemetry?.recordProcessCrash({
      exceptionType: `RenderProcessGone.${details?.reason ?? 'unknown'}`,
      detail: `reason=${details?.reason ?? 'unknown'} exitCode=${details?.exitCode ?? -1}`,
      source: CRASH_SOURCE.RENDERER_GONE,
    });
  });

  // Not fatal, but the thing users actually report as "it froze".
  mainWindow.on('unresponsive', () => {
    logEvent('telemetry', 'window unresponsive', {});
    telemetry?.recordProcessCrash({
      exceptionType: 'WindowUnresponsive',
      detail: 'window',
      source: CRASH_SOURCE.CHILD_PROCESS_GONE,
      priority: 'failure',
    });
  });

  // DevTools on F12 (and the conventional Ctrl/Cmd+Shift+I).
  //
  // Needed explicitly because the app menu is removed above, and the default accelerators
  // live on that menu — without it there is no way to open DevTools in a packaged build.
  // Scoped to this window's input rather than a globalShortcut, which would take F12 away
  // from every other app on the machine.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isInspect =
      (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';
    if (!isF12 && !isInspect) return;
    event.preventDefault();
    const wc = mainWindow.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  });

  // Open external links (GitHub, etc.) in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides it to the tray instead of quitting.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      // Hiding to the tray rather than quitting is the behaviour people either love or are
      // surprised by, and how often it happens says which.
      telemetry?.featureUsed(FEATURE.WINDOW_HIDDEN_TO_TRAY);
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
      icon: nativeImage.createFromPath(APP_ICON),
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

/*
 * **This is why `electron` is pinned below 43 in package.json.**
 *
 * Chromium 150 (Electron 43) rewrote the StatusNotifierItem implementation. On Cinnamon the result is
 * that the icon renders as the icon theme's missing-image placeholder *and the menu below never
 * opens* — so a tray-resident app whose window is hidden has no interface at all, not even Exit.
 *
 * 42 registers the item under a unique bus name with its menu at `/com/canonical/dbusmenu`; 43
 * registers `org.freedesktop.StatusNotifierItem-<pid>-1` with `/org/chromium/DbusMenu/1`. Both publish
 * the same icon in the same way, so the icon file is not involved — the old icon reproduces the
 * placeholder under 43. Neither passing a path here instead of a `nativeImage`, nor calling
 * `setImage` again after registration, makes any difference; both were tried against the real bus.
 *
 * `src/test/trayIcon.test.ts` fails if the dependency range is ever widened to allow 43, because the
 * next routine dependency sweep will otherwise take it and the symptom appears only on a desktop
 * nobody runs the tests on.
 */
function createTray() {
  const image = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Job Monitor');
  tray.on('right-click', () => telemetry?.featureUsed(FEATURE.TRAY_MENU_OPENED));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Job Monitor', click: showWindow },
      {
        label: 'Check for updates…',
        click: () => {
          telemetry?.featureUsed(FEATURE.UPDATE_CHECK_MANUAL);
          checkForUpdatesManual();
        },
      },
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

// Saves already-fetched bytes to the OS Downloads folder. The renderer does the
// network fetch + (for bundles) the zip building, then hands us the finished
// bytes — so the in-app downloads panel owns the progress UI and we just persist.
/**
 * The renderer's own diagnostics, persisted alongside the main process's.
 *
 * Without this the file tells half the story: the log fetch, the cache hits and the API
 * failures all happen in the renderer, and those are exactly what the last few
 * investigations turned on.
 */
function registerLogIpc() {
  ipcMain.handle('logs:path', () => ({ file: runLogPath(), dir: runLogDir() }));
  ipcMain.handle('logs:reveal', () => {
    const dir = runLogDir();
    if (dir) shell.openPath(dir);
    return dir;
  });
  ipcMain.on('logs:write', (_e, payload) => {
    const { scope, message, detail } = payload ?? {};
    if (typeof message !== 'string') return;
    logEvent(typeof scope === 'string' ? `renderer:${scope}` : 'renderer', message, detail);
  });
  // Read-only, and only ever the app's own log file — the path is not a parameter.
  ipcMain.handle('logs:read', (_e, maxBytes) => readRunLogTail(maxBytes ?? DEFAULT_LOG_TAIL_BYTES));
}

/**
 * Anonymous usage and crash telemetry (see docs/telemetry.md).
 *
 * The implementation lives in `electron/telemetry.bundle.mjs`, built from `electron/telemetry/**`
 * by `vite.telemetry.config.ts`. It is ESM and this file is CJS, hence the dynamic import — which
 * is also why every entry point below tolerates the module not being there yet, or at all: a dev
 * checkout that has not run `npm run build` simply has no telemetry, and that must not be an error.
 *
 * Nothing here is on a path the app awaits. A failure to load, initialise or record is a log line
 * and nothing more.
 */
let telemetry = null;

function initTelemetry() {
  try {
    // Synchronous: the bundle is CJS and self-contained, so telemetry is ready the moment this
    // returns and no delta can arrive before it exists.
    const mod = require('./telemetry.bundle.cjs');
    telemetry = mod.initTelemetry({
      dir: path.join(app.getPath('userData'), 'telemetry'),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      // Dev runs and the Playwright screenshot scripts accumulate locally but never publish.
      // With ~50 installations, developer noise would otherwise dominate the dataset.
      send: app.isPackaged,
      onLog: logEvent,
      sanitizeContext: {
        home: os.homedir(),
        userData: app.getPath('userData'),
        username: os.userInfo().username,
      },
    });
    if (!telemetry) return;
    telemetry.start();
    logEvent('telemetry', 'ready', {
      installation: telemetry.installationId,
      send: app.isPackaged,
    });
  } catch (err) {
    // A checkout that has not run `npm run build` simply has no telemetry. That must not be an
    // error, and it must never stop the app from starting.
    telemetry = null;
    logEvent('telemetry', 'WARN: unavailable', { message: String(err?.message ?? err) });
  }
}

function shutdownTelemetry() {
  try {
    telemetry?.shutdown();
  } catch {
    // A quit must never be blocked, or made to fail, by telemetry.
  }
  telemetry = null;
}

/**
 * Two channels, both `send` rather than `invoke`.
 *
 * `preload.cjs` already gives the reason for the diagnostics log — fire-and-forget, so a log line
 * can never delay or fail the thing it describes — and it applies with more force here. An
 * `invoke` hands back a promise that some future caller will eventually await, at which point
 * telemetry is on the critical path of a feature.
 */
function registerTelemetryIpc() {
  ipcMain.on('telemetry:flush', (_e, delta) => {
    telemetry?.ingestDelta(delta);
  });

  /**
   * Read-only view of what is queued locally, for Settings -> Diagnostics -> Telemetry.
   *
   * `invoke` rather than `send` here, unlike the two recording channels: this one is a UI request
   * whose answer is the whole point, and it is never on a path the app awaits during normal work.
   */
  ipcMain.handle('telemetry:read', () => {
    if (!telemetry) return { records: [], stats: null, available: false };
    return { ...telemetry.readSpool(), meta: telemetry.stats(), available: true };
  });

  /**
   * Development-only controls, surfaced in Settings -> Diagnostics -> Telemetry.
   *
   * `invoke` rather than `send`: both are user actions whose outcome is displayed, and neither is
   * on a path the app awaits during normal work. The main process refuses the toggle in a packaged
   * build, so this cannot become an opt-out by way of the renderer.
   */
  ipcMain.handle('telemetry:setCollecting', (_e, next) => {
    if (!telemetry) return { ok: false, collecting: false, reason: 'telemetry unavailable' };
    return telemetry.setCollecting(next);
  });

  ipcMain.handle('telemetry:sendNow', async () => {
    if (!telemetry) return { ok: false, reason: 'telemetry unavailable' };
    return telemetry.sendNow();
  });

  ipcMain.on('telemetry:crash', (_e, report) => {
    if (!telemetry) return;
    const { name, stack, componentStack, source } = report ?? {};
    if (typeof name !== 'string') return;
    telemetry.recordRendererCrash({ name, stack, componentStack, source });
  });
}

function registerDownloadIpc() {
  ipcMain.handle('downloads:save', (_e, payload) => {
    const { filename, data } = payload ?? {};
    if (typeof filename !== 'string' || !data) throw new Error('bad download payload');
    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    // Avoid clobbering: name.zip -> name (1).zip -> name (2).zip …
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    let target = path.join(dir, filename);
    for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${stem} (${n})${ext}`);
    fs.writeFileSync(target, Buffer.from(data));
    return target;
  });
  ipcMain.handle('downloads:showInFolder', (_e, fullPath) => {
    if (typeof fullPath === 'string' && fullPath) shell.showItemInFolder(fullPath);
    return true;
  });
}

// True while a *user-initiated* check is in flight, so we only pop "no update"/
// "error" dialogs for manual checks (background checks stay quiet).
let manualUpdateCheck = false;
// Background auto-update on/off, driven by the renderer's config setting.
let autoUpdateEnabled = false;
let autoUpdateTimer = null;
// The user's GitHub token, pushed from the renderer (updates:setToken). Required
// because the app repo is internal: the anonymous release feed 404s without it.
let updateToken = null;

/**
 * Point the updater at the internal app repo authenticated with the user's token.
 * Without a token it falls back to the default (anonymous) feed, which 404s.
 */
function configureUpdaterFeed() {
  autoUpdater.allowPrerelease = true; // releases are published as pre-releases
  if (!updateToken) return false;
  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: UPDATE_OWNER,
      repo: UPDATE_REPO,
      private: true, // use the authenticated GitHub API instead of releases.atom
      token: updateToken,
    });
    return true;
  } catch {
    return false;
  }
}

function info(title, message, detail) {
  return dialog.showMessageBox(mainWindow ?? undefined, { type: 'info', title, message, detail });
}

function notify(title, body) {
  try {
    new Notification({ title, body, icon: APP_ICON }).show();
  } catch {
    /* notifications unavailable; ignore */
  }
}

function setupAutoUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // fallback if we quit before install

  // Fully automatic: no "update available" prompt — download, then install &
  // restart on completion. A user-initiated check gets a brief heads-up.
  autoUpdater.on('update-available', (i) => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      notify('Updating Job Monitor', `Downloading version ${i.version}…`);
    }
  });
  autoUpdater.on('update-not-available', () => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      info('No updates', 'You’re on the latest version.', `Version ${app.getVersion()}.`);
    }
  });
  autoUpdater.on('error', (err) => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'error',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: String((err && err.message) || err),
      });
    }
  });
  let updateDownloadStartedAt = null;
  autoUpdater.on('update-available', () => {
    updateDownloadStartedAt = Date.now();
  });
  autoUpdater.on('update-downloaded', (i) => {
    if (updateDownloadStartedAt != null) {
      telemetry?.operationCompleted(OPERATION.UPDATE_DOWNLOAD, Date.now() - updateDownloadStartedAt);
      updateDownloadStartedAt = null;
    }
    notify('Updating Job Monitor', `Installing version ${i.version} and restarting…`);
    app.isQuitting = true;
    // Let the notification surface, then quit & install (relaunches the app).
    telemetry?.featureUsed(FEATURE.UPDATE_INSTALLED);
    setTimeout(() => autoUpdater.quitAndInstall(), 1500);
  });
}

/** Start/stop background update checks based on env support + setting + token. */
function applyAutoUpdatePolicy() {
  // No token => the authenticated feed isn't available yet; don't 404 in a loop.
  const active = CAN_AUTO_UPDATE && autoUpdateEnabled && Boolean(updateToken);
  if (active && !autoUpdateTimer) {
    configureUpdaterFeed();
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    autoUpdateTimer = setInterval(() => {
      configureUpdaterFeed();
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  } else if (!active && autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
}

function registerUpdateIpc() {
  // Renderer asks whether auto-update is even possible in this environment.
  ipcMain.handle('updates:supported', () => CAN_AUTO_UPDATE);
  // Renderer pushes the config setting on load and whenever it changes.
  ipcMain.handle('updates:setEnabled', (_e, enabled) => {
    autoUpdateEnabled = Boolean(enabled);
    applyAutoUpdatePolicy();
    return CAN_AUTO_UPDATE;
  });
  // Renderer pushes the user's token after unlock (null on lock/forget).
  ipcMain.handle('updates:setToken', (_e, token) => {
    updateToken = typeof token === 'string' && token ? token : null;
    applyAutoUpdatePolicy(); // a check can now run once the token arrives
    return CAN_AUTO_UPDATE;
  });
}

/** Tray "Check for updates…" — always runs and reports the result or the error. */
function checkForUpdatesManual() {
  manualUpdateCheck = true;
  // The app repo is internal, so a token is required to read its releases.
  if (!updateToken) {
    manualUpdateCheck = false;
    info(
      'Sign in to check for updates',
      'Updates need your GitHub token.',
      'Unlock Job Monitor with your token, then try again. (The internal app repo ' +
        'can’t be read without authentication.)',
    );
    return;
  }
  if (isDev) {
    // Run against the real GitHub releases even unpackaged, so the button is testable.
    autoUpdater.forceDevUpdateConfig = true;
  }
  configureUpdaterFeed();
  autoUpdater.checkForUpdates().catch((err) => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'error',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: String((err && err.message) || err),
      });
    }
  });
}

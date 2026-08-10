/*
 * Primer's design tokens, as CSS custom properties.
 *
 * Primer 36 carried these in a JavaScript theme object that styled-components read; 38 ships plain
 * CSS and expects the application to load them. Two separate things are needed and it is not
 * obvious: `primitives.css` defines the sizes, radii, typography and font stacks, while the colours
 * live only in the per-theme files. Importing the themes alone leaves every `--base-size-*` and
 * `--text-*-size-*` undefined — the app renders in the right colours with no spacing at all.
 *
 * Only the two schemes this app actually offers are loaded. Each theme is scoped to the
 * `data-light-theme` / `data-dark-theme` value it belongs to, so importing `dark.css` while the
 * provider asks for `dark_dimmed` matches nothing and the dark mode silently renders light.
 */
import '@primer/primitives/dist/css/primitives.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark-dimmed.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppThemeProvider } from './context/ThemeContext';
import { AuthProvider } from './context/AuthContext';
import { ConfigProvider } from './context/ConfigContext';
import { DownloadsProvider } from './context/DownloadsContext';
import { isMockMode } from './mocks/mockMode';
import { setFetchImpl } from './api/githubClient';
import { ErrorBoundary } from './components/ErrorBoundary';
import { devLog, installDevLogControls } from './lib/devLog';
import { forwardClaudeLogsToConsole } from './storage/desktopClaude';
import { CrashSource, Operation, Telemetry } from './lib/telemetry';

// Clickjacking guard: GitHub Pages can't send frame-ancestors/X-Frame-Options,
// and a <meta> CSP frame-ancestors is ignored. Bust out of any framing.
if (window.self !== window.top) {
  try {
    window.top!.location.href = window.self.location.href;
  } catch {
    document.documentElement.style.display = 'none';
  }
}

/**
 * Catch what the React error boundary cannot: throws from event handlers, timers, and async code
 * outside the component tree, plus unhandled promise rejections.
 *
 * Both handlers only observe — no `preventDefault`, no swallowing — so the console still shows
 * exactly what it would have without them. On the hosted build `Telemetry.reportCrash` is a no-op,
 * so this costs two listeners and nothing else.
 */
function installCrashHandlers() {
  window.addEventListener('error', (event) => {
    const error = event.error;
    Telemetry.reportCrash({
      name: error instanceof Error ? error.name : 'ErrorEvent',
      stack: error instanceof Error ? error.stack : undefined,
      source: CrashSource.WINDOW_ERROR,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    Telemetry.reportCrash({
      name: reason instanceof Error ? reason.name : 'UnhandledRejection',
      stack: reason instanceof Error ? reason.stack : undefined,
      source: CrashSource.RENDERER_REJECTION,
    });
  });
}

async function bootstrap() {
  // Before anything else, so the console says how to turn diagnostics on and the
  // main process's own lines land there too (DevTools: F12).
  installDevLogControls();
  forwardClaudeLogsToConsole((message, detail) => devLog('desktop', message, detail));
  installCrashHandlers();

  // In mock mode, route the GitHub client through fixtures instead of the network.
  if (isMockMode()) {
    const { mockFetch } = await import('./mocks/mockFetch');
    setFetchImpl(mockFetch);
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('#root not found');

  // From module evaluation to the first render call. It does not include React's own first paint,
  // which cannot be observed from here — but it does include every import above, which is the part
  // that grows silently as the app gains dependencies.
  Telemetry.operationCompleted(Operation.RENDERER_BOOT, performance.now());
  createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <AppThemeProvider>
          <ConfigProvider>
            <AuthProvider>
              <DownloadsProvider>
                <App />
              </DownloadsProvider>
            </AuthProvider>
          </ConfigProvider>
        </AppThemeProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();

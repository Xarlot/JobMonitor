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

// Clickjacking guard: GitHub Pages can't send frame-ancestors/X-Frame-Options,
// and a <meta> CSP frame-ancestors is ignored. Bust out of any framing.
if (window.self !== window.top) {
  try {
    window.top!.location.href = window.self.location.href;
  } catch {
    document.documentElement.style.display = 'none';
  }
}

async function bootstrap() {
  // In mock mode, route the GitHub client through fixtures instead of the network.
  if (isMockMode()) {
    const { mockFetch } = await import('./mocks/mockFetch');
    setFetchImpl(mockFetch);
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('#root not found');

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

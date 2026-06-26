import React from 'react';
import { createRoot } from 'react-dom/client';
import { BaseStyles, ThemeProvider } from '@primer/react';
import { App } from './App';
import { AuthProvider } from './context/AuthContext';
import { ConfigProvider } from './context/ConfigContext';
import { isMockMode } from './mocks/mockMode';
import { setFetchImpl } from './api/githubClient';
import { ErrorBoundary } from './components/ErrorBoundary';

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
        <ThemeProvider colorMode="auto">
          <BaseStyles>
            <ConfigProvider>
              <AuthProvider>
                <App />
              </AuthProvider>
            </ConfigProvider>
          </BaseStyles>
        </ThemeProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();

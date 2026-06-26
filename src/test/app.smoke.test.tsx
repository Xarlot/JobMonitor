import { fireEvent, render, screen } from '@testing-library/react';
import { BaseStyles, ThemeProvider } from '@primer/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../context/AuthContext';
import { ConfigProvider } from '../context/ConfigContext';
import { setFetchImpl } from '../api/githubClient';
import { mockFetch } from '../mocks/mockFetch';

/**
 * Mounts the full component tree under Primer in mock mode. Catches runtime
 * wiring problems (provider/context misuse, bad Primer props) that typechecking
 * alone won't surface.
 */
describe('App smoke', () => {
  beforeAll(() => {
    vi.stubEnv('VITE_MOCK', '1');
    setFetchImpl(mockFetch as unknown as typeof fetch);
  });

  it('renders Overview and navigates to PRs and Flows', async () => {
    render(
      <ThemeProvider>
        <BaseStyles>
          <ConfigProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ConfigProvider>
        </BaseStyles>
      </ThemeProvider>,
    );

    // Overview is the default tab: a tile per PR (by name) and per flow.
    expect(await screen.findByText('Job Monitor')).toBeInTheDocument();
    expect(await screen.findByText('Fix fuel mixture calc')).toBeInTheDocument(); // PR tile
    expect(await screen.findByText('CI')).toBeInTheDocument(); // flow tile

    // Navigate to the Flows tab and confirm the master-detail grid renders.
    fireEvent.click(screen.getByRole('link', { name: /Flows/ }));
    expect(await screen.findByText('workflow_dispatch')).toBeInTheDocument();
  });
});

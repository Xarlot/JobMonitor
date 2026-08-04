/**
 * The confirmation gate in front of a destructive, outward-facing action. What is asserted
 * here is mostly what must *not* happen: no request before the confirm, no button at all
 * without write capability or when there is nothing to arm.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import type { PullRequest } from '../api/types';

const armAutoMerge = vi.fn();
vi.mock('../api/autoMerge', () => ({
  armAutoMerge: (...args: unknown[]) => armAutoMerge(...args),
}));

const capability = { canRerun: true };
vi.mock('../hooks/useTokenCapability', () => ({ useTokenCapability: () => capability }));

import { AutoMergeButton, AutoMergeLabel, toMergeMethod } from '../components/AutoMergeButton';
import { ConfigProvider } from '../context/ConfigContext';

const ARMED = {
  enabled_by: { login: 'Xarlotee', avatar_url: '', html_url: '' },
  merge_method: 'squash' as const,
  commit_title: null,
  commit_message: null,
};

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 1,
    node_id: 'PR_kwDOtest',
    number: 41763,
    title: 'Fix compilation',
    html_url: 'https://github.com/o/r/pull/41763',
    state: 'open',
    draft: false,
    body: 'why this change exists',
    user: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-03T00:00:00Z',
    auto_merge: null,
    merged_at: null,
    head: { sha: 'abc1234', ref: 'fix-compilation', label: 'o:fix', user: null },
    base: { ref: 'main', repo: { full_name: 'o/r' } },
    ...over,
  };
}

function renderButton(over: Partial<PullRequest> = {}, onArmed = vi.fn()) {
  render(
    <ThemeProvider>
      <BaseStyles>
        <ConfigProvider>
          <AutoMergeButton owner="o" repo="r" pr={pr(over)} onArmed={onArmed} />
        </ConfigProvider>
      </BaseStyles>
    </ThemeProvider>,
  );
  return onArmed;
}

const open = () => fireEvent.click(screen.getByLabelText(/Arm auto-merge/));

describe('toMergeMethod', () => {
  /** Config stores lower-case; the GraphQL enum is upper-case, and a mismatch 400s. */
  it('upper-cases the setting for GraphQL', () => {
    expect(toMergeMethod('squash')).toBe('SQUASH');
    expect(toMergeMethod('merge')).toBe('MERGE');
    expect(toMergeMethod('rebase')).toBe('REBASE');
  });
});

describe('AutoMergeButton', () => {
  beforeEach(() => {
    localStorage.clear();
    armAutoMerge.mockReset();
    capability.canRerun = true;
  });

  it('is absent when the token cannot write', () => {
    capability.canRerun = false;
    renderButton();
    expect(screen.queryByLabelText(/Arm auto-merge/)).toBeNull();
  });

  /** GitHub errors on an already-armed PR, so offering it would only produce one. */
  it('is absent when auto-merge is already armed', () => {
    renderButton({ auto_merge: ARMED });
    expect(screen.queryByLabelText(/Arm auto-merge/)).toBeNull();
  });

  it('is absent for a PR that is not open', () => {
    renderButton({ state: 'closed' });
    expect(screen.queryByLabelText(/Arm auto-merge/)).toBeNull();
  });

  /** The whole point of the dialog: nothing reaches GitHub on the first click. */
  it('asks before touching anything, showing what it will delete', () => {
    renderButton();
    open();
    expect(screen.getByText(/cannot be recovered/i)).toBeTruthy();
    expect(screen.getByText('why this change exists')).toBeTruthy();
    expect(armAutoMerge).not.toHaveBeenCalled();
  });

  it('arms on confirmation and reports success', async () => {
    armAutoMerge.mockResolvedValue({ descriptionCleared: true, autoMergeEnabled: true });
    const onArmed = renderButton();
    open();
    fireEvent.click(screen.getByRole('button', { name: /Clear description and arm/ }));

    await waitFor(() => expect(screen.getByText(/Auto-merge armed \(squash\)/)).toBeTruthy());
    expect(armAutoMerge).toHaveBeenCalledWith('o', 'r', expect.objectContaining({ number: 41763 }), 'SQUASH');
    expect(onArmed).toHaveBeenCalledTimes(1);
  });

  /**
   * The half-done outcome has to read differently from a clean failure — the description is
   * gone in one case and untouched in the other.
   */
  it('says the description is already gone when only arming failed', async () => {
    armAutoMerge.mockResolvedValue({
      descriptionCleared: true,
      autoMergeEnabled: false,
      error: 'Auto merge is disabled',
    });
    const onArmed = renderButton();
    open();
    fireEvent.click(screen.getByRole('button', { name: /Clear description and arm/ }));

    await waitFor(() =>
      expect(screen.getByText(/description was cleared, but auto-merge was not armed/i)).toBeTruthy(),
    );
    expect(onArmed).not.toHaveBeenCalled();
  });

  it('says nothing was changed when the description could not be cleared', async () => {
    armAutoMerge.mockResolvedValue({
      descriptionCleared: false,
      autoMergeEnabled: false,
      error: 'PR is locked',
    });
    renderButton();
    open();
    fireEvent.click(screen.getByRole('button', { name: /Clear description and arm/ }));

    await waitFor(() => expect(screen.getByText(/Nothing was changed: PR is locked/)).toBeTruthy());
  });

  it('does not offer to delete a description that is already empty', () => {
    renderButton({ body: '   ' });
    open();
    expect(screen.getByText(/already empty/i)).toBeTruthy();
    expect(screen.queryByText(/cannot be recovered/i)).toBeNull();
  });
});

/**
 * An absent control explains nothing — which is exactly what sent someone looking for the
 * button on a PR that already had auto-merge on.
 */
describe('AutoMergeLabel', () => {
  function renderLabel(over: Partial<PullRequest> = {}) {
    render(
      <ThemeProvider>
        <BaseStyles>
          <AutoMergeLabel pr={pr(over)} />
        </BaseStyles>
      </ThemeProvider>,
    );
  }

  it('renders nothing for a PR that is not armed', () => {
    renderLabel();
    expect(screen.queryByText('auto-merge')).toBeNull();
  });

  it('marks an armed PR, naming the strategy and who armed it', () => {
    renderLabel({ auto_merge: ARMED });
    expect(screen.getByText('auto-merge')).toBeTruthy();

    const id = screen.getByRole('button').getAttribute('aria-describedby');
    const tip = document.getElementById(id as string)?.textContent ?? '';
    expect(tip).toContain('squash');
    expect(tip).toContain('Xarlotee');
  });

  /** The state is worth knowing even for a token that could not change it. */
  it('shows the state regardless of write capability', () => {
    capability.canRerun = false;
    renderLabel({ auto_merge: ARMED });
    expect(screen.getByText('auto-merge')).toBeTruthy();
  });
});

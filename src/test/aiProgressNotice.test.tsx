import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { AiProgressNotice } from '../components/AiProgressNotice';
import { IDLE_TRIAGE, type TriageState } from '../hooks/useClaudeTriage';
import type { ClaudeDepth } from '../lib/claudePrompt';

function state(over: Partial<TriageState> = {}): TriageState {
  return { ...IDLE_TRIAGE, running: true, phase: 'analysing', startedAt: Date.now(), ...over };
}

function renderNotice(
  running: { depth: ClaudeDepth; state: TriageState }[],
  onStop: (depth: ClaudeDepth) => void = () => {},
) {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <AiProgressNotice running={running} onStop={onStop} />
      </BaseStyles>
    </ThemeProvider>,
  );
}

describe('AiProgressNotice', () => {
  /**
   * The strip exists because these two tasks start on their own; when nothing is running it must
   * leave no furniture behind, or the top of the view carries a permanent empty bar.
   */
  it('renders nothing when nothing is running', () => {
    const { container } = renderNotice([]);
    expect(container.textContent).toBe('');
  });

  it('names the task and how long it has been going', () => {
    renderNotice([{ depth: 'cause', state: state() }]);
    expect(screen.getByText('Working out what failed')).toBeTruthy();
    expect(screen.getByText(/^\d+s$/)).toBeTruthy();
  });

  /** Both automatic tasks can be in flight at once — the cause and the map of the same failure. */
  it('lists a row per running task', () => {
    renderNotice([
      { depth: 'cause', state: state() },
      { depth: 'marks', state: state() },
    ]);
    expect(screen.getByText('Working out what failed')).toBeTruthy();
    expect(screen.getByText('Mapping the log')).toBeTruthy();
  });

  /**
   * The newest tool call, and only that one: this is a strip, not the feed. Showing the whole
   * trail here would push the panes down the screen while the run went on.
   */
  it('shows the last thing Claude did', () => {
    renderNotice([
      { depth: 'cause', state: state({ activity: ['$ gh run view 1', 'read report.trx'] }) },
    ]);
    expect(screen.getByText('read report.trx')).toBeTruthy();
    expect(screen.queryByText('$ gh run view 1')).toBeNull();
  });

  /** The phase is where the time is actually going, in the strip's shorter words. */
  it('says which phase it is in', () => {
    renderNotice([{ depth: 'cause', state: state({ phase: 'fetching-log', logCached: true }) }]);
    expect(screen.getByText('· reading the log')).toBeTruthy();
  });

  /**
   * Stop has to be here, because with no dialog there is nowhere else for it: an automatic call is
   * exactly the one a reader is most likely to want to abandon.
   */
  it('stops the task it belongs to', () => {
    const stopped: ClaudeDepth[] = [];
    renderNotice(
      [
        { depth: 'cause', state: state() },
        { depth: 'marks', state: state() },
      ],
      (depth) => stopped.push(depth),
    );
    const buttons = screen.getAllByRole('button', { name: 'Stop' });
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(stopped).toEqual(['marks']);
  });

  /** A run with no reported phase and no activity yet still has to render. */
  it('copes with a run that has only just started', () => {
    expect(() =>
      renderNotice([{ depth: 'cause', state: state({ phase: null, startedAt: null }) }]),
    ).not.toThrow();
  });
});

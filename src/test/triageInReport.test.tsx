import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from '../context/ConfigContext';
import { useClaudeTriage } from '../hooks/useClaudeTriage';
import { analysisKey, claudeAnalysisCache } from '../storage/failureCaches';
import type { ClaudeDepth } from '../lib/claudePrompt';

const KEY = 'pr:48310:91164948690';

/**
 * The smallest thing that can catch this: the flag has to be read the way the view reads it —
 * through `stateFor`, during render — because the defect was never in the value. It was that
 * nothing re-rendered to go and look at it.
 */
function Harness({ depth }: { depth: ClaudeDepth }) {
  const triage = useClaudeTriage();
  const state = triage.stateFor(KEY, depth);
  return (
    <div>
      <span data-testid="flag">{state.inReport ? 'carried' : 'omitted'}</span>
      <button type="button" onClick={() => triage.setInReport(KEY, depth, !state.inReport)}>
        toggle
      </button>
    </div>
  );
}

function renderHarness(depth: ClaudeDepth = 'quick') {
  return render(
    <ConfigProvider>
      <Harness depth={depth} />
    </ConfigProvider>,
  );
}

describe('carrying a result into the report', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MOCK', '1');
    claudeAnalysisCache.clear();
  });

  /**
   * The bug, exactly as reported: "Add to the report" did nothing.
   *
   * A result restored from the week-long cache has no live entry — which is the common case, since
   * that cache is what makes reopening yesterday's failure free. The write went to the cache and
   * React was told nothing, so the button sat unchanged and the report stayed as it was, until some
   * unrelated render happened to pick the new value up a poll later.
   */
  it('updates the screen when the result came from the cache', () => {
    claudeAnalysisCache.set(analysisKey(KEY, 'quick'), {
      problem: 'The up-converter changed the page margins.',
      solution: 'Widen the tolerance.',
      failures: '<<<FAILURES>>>\n- kind: assertion\n  what: upConverterKeepsMargins',
    });

    renderHarness();
    expect(screen.getByTestId('flag')).toHaveTextContent('omitted');

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('flag')).toHaveTextContent('carried');

    // And it is written through, so the choice survives a remount — it expires with the analysis
    // it belongs to rather than with the component.
    expect(claudeAnalysisCache.get(analysisKey(KEY, 'quick'))?.inReport).toBe(true);
  });

  it('takes it back out again', () => {
    claudeAnalysisCache.set(analysisKey(KEY, 'quick'), {
      problem: 'x',
      solution: 'y',
      inReport: true,
    });

    renderHarness();
    expect(screen.getByTestId('flag')).toHaveTextContent('carried');
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('flag')).toHaveTextContent('omitted');
    expect(claudeAnalysisCache.get(analysisKey(KEY, 'quick'))?.inReport).toBe(false);
  });

  /** The same path serves the task that owned this button before the quick read could. */
  it('works for the cause task too', () => {
    claudeAnalysisCache.set(analysisKey(KEY, 'cause'), {
      problem: '',
      solution: '',
      document: '<<<FAILURES>>>\ncause: three pages differ',
    });

    renderHarness('cause');
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('flag')).toHaveTextContent('carried');
  });

  /** Nothing stored, nothing to carry: the click is a no-op rather than inventing an entry. */
  it('does nothing when there is no result at all', () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('flag')).toHaveTextContent('omitted');
    expect(claudeAnalysisCache.get(analysisKey(KEY, 'quick'))).toBeUndefined();
  });
});

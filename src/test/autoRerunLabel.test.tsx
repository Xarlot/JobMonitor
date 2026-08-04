import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import type { AutoRerunState } from '../hooks/usePrAutoRerun';

const state: AutoRerunState = { events: [], idleReason: 'armed' };
vi.mock('../context/AutoRerunContext', () => ({ useAutoRerun: () => state }));

import { AutoRerunLabel } from '../components/AutoRerunLabel';

type Event = AutoRerunState['events'][number];

function event(over: Partial<Event> = {}): Event {
  return {
    id: `${over.attempt ?? 1}`,
    at: Date.parse('2026-08-03T16:14:40Z'),
    prNumber: 41763,
    prTitle: 'Fix compilation',
    runId: 30619940666,
    runUrl: 'https://github.com/o/r/actions/runs/1',
    workflowFile: 'check-pull-request.yml',
    attempt: 3,
    outcome: 'requested',
    ...over,
  };
}

function renderLabel(prNumber = 41763) {
  return render(
    <ThemeProvider>
      <BaseStyles>
        <AutoRerunLabel prNumber={prNumber} />
      </BaseStyles>
    </ThemeProvider>,
  );
}

/** The hint lives in the accessible description, which is what TooltipV2 renders. */
function hint(): string {
  return screen.getByRole('button').getAttribute('aria-describedby')
    ? (document.getElementById(
        screen.getByRole('button').getAttribute('aria-describedby') as string,
      )?.textContent ?? '')
    : '';
}

describe('AutoRerunLabel', () => {
  beforeEach(() => {
    state.events = [];
    state.idleReason = 'armed';
  });

  /** A PR nothing has happened to must not carry a badge at all. */
  it('renders nothing without events for this PR', () => {
    renderLabel();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ignores events belonging to another PR', () => {
    state.events = [event({ prNumber: 99 })];
    renderLabel(41763);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('counts the re-runs it made for this PR', () => {
    state.events = [event({ attempt: 5 }), event({ attempt: 4 }), event({ attempt: 3 })];
    renderLabel();
    expect(screen.getByText('re-run ×3')).toBeTruthy();
  });

  it('lists each attempt in the hint, newest first', () => {
    state.events = [event({ attempt: 4, id: 'b' }), event({ attempt: 3, id: 'a' })];
    renderLabel();
    const text = hint();
    expect(text).toContain('#41763');
    expect(text).toContain('attempt 4 → 5');
    expect(text).toContain('attempt 3 → 4');
    expect(text.indexOf('attempt 4 → 5')).toBeLessThan(text.indexOf('attempt 3 → 4'));
  });

  it('separates failed requests from successful ones', () => {
    state.events = [
      event({ attempt: 4, outcome: 'failed', detail: 'HTTP 403', id: 'b' }),
      event({ attempt: 3, id: 'a' }),
    ];
    renderLabel();
    expect(screen.getByText('re-run ×1 · 1 failed')).toBeTruthy();
    expect(hint()).toContain('HTTP 403');
  });

  /**
   * "Can't check, don't retry": the engine wanting to act and stopping itself is the one
   * refusal a person may need to do something about, so the cause is on the PR.
   */
  it('shows a held re-run with the reason it could not check', () => {
    state.events = [
      event({
        attempt: 6,
        outcome: 'held',
        detail: 'the run is marked failed but none of its 12 job(s) are',
      }),
    ];
    renderLabel();
    expect(screen.getByText('1 unchecked')).toBeTruthy();
    const text = hint();
    expect(text).toContain('held off at attempt 6');
    expect(text).toContain('none of its 12 job(s) are');
  });

  it('counts re-runs and held attempts apart', () => {
    state.events = [
      event({ attempt: 6, outcome: 'held', detail: 'jobs could not be listed', id: 'c' }),
      event({ attempt: 5, id: 'b' }),
      event({ attempt: 4, id: 'a' }),
    ];
    renderLabel();
    expect(screen.getByText('re-run ×2 · 1 unchecked')).toBeTruthy();
  });

  /** "It re-ran twice then stopped" invites "why" — the answer belongs in the hint. */
  it('explains an idle engine in the hint', () => {
    state.events = [event()];
    state.idleReason = 'no-permission';
    renderLabel();
    expect(hint()).toContain('the token cannot re-run jobs');
  });

  it('says nothing about idleness while armed', () => {
    state.events = [event()];
    renderLabel();
    expect(hint()).not.toContain('Now idle');
  });
});

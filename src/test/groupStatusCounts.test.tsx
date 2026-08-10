/**
 * What a group header reports, and what it deliberately leaves out.
 *
 * Read at a glance to answer "is anything broken in here", so it counts only runs that
 * reached a verdict, and only the latest one per flow. Two things used to muddy that: the
 * Flows board aggregated every run it held (failure winning), so a flow that failed five
 * runs ago stayed red after passing since — and disagreed with the Overview, which showed
 * the same group from the latest run alone.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { GroupStatusCounts, groupVerdict, finalOnly } from '../components/GroupStatusCounts';
import type { RunConclusion, RunStatus, WorkflowRun } from '../api/types';

function run(status: RunStatus, conclusion: RunConclusion = null): WorkflowRun {
  return { id: 1, name: 'w', status, conclusion, run_number: 1 } as WorkflowRun;
}

describe('groupVerdict', () => {
  it('reports a verdict the latest run reached', () => {
    expect(groupVerdict([run('completed', 'success')])).toBe('success');
    expect(groupVerdict([run('completed', 'failure')])).toBe('failure');
  });

  /** The whole point: a run still going says nothing about pass or fail. */
  it('reports nothing while the latest run is unfinished', () => {
    expect(groupVerdict([run('in_progress')])).toBeNull();
    expect(groupVerdict([run('queued')])).toBeNull();
  });

  /** Cancelled and skipped finish without deciding anything either. */
  it('reports nothing for a run that ended without a verdict', () => {
    expect(groupVerdict([run('completed', 'cancelled')])).toBeNull();
    expect(groupVerdict([run('completed', 'skipped')])).toBeNull();
  });

  /**
   * The latest run alone. A re-run in progress hides the older failure rather than letting
   * it keep the group red — the group answers "how did it last end", not "has it ever failed".
   */
  /**
   * Falls back to the last run that finished — this used to assert the opposite.
   *
   * Skipping a mid-build flow entirely meant a group of three showed two verdicts, and the third
   * read as missing rather than as its last result. The tally is meant to answer "is anything broken
   * in here", and a flow that failed and is now rebuilding is still broken.
   */
  it('falls back to the last run that finished', () => {
    expect(groupVerdict([run('in_progress'), run('completed', 'failure')])).toBe('failure');
    expect(groupVerdict([run('queued'), run('completed', 'success')])).toBe('success');
  });

  /** Newer verdicts still win over older ones. */
  it('does not let an older verdict outrank a newer one', () => {
    expect(groupVerdict([run('completed', 'success'), run('completed', 'failure')])).toBe('success');
  });

  it('reports nothing for a flow with no runs', () => {
    expect(groupVerdict([])).toBeNull();
  });
});

describe('finalOnly', () => {
  it('keeps a verdict and drops everything else', () => {
    expect(finalOnly('success')).toBe('success');
    expect(finalOnly('failure')).toBe('failure');
    for (const s of ['in_progress', 'pending', 'neutral', 'unknown'] as const) {
      expect(finalOnly(s)).toBeNull();
    }
  });
});

describe('GroupStatusCounts', () => {
  const show = (verdicts: ('success' | 'failure' | null)[]) =>
    render(
      <ThemeProvider>
        <BaseStyles>
          <GroupStatusCounts verdicts={verdicts} />
        </BaseStyles>
      </ThemeProvider>,
    );

  it('tallies the verdicts', () => {
    show(['success', 'success', 'failure']);
    expect(screen.getByTitle('2 passed')).toBeInTheDocument();
    expect(screen.getByTitle('1 failed')).toBeInTheDocument();
  });

  it('shows nothing at all when nothing has a verdict', () => {
    // BaseStyles renders a wrapper, so the absence is asserted on the tally itself.
    show([null, null]);
    expect(screen.queryByTitle(/passed|failed/)).not.toBeInTheDocument();
  });

  /** No third colour for "something is happening" — the cards already show that. */
  it('omits the ones without a verdict rather than counting them', () => {
    show(['success', null, null]);
    expect(screen.getByTitle('1 passed')).toBeInTheDocument();
    expect(screen.queryByTitle(/in progress/)).not.toBeInTheDocument();
  });
});

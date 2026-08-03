import { describe, expect, it } from 'vitest';
import { needsChecks, type PrEntry } from '../hooks/useGitHubDashboard';
import type { CheckRun, CombinedStatus, OverallStatus, RunStatus } from '../api/types';

function check(status: RunStatus): CheckRun {
  return {
    id: Math.random(),
    name: 'c',
    status,
    conclusion: status === 'completed' ? 'success' : null,
    started_at: null,
    completed_at: null,
    html_url: null,
    details_url: null,
    app: null,
  };
}

function entry(over: Partial<PrEntry>): PrEntry {
  return {
    pr: { number: 1, head: { sha: 'a' } } as PrEntry['pr'],
    overall: 'in_progress',
    checkRuns: [],
    combined: null,
    checksUpdatedAt: Date.now(),
    checksError: null,
    watchUntil: null,
    ...over,
  };
}

describe('needsChecks', () => {
  it('fetches when never fetched', () => {
    expect(needsChecks(entry({ checksUpdatedAt: null }))).toBe(true);
  });

  it('keeps watching when no checks have appeared yet (unknown)', () => {
    expect(needsChecks(entry({ overall: 'unknown', checkRuns: [] }))).toBe(true);
  });

  /**
   * Plenty of PRs never get checks — docs-only changes, `paths` filters, checks
   * aged out. Watching those forever costs two requests per cycle each, for good.
   */
  it('gives up on a PR that never grew any checks', () => {
    const stale = entry({
      overall: 'unknown',
      checkRuns: [],
      checksUpdatedAt: Date.now() - 30 * 60_000,
    });
    expect(needsChecks(stale)).toBe(false);
  });

  /**
   * After a re-run request GitHub takes a few seconds to flip the checks back to
   * queued, so a finished-looking PR must stay watched through the window —
   * otherwise it re-reads as complete and freezes on the stale failure.
   */
  it('keeps polling a finished PR while its re-run watch window is open', () => {
    const rerunning = entry({
      overall: 'failure',
      checkRuns: [check('completed'), check('completed')],
      watchUntil: Date.now() + 60_000,
    });
    expect(needsChecks(rerunning)).toBe(true);
  });

  it('stops again once the watch window has expired', () => {
    const done = entry({
      overall: 'failure',
      checkRuns: [check('completed')],
      watchUntil: Date.now() - 1000,
    });
    expect(needsChecks(done)).toBe(false);
  });

  // Regression: a failed check sets the aggregate to `failure`, but other checks
  // are still running — polling MUST continue so they don't freeze at in_progress.
  it('keeps polling when a check is still running even though aggregate is failure', () => {
    const e = entry({
      overall: 'failure' as OverallStatus,
      checkRuns: [check('completed'), check('in_progress')],
    });
    expect(needsChecks(e)).toBe(true);
  });

  it('stops once every check-run is completed', () => {
    const e = entry({
      overall: 'failure' as OverallStatus,
      checkRuns: [check('completed'), check('completed')],
    });
    expect(needsChecks(e)).toBe(false);
  });

  it('keeps polling while the commit-status rollup is pending', () => {
    const combined: CombinedStatus = { state: 'pending', total_count: 2, sha: 'a', statuses: [] };
    expect(needsChecks(entry({ overall: 'failure', checkRuns: [check('completed')], combined }))).toBe(
      true,
    );
  });

  it('does not poll on an empty combined status (total_count 0)', () => {
    const combined: CombinedStatus = { state: 'pending', total_count: 0, sha: 'a', statuses: [] };
    expect(needsChecks(entry({ overall: 'success', checkRuns: [check('completed')], combined }))).toBe(
      false,
    );
  });
});

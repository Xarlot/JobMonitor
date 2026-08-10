/**
 * A flow reports the last result it reached, not what it is doing now.
 *
 * Two reports drove this. First a group read *pending* while everything in it had finished — the
 * status was an aggregate over the runs a flow held, and that ranks failure first and unfinished
 * ahead of finished. Then a group read *in progress* and showed fewer verdicts than it had flows,
 * because the rule had become "the newest run" and a flow mid-build therefore had no verdict to
 * contribute.
 *
 * Both come from the same mistake: treating a list of runs as one thing. They are independent
 * attempts, and the useful question is "how did this last come out", which only a *finished* run
 * answers. Aggregation is still right for the check-runs of a commit, where the parts really are
 * parts of one whole.
 */

import { describe, expect, it } from 'vitest';
import { latestFinalStatus } from '../lib/status';
import type { RunConclusion, RunStatus } from '../api/types';

const run = (status: RunStatus, conclusion: RunConclusion = null) => ({ status, conclusion });

describe('latestFinalStatus', () => {
  /** The second report: a flow mid-build still has a last result, and it is the one to show. */
  it('reports the last finished run while a newer one is still going', () => {
    expect(latestFinalStatus([run('in_progress'), run('completed', 'success')])).toBe('success');
    expect(latestFinalStatus([run('queued'), run('completed', 'failure')])).toBe('failure');
  });

  /** The first report: an older unfinished run must not drag a finished newer one to pending. */
  it('ignores an older unfinished run behind a finished one', () => {
    expect(latestFinalStatus([run('completed', 'success'), run('queued')])).toBe('success');
  });

  it('does not let an older failure outrank a newer pass', () => {
    expect(latestFinalStatus([run('completed', 'success'), run('completed', 'failure')])).toBe(
      'success',
    );
  });

  /**
   * Only *unfinished* runs are skipped. A flow that failed and is rebuilding still reads as failed
   * until the rebuild says otherwise — anything else would hide a break for as long as CI is busy.
   */
  it('keeps reporting a failure while the rebuild is in flight', () => {
    expect(latestFinalStatus([run('in_progress'), run('completed', 'failure')])).toBe('failure');
  });

  it('counts a cancelled or skipped run as finished', () => {
    expect(latestFinalStatus([run('completed', 'cancelled')])).toBe('neutral');
    expect(latestFinalStatus([run('in_progress'), run('completed', 'skipped')])).toBe('neutral');
  });

  it('answers unknown when nothing has finished yet', () => {
    expect(latestFinalStatus([])).toBe('unknown');
    expect(latestFinalStatus([run('queued'), run('in_progress')])).toBe('unknown');
  });
});

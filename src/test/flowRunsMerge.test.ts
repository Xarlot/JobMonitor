import { describe, expect, it } from 'vitest';
import { mergeRunResponses, STALE_LIMIT, type RunsQuery } from '../lib/flowRunsMerge';
import type { WorkflowRun } from '../api/types';

/** Run `n` was created `n` hours after a fixed origin, so a higher number is newer. */
function run(n: number, over: Partial<WorkflowRun> = {}): WorkflowRun {
  const at = new Date(Date.UTC(2026, 8, 1) + n * 3_600_000).toISOString();
  return {
    id: 1000 + n,
    name: 'Java Cron',
    display_title: 'Java Cron',
    head_branch: 'main',
    head_sha: 'sha',
    run_number: n,
    run_attempt: 1,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
    html_url: '',
    created_at: at,
    updated_at: at,
    run_started_at: null,
    ...over,
  };
}

const dispatch: RunsQuery = { branch: 'main', event: 'workflow_dispatch' };
const numbers = (runs: WorkflowRun[]) => runs.map((r) => r.run_number);

describe('mergeRunResponses', () => {
  it('takes the response when nothing is held yet', () => {
    const { runs, stale } = mergeRunResponses([], [{ query: dispatch, runs: [run(316), run(315)] }], 5, new Map());
    expect(numbers(runs)).toEqual([316, 315]);
    expect(stale).toEqual([]);
  });

  it('takes a newer response, dropping runs that fell off the end', () => {
    const held = [run(315), run(314), run(313)];
    const { runs } = mergeRunResponses(held, [{ query: dispatch, runs: [run(316), run(315), run(314)] }], 3, new Map());
    expect(numbers(runs)).toEqual([316, 315, 314]);
  });

  it('ignores a days-old snapshot and keeps what it holds', () => {
    const held = [run(316), run(315), run(314)];
    const streaks = new Map<string, number>();
    const { runs, stale } = mergeRunResponses(held, [{ query: dispatch, runs: [run(291), run(289), run(288)] }], 3, streaks);
    expect(numbers(runs)).toEqual([316, 315, 314]);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ streak: 1, accepted: false });
    expect(stale[0].newestReceived?.run_number).toBe(291);
  });

  it('treats an empty answer for a query with runs as stale', () => {
    const held = [run(316)];
    const { runs, stale } = mergeRunResponses(held, [{ query: dispatch, runs: [] }], 5, new Map());
    expect(numbers(runs)).toEqual([316]);
    expect(stale[0].newestReceived).toBeNull();
  });

  it('keeps ignoring a stale backend that answers many times running', () => {
    const streaks = new Map<string, number>();
    let current = [run(316), run(315)];
    for (let i = 1; i <= STALE_LIMIT + 2; i++) {
      const result = mergeRunResponses(current, [{ query: dispatch, runs: [run(291)] }], 5, streaks);
      current = result.runs;
      expect(numbers(current)).toEqual([316, 315]);
      expect(result.stale[0]).toMatchObject({ streak: i, accepted: false, needsCheck: i >= STALE_LIMIT });
    }
  });

  it('believes the response once the newest held run is known to be deleted', () => {
    const streaks = new Map<string, number>([[`main\u0000workflow_dispatch`, STALE_LIMIT]]);
    const { runs, stale } = mergeRunResponses([run(316), run(315)], [{ query: dispatch, runs: [run(315)] }], 5, streaks, new Set([1316]));
    expect(numbers(runs)).toEqual([315]);
    expect(stale[0]).toMatchObject({ accepted: true, needsCheck: false });
    expect(streaks.size).toBe(0);
  });

  it('resets the streak once a fresh answer arrives', () => {
    const streaks = new Map<string, number>();
    mergeRunResponses([run(316)], [{ query: dispatch, runs: [run(291)] }], 5, streaks);
    mergeRunResponses([run(316)], [{ query: dispatch, runs: [run(316)] }], 5, streaks);
    expect(streaks.size).toBe(0);
  });

  it('keeps the later copy of a run present in both', () => {
    const finished = run(316, { status: 'completed', conclusion: 'failure', updated_at: '2026-10-01T09:07:00Z' });
    const building = run(316, { status: 'in_progress', conclusion: null, updated_at: '2026-10-01T08:30:00Z' });
    const { runs } = mergeRunResponses([finished], [{ query: dispatch, runs: [building] }], 5, new Map());
    expect(runs[0].status).toBe('completed');
  });

  it('takes a newer copy of a held run', () => {
    const building = run(316, { status: 'in_progress', conclusion: null, updated_at: '2026-10-01T08:30:00Z' });
    const finished = run(316, { status: 'completed', conclusion: 'failure', updated_at: '2026-10-01T09:07:00Z' });
    const { runs } = mergeRunResponses([building], [{ query: dispatch, runs: [finished] }], 5, new Map());
    expect(runs[0].status).toBe('completed');
  });

  it('keeps a query’s runs when its request failed, and judges each query on its own', () => {
    const push: RunsQuery = { branch: 'main', event: 'push' };
    const held = [run(320, { event: 'push' }), run(316), run(310, { event: 'push' })];
    const { runs } = mergeRunResponses(
      held,
      [
        { query: dispatch, runs: null },
        { query: push, runs: [run(321, { event: 'push' }), run(320, { event: 'push' })] },
      ],
      2,
      new Map(),
    );
    expect(numbers(runs)).toEqual([321, 320, 316]);
  });

  it('does not let another branch’s runs make a response look stale', () => {
    const held = [run(400, { head_branch: 'release' })];
    const { runs, stale } = mergeRunResponses(held, [{ query: dispatch, runs: [run(316)] }], 5, new Map());
    expect(numbers(runs)).toEqual([316]);
    expect(stale).toEqual([]);
  });
});

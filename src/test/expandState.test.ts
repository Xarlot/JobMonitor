import { describe, expect, it } from 'vitest';
import {
  collapseKey,
  reconcileExpandState,
  type FlowExpandState,
} from '../storage/expandStateStore';

const id = (id: number, run_attempt: number, head_sha: string) => ({ id, run_attempt, head_sha });

describe('reconcileExpandState', () => {
  it('keeps expanded runs whose collapse key is unchanged', () => {
    const prev: FlowExpandState = {
      expandedRunIds: [1],
      collapseKeys: { '1': '1:sha1' },
    };
    const { state, invalidatedRunIds } = reconcileExpandState(prev, [id(1, 1, 'sha1')]);
    expect(state.expandedRunIds).toEqual([1]);
    expect(invalidatedRunIds).toEqual([]);
  });

  it('drops expanded runs that no longer exist', () => {
    const prev: FlowExpandState = {
      expandedRunIds: [1, 2],
      collapseKeys: { '1': '1:sha1', '2': '1:sha2' },
    };
    const { state, invalidatedRunIds } = reconcileExpandState(prev, [id(1, 1, 'sha1')]);
    expect(state.expandedRunIds).toEqual([1]);
    expect(invalidatedRunIds).toEqual([]); // vanished, not "invalidated"
  });

  it('collapses + invalidates a run whose head_sha changed (new commit)', () => {
    const prev: FlowExpandState = {
      expandedRunIds: [1],
      collapseKeys: { '1': '1:sha1' },
    };
    const { state, invalidatedRunIds } = reconcileExpandState(prev, [id(1, 1, 'sha2')]);
    expect(state.expandedRunIds).toEqual([]);
    expect(invalidatedRunIds).toEqual([1]);
    expect(state.collapseKeys['1']).toBe('1:sha2');
  });

  it('collapses + invalidates a run that was re-run (run_attempt bumped)', () => {
    const prev: FlowExpandState = {
      expandedRunIds: [1],
      collapseKeys: { '1': '1:sha1' },
    };
    const { state, invalidatedRunIds } = reconcileExpandState(prev, [id(1, 2, 'sha1')]);
    expect(state.expandedRunIds).toEqual([]);
    expect(invalidatedRunIds).toEqual([1]);
  });

  it('collapse key is run_attempt:head_sha (status-independent)', () => {
    expect(collapseKey(id(5, 3, 'abc'))).toBe('3:abc');
  });
});

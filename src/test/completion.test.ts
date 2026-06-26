import { describe, expect, it } from 'vitest';
import {
  detectNewlyCompleted,
  prPhase,
  runConclusionLabel,
  runPhase,
  type Phase,
} from '../lib/completion';

/** Build a phase map from a {id: phase} record. */
function run<T extends { id: number; phase: Phase }>(
  prev: Map<number, boolean>,
  items: T[],
) {
  return detectNewlyCompleted(prev, items, (i) => i.id, (i) => i.phase);
}

describe('detectNewlyCompleted', () => {
  it('does not fire for items already complete on first sight (no startup flood)', () => {
    const { completed, next } = run(new Map(), [{ id: 1, phase: 'completed' }]);
    expect(completed).toEqual([]);
    expect(next.get(1)).toBe(true);
  });

  it('fires only on an observed active -> completed transition', () => {
    const a = run(new Map(), [{ id: 1, phase: 'active' }]);
    expect(a.completed).toEqual([]);
    const b = run(a.next, [{ id: 1, phase: 'completed' }]);
    expect(b.completed.map((i) => i.id)).toEqual([1]);
  });

  it('does not re-fire once already completed', () => {
    const a = run(new Map(), [{ id: 1, phase: 'active' }]);
    const b = run(a.next, [{ id: 1, phase: 'completed' }]);
    const c = run(b.next, [{ id: 1, phase: 'completed' }]);
    expect(c.completed).toEqual([]);
  });

  it('treats "unknown" as not-yet-seen and preserves prior known state', () => {
    // Active first, then a transient unknown, then completed -> still fires once.
    const a = run(new Map(), [{ id: 1, phase: 'active' }]);
    const b = run(a.next, [{ id: 1, phase: 'unknown' }]);
    expect(b.next.get(1)).toBe(false); // preserved as active
    const c = run(b.next, [{ id: 1, phase: 'completed' }]);
    expect(c.completed.map((i) => i.id)).toEqual([1]);
  });

  it('an item that is unknown then completed never fires (never seen active)', () => {
    const a = run(new Map(), [{ id: 1, phase: 'unknown' }]);
    const b = run(a.next, [{ id: 1, phase: 'completed' }]);
    expect(b.completed).toEqual([]);
  });
});

describe('prPhase', () => {
  it('is unknown until checks are fetched', () => {
    expect(prPhase('success', false)).toBe('unknown');
  });
  it('maps terminal aggregates to completed', () => {
    expect(prPhase('success', true)).toBe('completed');
    expect(prPhase('failure', true)).toBe('completed');
  });
  it('maps in-flight aggregates to active', () => {
    expect(prPhase('pending', true)).toBe('active');
    expect(prPhase('in_progress', true)).toBe('active');
  });
  it('ignores neutral / unknown (no finish worth announcing)', () => {
    expect(prPhase('neutral', true)).toBe('unknown');
    expect(prPhase('unknown', true)).toBe('unknown');
  });
});

describe('runPhase', () => {
  it('only "completed" is a finish', () => {
    expect(runPhase('completed')).toBe('completed');
    expect(runPhase('in_progress')).toBe('active');
    expect(runPhase('queued')).toBe('active');
  });
});

describe('runConclusionLabel', () => {
  it('maps conclusions to words', () => {
    expect(runConclusionLabel('success')).toBe('succeeded');
    expect(runConclusionLabel('failure')).toBe('failed');
    expect(runConclusionLabel('timed_out')).toBe('failed');
    expect(runConclusionLabel('cancelled')).toBe('was cancelled');
    expect(runConclusionLabel('skipped')).toBe('was skipped');
    expect(runConclusionLabel(null)).toBe('completed');
  });
});

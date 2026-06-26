import { describe, expect, it } from 'vitest';
import { parseLogLines, splitLogBySteps } from '../lib/logs';
import type { JobStep } from '../api/types';

const step = (number: number, started_at: string | null): JobStep => ({
  name: `step ${number}`,
  status: 'completed',
  conclusion: 'success',
  number,
  started_at,
  completed_at: null,
});

describe('parseLogLines', () => {
  it('splits timestamp from text', () => {
    const [a, b] = parseLogLines('2026-06-26T16:52:19.0000000Z hello\nno-timestamp line');
    expect(a.text).toBe('hello');
    expect(Number.isNaN(a.ts)).toBe(false);
    expect(b.text).toBe('no-timestamp line');
    expect(Number.isNaN(b.ts)).toBe(true);
  });
});

describe('splitLogBySteps', () => {
  const steps = [step(1, '2026-06-26T16:00:00Z'), step(2, '2026-06-26T16:05:00Z')];
  const log = [
    '2026-06-26T15:59:59Z setup line (before step 1)',
    '2026-06-26T16:00:30Z step1 line a',
    '2026-06-26T16:00:31Z step1 line b',
    'continuation without timestamp',
    '2026-06-26T16:06:00Z step2 line',
  ].join('\n');

  it('buckets lines into the latest started step', () => {
    const out = splitLogBySteps(log, steps);
    expect(out[1]).toContain('setup line (before step 1)');
    expect(out[1]).toContain('step1 line a');
    expect(out[1]).toContain('continuation without timestamp');
    expect(out[2]).toBe('step2 line');
  });

  it('returns empty when no steps have timestamps', () => {
    expect(splitLogBySteps(log, [step(1, null)])).toEqual({});
  });
});

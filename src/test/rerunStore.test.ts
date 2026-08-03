import { beforeEach, describe, expect, it } from 'vitest';
import { clearRerunRecords, loadRerunRecords, recordRerun } from '../storage/rerunStore';

const NOW = Date.parse('2026-07-31T12:00:00Z');
const DAY = 24 * 3600_000;

describe('rerunStore', () => {
  beforeEach(() => {
    clearRerunRecords();
  });

  it('starts empty', () => {
    expect(loadRerunRecords(NOW).size).toBe(0);
  });

  /**
   * The trigger is state-based, so this record is what stops a page reload from
   * re-POSTing for a run that was already handled.
   */
  it('remembers an attempt across a reload', () => {
    recordRerun(1001, { attempt: 1, fingerprint: 'abc', at: NOW, ok: true }, NOW);
    const record = loadRerunRecords(NOW).get(1001);
    expect(record?.attempts).toEqual([{ attempt: 1, fingerprint: 'abc', at: NOW, ok: true }]);
  });

  it('accumulates attempts in order', () => {
    recordRerun(1001, { attempt: 2, fingerprint: 'second', at: NOW, ok: true }, NOW);
    recordRerun(1001, { attempt: 1, fingerprint: 'first', at: NOW, ok: true }, NOW);
    expect(loadRerunRecords(NOW).get(1001)?.attempts.map((a) => a.attempt)).toEqual([1, 2]);
  });

  /** A retried rate-limit failure must not pile up duplicates for one attempt. */
  it('overwrites rather than duplicates the same attempt', () => {
    recordRerun(1001, { attempt: 1, fingerprint: 'x', at: NOW, ok: false, error: 'boom' }, NOW);
    recordRerun(1001, { attempt: 1, fingerprint: 'x', at: NOW + 100, ok: true }, NOW + 100);
    const attempts = loadRerunRecords(NOW).get(1001)?.attempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, ok: true });
  });

  it('keeps runs separate', () => {
    recordRerun(1, { attempt: 1, fingerprint: 'a', at: NOW, ok: true }, NOW);
    recordRerun(2, { attempt: 1, fingerprint: 'b', at: NOW, ok: true }, NOW);
    const all = loadRerunRecords(NOW);
    expect(all.size).toBe(2);
    expect(all.get(1)?.attempts[0].fingerprint).toBe('a');
    expect(all.get(2)?.attempts[0].fingerprint).toBe('b');
  });

  it('records a failed attempt with its error', () => {
    recordRerun(7, { attempt: 1, fingerprint: null, at: NOW, ok: false, error: 'too old' }, NOW);
    expect(loadRerunRecords(NOW).get(7)?.attempts[0]).toMatchObject({
      ok: false,
      error: 'too old',
    });
  });

  /** GitHub refuses re-runs past 30 days, so older records can never matter. */
  it('drops records past the 30-day TTL', () => {
    recordRerun(1001, { attempt: 1, fingerprint: 'old', at: NOW, ok: true }, NOW);
    expect(loadRerunRecords(NOW + 29 * DAY).size).toBe(1);
    expect(loadRerunRecords(NOW + 31 * DAY).size).toBe(0);
  });

  it('survives corrupt stored JSON', () => {
    localStorage.setItem('job-monitor.rerun', '{not json');
    expect(loadRerunRecords(NOW).size).toBe(0);
    // …and can still record afterwards.
    recordRerun(5, { attempt: 1, fingerprint: 'a', at: NOW, ok: true }, NOW);
    expect(loadRerunRecords(NOW).size).toBe(1);
  });

  it('ignores stored entries that are not records', () => {
    localStorage.setItem('job-monitor.rerun', JSON.stringify({ '1': null, '2': 'nope' }));
    expect(loadRerunRecords(NOW).size).toBe(0);
  });

  it('caps how many runs it remembers, keeping the most recent', () => {
    for (let i = 0; i < 520; i++) {
      recordRerun(i, { attempt: 1, fingerprint: 'f', at: NOW + i, ok: true }, NOW + i);
    }
    const all = loadRerunRecords(NOW + 1000);
    expect(all.size).toBe(500);
    expect(all.has(519)).toBe(true); // newest kept
    expect(all.has(0)).toBe(false); // oldest evicted
  });

  it('clears everything on demand', () => {
    recordRerun(1, { attempt: 1, fingerprint: 'a', at: NOW, ok: true }, NOW);
    clearRerunRecords();
    expect(loadRerunRecords(NOW).size).toBe(0);
  });
});

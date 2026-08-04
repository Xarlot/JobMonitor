import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRerunRecords,
  loadRerunRecords,
  recordDecline,
  recordRerun,
  rerunRequestCount,
} from '../storage/rerunStore';

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

/**
 * A decline is "we decided not to ask", which is not an attempt. Keeping the two apart is
 * what makes the re-run count readable and the reported reason true.
 */
describe('rerunStore declines', () => {
  beforeEach(() => {
    clearRerunRecords();
  });

  it('records a decline without inventing a re-run', () => {
    recordDecline(1001, { attempt: 3, reason: 'identical_failure', fingerprint: 'same', at: NOW }, NOW);
    const record = loadRerunRecords(NOW).get(1001);
    expect(record?.declined).toEqual({
      attempt: 3,
      reason: 'identical_failure',
      fingerprint: 'same',
      at: NOW,
    });
    expect(record?.attempts).toEqual([]);
    expect(rerunRequestCount(record)).toBe(0);
  });

  it('counts only the requests actually made', () => {
    recordRerun(1001, { attempt: 1, fingerprint: 'a', at: NOW, ok: true }, NOW);
    recordRerun(1001, { attempt: 2, fingerprint: 'b', at: NOW, ok: true }, NOW);
    recordDecline(1001, { attempt: 3, reason: 'identical_failure', fingerprint: 'b', at: NOW }, NOW);

    const record = loadRerunRecords(NOW).get(1001);
    expect(rerunRequestCount(record)).toBe(2);
    expect(record?.declined?.attempt).toBe(3);
  });

  it('keeps the attempts when a decline lands, and the decline when an attempt does', () => {
    recordRerun(1001, { attempt: 1, fingerprint: 'a', at: NOW, ok: true }, NOW);
    recordDecline(1001, { attempt: 2, reason: 'identical_failure', fingerprint: 'a', at: NOW }, NOW);
    recordRerun(1001, { attempt: 3, fingerprint: 'c', at: NOW, ok: true }, NOW);

    const record = loadRerunRecords(NOW).get(1001);
    expect(record?.attempts.map((a) => a.attempt)).toEqual([1, 3]);
    expect(record?.declined?.attempt).toBe(2);
  });

  it('supersedes an older decline rather than accumulating them', () => {
    recordDecline(1001, { attempt: 2, reason: 'identical_failure', fingerprint: 'a', at: NOW }, NOW);
    recordDecline(
      1001,
      { attempt: 3, reason: 'identical_failure', fingerprint: 'b', at: NOW + 100 },
      NOW + 100,
    );
    expect(loadRerunRecords(NOW).get(1001)?.declined?.attempt).toBe(3);
  });

  /**
   * Installs written before declines existed filed the identical-failure verdict as a
   * failed request, which overstated the re-run count and made the engine answer "already
   * re-run" about an attempt it never touched. Migrated on read so nobody has to clear
   * their storage.
   */
  it('migrates a legacy decline out of the attempt list', () => {
    localStorage.setItem(
      'job-monitor.rerun',
      JSON.stringify({
        '30619940666': {
          runId: 30619940666,
          updatedAt: NOW,
          attempts: [
            { attempt: 1, fingerprint: 'a62793be', at: NOW - 200, ok: true },
            { attempt: 2, fingerprint: '1c7a9266', at: NOW - 100, ok: true },
            {
              attempt: 3,
              fingerprint: '1c7a9266',
              at: NOW,
              ok: false,
              error: 'the failure repeated identically',
            },
          ],
        },
      }),
    );

    const record = loadRerunRecords(NOW).get(30619940666);
    expect(rerunRequestCount(record)).toBe(2); // two re-runs, not three
    expect(record?.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(record?.declined).toEqual({
      attempt: 3,
      reason: 'identical_failure',
      fingerprint: '1c7a9266',
      at: NOW,
    });
  });

  /** A genuinely failed request is a request: it must stay counted. */
  it('leaves a real request failure among the attempts', () => {
    localStorage.setItem(
      'job-monitor.rerun',
      JSON.stringify({
        '7': {
          runId: 7,
          updatedAt: NOW,
          attempts: [{ attempt: 1, fingerprint: 'a', at: NOW, ok: false, error: 'HTTP 500' }],
        },
      }),
    );
    const record = loadRerunRecords(NOW).get(7);
    expect(rerunRequestCount(record)).toBe(1);
    expect(record?.declined).toBeUndefined();
  });
});

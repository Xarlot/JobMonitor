import { describe, expect, it } from 'vitest';
import { explainRerunEvent } from '../lib/autoRerunExplain';

describe('explainRerunEvent', () => {
  it('tells a lagging job list apart, as something that clears itself', () => {
    const x = explainRerunEvent({ outcome: 'held', detail: 'the run is marked failed but none of its 12 job(s) are' });
    expect(x.cause).toMatch(/none of its jobs as failed yet/);
    expect(x.transient).toBe(true);
  });

  it('names the GitHub error when the jobs could not be listed', () => {
    const x = explainRerunEvent({ outcome: 'held', detail: 'the run’s jobs could not be listed — GitHub API error (HTTP 502).' });
    expect(x.cause).toContain('HTTP 502');
    expect(x.transient).toBe(true);
  });

  /** A 403 does not clear on the next poll: the token lacks access, every time. */
  it('does not call a forbidden job list transient', () => {
    const x = explainRerunEvent({ outcome: 'held', detail: 'the run’s jobs could not be listed — Forbidden — check token scopes.' });
    expect(x.transient).toBe(false);
  });

  it('asks for a human when the failure has nothing to compare', () => {
    const x = explainRerunEvent({ outcome: 'held', detail: 'the failure had nothing identifying to compare' });
    expect(x.fix).toMatch(/re-run it yourself/);
    expect(x.transient).toBe(false);
  });

  it('points a refused re-run at the token scopes', () => {
    const x = explainRerunEvent({ outcome: 'failed', detail: 'HTTP 403' });
    expect(x.cause).toContain('HTTP 403');
    expect(x.fix).toMatch(/Actions: write/);
  });

  /** An unrecognised problem still gets an explanation, and its own words verbatim. */
  it('falls back without losing the detail', () => {
    const x = explainRerunEvent({ outcome: 'held', detail: 'something new' });
    expect(x.cause).toContain('something new');
    expect(x.fix).toBeTruthy();
  });
});

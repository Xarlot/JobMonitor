import { describe, expect, it } from 'vitest';
import { phasesFor } from '../components/ClaudeTriageDialog';

describe('phasesFor', () => {
  /**
   * The bug this pins down: the quick pass showed "Reading the log already fetched"
   * while it was in fact downloading a multi-megabyte log, so a slow-but-working fetch
   * was indistinguishable from a hang — which is exactly how it got reported.
   */
  it('does not claim the log is already fetched while downloading it', () => {
    const [first] = phasesFor('quick', false);
    expect(first.label).not.toMatch(/already fetched/i);
    expect(first.label).toMatch(/download/i);
  });

  it('says the log was already fetched only when it really was', () => {
    expect(phasesFor('quick', true)[0].label).toMatch(/already fetched/i);
  });

  /** The deep pass fetches the log itself, so the cache state doesn't change its wording. */
  it('keeps the deep pass wording independent of the cache', () => {
    expect(phasesFor('deep', true)[0].label).toBe(phasesFor('deep', false)[0].label);
    expect(phasesFor('deep', false)[0].label).toMatch(/fetching/i);
  });

  it('names the depth’s own analysis phase', () => {
    expect(phasesFor('quick', true)[1].label).toMatch(/asking/i);
    expect(phasesFor('deep', true)[1].label).toMatch(/investigating/i);
  });

  it('keeps the same phase ids for both depths, so progress tracking is shared', () => {
    expect(phasesFor('quick', true).map((p) => p.id)).toEqual(
      phasesFor('deep', true).map((p) => p.id),
    );
  });
});

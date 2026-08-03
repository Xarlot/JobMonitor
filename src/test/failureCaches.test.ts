import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analysedFailures,
  analysedOrigins,
  analysisKey,
  claudeAnalysisCache,
  runLogCache,
  runLogKey,
} from '../storage/failureCaches';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A fresh module instance, which is what a reload actually gives you: the in-memory map
 * is gone and everything has to come back from localStorage.
 */
async function afterReload() {
  vi.resetModules();
  return await import('../storage/failureCaches');
}

describe('analysisKey', () => {
  /**
   * The two depths are two different answers to the same question, so they must not
   * share a slot — otherwise a Sonnet one-liner would overwrite an Opus investigation,
   * or be shown in its place.
   */
  it('keeps the quick and deep reads of one failure apart', () => {
    expect(analysisKey('42:99', 'quick')).not.toBe(analysisKey('42:99', 'deep'));
  });

  it('keeps different failures apart at the same depth', () => {
    expect(analysisKey('42:99', 'deep')).not.toBe(analysisKey('42:100', 'deep'));
  });
});

describe('claudeAnalysisCache', () => {
  beforeEach(() => {
    localStorage.clear();
    claudeAnalysisCache.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The user asked for this to survive a restart; a memory-only map would not. */
  it('round-trips an analysis across a reload', async () => {
    claudeAnalysisCache.set(analysisKey('42:99', 'deep'), {
      problem: 'The export test broke.',
      solution: 'Fix the rounding.',
    });
    const { claudeAnalysisCache: reloaded, analysisKey: key } = await afterReload();
    expect(reloaded.get(key('42:99', 'deep'))?.problem).toBe('The export test broke.');
  });

  it('serves the quick and deep reads independently after a reload', async () => {
    claudeAnalysisCache.set(analysisKey('42:99', 'quick'), { problem: 'quick', solution: '' });
    claudeAnalysisCache.set(analysisKey('42:99', 'deep'), { problem: 'deep', solution: 'fix' });
    const { claudeAnalysisCache: reloaded, analysisKey: key } = await afterReload();
    expect(reloaded.get(key('42:99', 'quick'))?.problem).toBe('quick');
    expect(reloaded.get(key('42:99', 'deep'))?.problem).toBe('deep');
  });

  /**
   * The trail is how the verdict is judged — "downloaded the artifacts, read the TRX
   * report" is what makes the same words trustworthy. A reopened analysis showed the
   * conclusion with its evidence missing, because only the prose was stored.
   */
  it('round-trips the activity trail with the analysis', async () => {
    claudeAnalysisCache.set(analysisKey('42:99', 'deep'), {
      problem: 'p',
      solution: 's',
      activity: ['Bash: gh run view 1 --log-failed', 'Read: artifacts/report.trx'],
    });
    const { claudeAnalysisCache: reloaded, analysisKey: key } = await afterReload();
    expect(reloaded.get(key('42:99', 'deep'))?.activity).toEqual([
      'Bash: gh run view 1 --log-failed',
      'Read: artifacts/report.trx',
    ]);
  });

  /** Whether it read the whole run or a tail bounds the answer; a restored one says so. */
  it('round-trips the log provenance', async () => {
    claudeAnalysisCache.set(analysisKey('42:99', 'deep'), {
      problem: 'p',
      solution: 's',
      logSource: 'gh',
      logTruncated: true,
    });
    const { claudeAnalysisCache: reloaded, analysisKey: key } = await afterReload();
    const hit = reloaded.get(key('42:99', 'deep'));
    expect(hit?.logSource).toBe('gh');
    expect(hit?.logTruncated).toBe(true);
  });

  /** Entries written before the trail was stored must still load, not throw. */
  it('loads an entry that has no activity', async () => {
    claudeAnalysisCache.set(analysisKey('42:99', 'quick'), { problem: 'p', solution: 's' });
    const { claudeAnalysisCache: reloaded, analysisKey: key } = await afterReload();
    const hit = reloaded.get(key('42:99', 'quick'));
    expect(hit?.problem).toBe('p');
    expect(hit?.activity).toBeUndefined();
  });

  it('still has the analysis just under a week later', async () => {
    claudeAnalysisCache.set(analysisKey('42:99', 'deep'), { problem: 'p', solution: 's' });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + WEEK_MS - 60_000);
    const { claudeAnalysisCache: reloaded, analysisKey: key } = await afterReload();
    expect(reloaded.get(key('42:99', 'deep'))).toBeDefined();
  });

  /**
   * A week is only safe because the key is attempt-unique. Past it the entry goes, so a
   * stale suggestion can't be read as a current verdict.
   */
  it('drops the analysis past a week', async () => {
    claudeAnalysisCache.set(analysisKey('42:99', 'deep'), { problem: 'p', solution: 's' });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + WEEK_MS + 60_000);
    const { claudeAnalysisCache: reloaded, analysisKey: key } = await afterReload();
    expect(reloaded.get(key('42:99', 'deep'))).toBeUndefined();
  });

  /**
   * The attempt-uniqueness the week-long TTL rests on: a re-run mints new job ids, so
   * the new attempt's key misses rather than being served the previous attempt's verdict.
   */
  it('misses for a re-run, which carries a different job id', () => {
    claudeAnalysisCache.set(analysisKey('42:99', 'deep'), { problem: 'p', solution: 's' });
    expect(claudeAnalysisCache.get(analysisKey('42:101', 'deep'))).toBeUndefined();
  });
});

describe('analysedOrigins', () => {
  beforeEach(() => {
    localStorage.clear();
    claudeAnalysisCache.clear();
  });

  /**
   * What the ✦ badge on the pull-request and flow lists is built from. Reading it out of
   * the keys is what lets those lists show it without holding any per-failure state.
   */
  it('reports the origin of every stored analysis', () => {
    claudeAnalysisCache.set(analysisKey('pr:37977:9116', 'deep'), { problem: 'p', solution: 's' });
    claudeAnalysisCache.set(analysisKey('flow:nightly:22', 'quick'), { problem: 'p', solution: 's' });
    expect(analysedOrigins()).toEqual(new Set(['pr:37977', 'flow:nightly']));
  });

  /** Several failures and depths under one PR are still one badge, not four. */
  it('collapses many analyses of one origin into a single entry', () => {
    claudeAnalysisCache.set(analysisKey('pr:37977:1', 'quick'), { problem: 'p', solution: '' });
    claudeAnalysisCache.set(analysisKey('pr:37977:1', 'deep'), { problem: 'p', solution: '' });
    claudeAnalysisCache.set(analysisKey('pr:37977:2', 'deep'), { problem: 'p', solution: '' });
    expect([...analysedOrigins()]).toEqual(['pr:37977']);
  });

  it('does not claim an origin that has nothing stored', () => {
    claudeAnalysisCache.set(analysisKey('pr:37977:1', 'deep'), { problem: 'p', solution: '' });
    expect(analysedOrigins().has('pr:37663')).toBe(false);
  });

  it('is empty when nothing has been analysed', () => {
    expect(analysedOrigins().size).toBe(0);
  });

  /** A rewritten log is a stored result too, so it earns the badge like the others. */
  it('counts a log rewrite as an analysis', () => {
    claudeAnalysisCache.set(analysisKey('pr:37977:1', 'log'), {
      problem: '',
      solution: '',
      rewrittenLog: '## Run tests',
    });
    expect(analysedOrigins().has('pr:37977')).toBe(true);
  });
});

describe('runLogCache', () => {
  beforeEach(() => {
    localStorage.clear();
    runLogCache.clear();
  });

  it('round-trips a run log across a reload', async () => {
    runLogCache.set(runLogKey(30632274130, 2), { text: '##[error]boom', truncated: false });
    vi.resetModules();
    const reloaded = await import('../storage/failureCaches');
    expect(reloaded.runLogCache.get(reloaded.runLogKey(30632274130, 2))?.text).toBe('##[error]boom');
  });

  /** A re-run is a new attempt, so it must miss rather than show the previous log. */
  it('keys by attempt, so a re-run does not read the old attempt', () => {
    runLogCache.set(runLogKey(1, 1), { text: 'first', truncated: false });
    expect(runLogCache.get(runLogKey(1, 2))).toBeUndefined();
  });

  /** Attempt is optional upstream; treating absent as 1 keeps the key stable. */
  it('treats a missing attempt as the first', () => {
    expect(runLogKey(1, null)).toBe(runLogKey(1, 1));
  });
});

describe('analysedFailures', () => {
  beforeEach(() => {
    localStorage.clear();
    claudeAnalysisCache.clear();
  });

  /**
   * Drives the per-row icons in the failure list. The list is where you decide what to
   * spend a call on next, and without it the only way to know whether a row had been
   * looked at was to open it — the very click the icons save.
   */
  it('reports which tasks have a stored result, per failure', () => {
    claudeAnalysisCache.set(analysisKey('pr:37977:1', 'quick'), { problem: 'p', solution: '' });
    claudeAnalysisCache.set(analysisKey('pr:37977:1', 'log'), {
      problem: '',
      solution: '',
      rewrittenLog: '## x',
    });
    claudeAnalysisCache.set(analysisKey('pr:37977:2', 'deep'), { problem: 'p', solution: '' });

    const byFailure = analysedFailures();
    expect(byFailure.get('pr:37977:1')).toEqual(new Set(['quick', 'log']));
    expect(byFailure.get('pr:37977:2')).toEqual(new Set(['deep']));
  });

  it('says nothing for a failure with no results', () => {
    claudeAnalysisCache.set(analysisKey('pr:37977:1', 'deep'), { problem: 'p', solution: '' });
    expect(analysedFailures().get('pr:37977:9')).toBeUndefined();
  });

  it('is empty when nothing has been analysed', () => {
    expect(analysedFailures().size).toBe(0);
  });

  /**
   * A flow failure key is `flow:<id>:<jobId>` — colons all the way through — so the depth
   * has to be split off the *last* separator, not the first.
   */
  it('splits the depth off correctly for a flow failure', () => {
    claudeAnalysisCache.set(analysisKey('flow:nightly-windows:501', 'deep'), {
      problem: 'p',
      solution: '',
    });
    expect(analysedFailures().get('flow:nightly-windows:501')).toEqual(new Set(['deep']));
  });
});

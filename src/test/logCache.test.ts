import { beforeEach, describe, expect, it, vi } from 'vitest';

const ghGetText = vi.fn<(path: string) => Promise<string>>();
vi.mock('../api/githubClient', () => ({ ghGetText: (p: string) => ghGetText(p) }));

import { clearLogCache, fetchJobLog, hasCachedLog, logTtlMs } from '../api/logCache';

const TTL = logTtlMs(true);

/** A promise plus the handles to settle it, so a request can be held open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('fetchJobLog', () => {
  beforeEach(() => {
    clearLogCache();
    ghGetText.mockReset();
  });

  it('fetches once and serves the rest from cache', async () => {
    ghGetText.mockResolvedValue('log text');
    expect(await fetchJobLog('acme', 'rocket', 7, TTL)).toBe('log text');
    expect(await fetchJobLog('acme', 'rocket', 7, TTL)).toBe('log text');
    expect(ghGetText).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug this exists for: opening a failure's report starts a log download, and
   * clicking "Quick read" straight after starts a second one, because there is no cache
   * entry yet for the in-flight request to hit. Both callers then wait on the slower of
   * two identical multi-megabyte downloads, which reads as a hang.
   */
  it('shares one request between concurrent callers', async () => {
    const d = deferred<string>();
    ghGetText.mockReturnValue(d.promise);

    const first = fetchJobLog('acme', 'rocket', 7, TTL);
    const second = fetchJobLog('acme', 'rocket', 7, TTL);
    expect(ghGetText).toHaveBeenCalledTimes(1);

    d.resolve('shared log');
    expect(await first).toBe('shared log');
    expect(await second).toBe('shared log');
  });

  it('still fetches separately for different jobs', async () => {
    ghGetText.mockResolvedValue('x');
    await Promise.all([
      fetchJobLog('acme', 'rocket', 7, TTL),
      fetchJobLog('acme', 'rocket', 8, TTL),
    ]);
    expect(ghGetText).toHaveBeenCalledTimes(2);
  });

  /** A failed download must not be remembered as in flight, or the job is stuck forever. */
  it('lets a caller retry after a failure', async () => {
    ghGetText.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('recovered');
    await expect(fetchJobLog('acme', 'rocket', 7, TTL)).rejects.toThrow('boom');
    expect(await fetchJobLog('acme', 'rocket', 7, TTL)).toBe('recovered');
  });

  /** Both concurrent callers should see the same rejection, not one silent hang. */
  it('rejects every sharer when the shared request fails', async () => {
    const d = deferred<string>();
    ghGetText.mockReturnValue(d.promise);
    const first = fetchJobLog('acme', 'rocket', 7, TTL);
    const second = fetchJobLog('acme', 'rocket', 7, TTL);
    d.reject(new Error('network'));
    await expect(first).rejects.toThrow('network');
    await expect(second).rejects.toThrow('network');
  });
});

describe('hasCachedLog', () => {
  beforeEach(() => {
    clearLogCache();
    ghGetText.mockReset();
    ghGetText.mockResolvedValue('log text');
  });

  /** This drives what the triage dialog claims it is doing, so a wrong answer misleads. */
  it('is false before a fetch and true after', async () => {
    expect(hasCachedLog('acme', 'rocket', 7, TTL)).toBe(false);
    await fetchJobLog('acme', 'rocket', 7, TTL);
    expect(hasCachedLog('acme', 'rocket', 7, TTL)).toBe(true);
  });

  /** In flight is not "already fetched" — that's exactly the case that misled the user. */
  it('is false while the download is still running', async () => {
    const d = deferred<string>();
    ghGetText.mockReturnValue(d.promise);
    const pending = fetchJobLog('acme', 'rocket', 7, TTL);
    expect(hasCachedLog('acme', 'rocket', 7, TTL)).toBe(false);
    d.resolve('done');
    await pending;
    expect(hasCachedLog('acme', 'rocket', 7, TTL)).toBe(true);
  });

  it('is false once the entry is older than the TTL', async () => {
    await fetchJobLog('acme', 'rocket', 7, TTL);
    expect(hasCachedLog('acme', 'rocket', 7, TTL, Date.now() + TTL + 1000)).toBe(false);
  });

  it('does not confuse one job with another', async () => {
    await fetchJobLog('acme', 'rocket', 7, TTL);
    expect(hasCachedLog('acme', 'rocket', 8, TTL)).toBe(false);
  });
});

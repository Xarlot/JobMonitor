import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVerdictLog,
  devLog,
  devLogEnabled,
  devWarn,
  installDevLogControls,
  setDevLogEnabled,
} from '../lib/devLog';

describe('devLog', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('writes a scoped line when enabled', () => {
    setDevLogEnabled(true);
    devLog('claude', 'started');
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('[claude]');
    expect(log.mock.calls[0][0]).toContain('started');
  });

  it('says nothing when disabled', () => {
    setDevLogEnabled(false);
    devLog('claude', 'started');
    expect(log).not.toHaveBeenCalled();
  });

  /**
   * Passed through rather than stringified, so the console renders it expandable — a
   * flattened object is the difference between a usable diagnostic and a wall of text.
   */
  it('passes the detail object through unflattened', () => {
    setDevLogEnabled(true);
    const detail = { jobId: 7, nested: { annotations: 2 } };
    devLog('claude', 'analysing', detail);
    expect(log.mock.calls[0].at(-1)).toBe(detail);
  });

  /** A genuine problem must surface even for someone who never turned logging on. */
  it('warns regardless of the flag', () => {
    setDevLogEnabled(false);
    devWarn('log-cache', 'download failed');
    expect(warn).toHaveBeenCalled();
  });

  it('persists the flag so it survives a reload', () => {
    setDevLogEnabled(true);
    expect(localStorage.getItem('job-monitor.debug')).toBe('1');
    setDevLogEnabled(false);
    expect(localStorage.getItem('job-monitor.debug')).toBeNull();
  });

  /**
   * A diagnostic channel that defaults to off and is undiscoverable is one nobody finds
   * at the moment they need it.
   */
  it('exposes a toggle on window and announces it', () => {
    installDevLogControls();
    const api = (window as unknown as { jobMonitorDebug: { enable: () => void; disable: () => void; enabled: boolean } }).jobMonitorDebug;
    expect(api).toBeDefined();
    expect(log.mock.calls.some((c: unknown[]) => String(c[0]).includes('jobMonitorDebug.enable()'))).toBe(
      true,
    );

    api.disable();
    expect(devLogEnabled()).toBe(false);
    api.enable();
    expect(devLogEnabled()).toBe(true);
    expect(api.enabled).toBe(true);
  });
});

/**
 * The caller here is on a timer, so the thing being tested is mostly what *isn't*
 * written: a poll that re-derives the same verdict every minute must not fill the
 * size-capped log file with it.
 */
describe('createVerdictLog', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setDevLogEnabled(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('logs a verdict once, however often it is re-derived', () => {
    const verdict = createVerdictLog('auto-rerun');
    for (let i = 0; i < 20; i += 1) verdict('run:1', 'too_old', 'run 1 is too old');
    expect(log).toHaveBeenCalledTimes(1);
  });

  /**
   * The return value is the gate a caller hangs other once-per-change work off — a UI row,
   * a notification — instead of keeping a second copy of the same bookkeeping.
   */
  it('reports whether it wrote', () => {
    const verdict = createVerdictLog('auto-rerun');
    expect(verdict('run:1', 'held', 'could not check')).toBe(true);
    expect(verdict('run:1', 'held', 'could not check')).toBe(false);
    expect(verdict('run:1', 'held: different cause', 'could not check')).toBe(true);
  });

  it('logs again when the verdict for the same subject changes', () => {
    const verdict = createVerdictLog('auto-rerun');
    verdict('run:1', 'identical_failure', 'the failure repeated');
    verdict('run:1', 'too_old', 'run 1 is too old');
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1][0])).toContain('too old');
  });

  /** A verdict per run, and runs keep arriving — each subject speaks for itself. */
  it('tracks subjects independently', () => {
    const verdict = createVerdictLog('auto-rerun');
    verdict('run:1', 'too_old', 'run 1 is too old');
    verdict('run:2', 'too_old', 'run 2 is too old');
    verdict('run:1', 'too_old', 'run 1 is too old');
    expect(log).toHaveBeenCalledTimes(2);
  });

  /** Bounded memory: past the cap it forgets, which costs repeats, not growth. */
  it('does not remember subjects without limit', () => {
    const verdict = createVerdictLog('auto-rerun', 3);
    verdict('a', 'x', 'a');
    verdict('b', 'x', 'b');
    verdict('c', 'x', 'c');
    verdict('a', 'x', 'a'); // still remembered — 3 keys, no reset yet
    expect(log).toHaveBeenCalledTimes(3);

    verdict('d', 'x', 'd'); // size hit the cap: memory cleared, then 'd' stored
    verdict('a', 'x', 'a'); // forgotten, so said once more
    expect(log).toHaveBeenCalledTimes(5);
  });

  it('still writes to the log file when the console is off', () => {
    setDevLogEnabled(false);
    const write = vi.fn();
    (globalThis as { desktop?: unknown }).desktop = { logs: { write } };
    try {
      const verdict = createVerdictLog('auto-rerun');
      verdict('run:1', 'too_old', 'run 1 is too old', { runId: 1 });
      verdict('run:1', 'too_old', 'run 1 is too old', { runId: 1 });
      expect(log).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0]).toBe('auto-rerun');
    } finally {
      delete (globalThis as { desktop?: unknown }).desktop;
    }
  });
});

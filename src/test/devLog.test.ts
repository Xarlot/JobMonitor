import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { devLog, devLogEnabled, devWarn, installDevLogControls, setDevLogEnabled } from '../lib/devLog';

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

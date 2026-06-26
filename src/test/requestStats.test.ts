import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRequestStats,
  getRequestStats,
  recordRequest,
} from '../api/requestStats';

describe('requestStats', () => {
  beforeEach(() => clearRequestStats());

  it('counts every recorded request by kind', () => {
    recordRequest('fresh');
    recordRequest('cached');
    recordRequest('cached');
    recordRequest('error');
    const s = getRequestStats();
    expect(s.total).toBe(4);
    expect(s.fresh).toBe(1);
    expect(s.cached).toBe(2);
    expect(s.error).toBe(1);
  });

  it('persists events to localStorage', () => {
    recordRequest('fresh');
    expect(localStorage.getItem('job-monitor.reqstats')).toBeTruthy();
  });

  it('uses a sliding 1h window — old events age out', () => {
    recordRequest('fresh');
    expect(getRequestStats().total).toBe(1);
    // Evaluate the window 2 hours in the future: the event has aged out.
    const future = Date.now() + 2 * 60 * 60 * 1000;
    expect(getRequestStats(future).total).toBe(0);
  });

  it('clear resets the store', () => {
    recordRequest('fresh');
    clearRequestStats();
    expect(getRequestStats().total).toBe(0);
  });
});

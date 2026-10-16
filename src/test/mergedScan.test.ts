import { describe, expect, it } from 'vitest';
import { MERGED_SCAN_INTERVAL_MS, shouldScanMerged } from '../hooks/useGitHubDashboard';

const T = 1_800_000_000_000;
const open = (...n: number[]) => new Set(n);

describe('shouldScanMerged', () => {
  const base = { lastScanAt: T, prevOpen: open(1, 2), nowOpen: open(1, 2), forced: false, now: T + 60_000 };

  it('skips a poll where nothing of ours left the open list', () => {
    expect(shouldScanMerged(base)).toBe(false);
  });

  it('scans on the first read, before any scan has finished', () => {
    expect(shouldScanMerged({ ...base, lastScanAt: null })).toBe(true);
    expect(shouldScanMerged({ ...base, prevOpen: null })).toBe(true);
  });

  /** The only way a PR joins the merged list is by leaving the open one. */
  it('scans when one of our open PRs is gone', () => {
    expect(shouldScanMerged({ ...base, nowOpen: open(2) })).toBe(true);
  });

  it('does not scan just because a new PR was opened', () => {
    expect(shouldScanMerged({ ...base, nowOpen: open(1, 2, 3) })).toBe(false);
  });

  it('scans on a manual refresh', () => {
    expect(shouldScanMerged({ ...base, forced: true })).toBe(true);
  });

  it('scans on the slow timer, for a PR merged while nobody was watching', () => {
    expect(shouldScanMerged({ ...base, now: T + MERGED_SCAN_INTERVAL_MS - 1 })).toBe(false);
    expect(shouldScanMerged({ ...base, now: T + MERGED_SCAN_INTERVAL_MS })).toBe(true);
  });
});

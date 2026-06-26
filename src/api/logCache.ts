/**
 * In-memory TTL cache for fetched job logs, so re-opening a job's Logs dialog
 * reuses the already-downloaded text instead of refetching. Completed jobs have
 * immutable logs (long TTL); running jobs use a short TTL. Bounded by entry count
 * and swept by TTL. (Kept in memory only — logs can be large; not persisted.)
 */

import { ghGetText } from './githubClient';
import { jobLogsPath } from './endpoints';

interface LogEntry {
  text: string;
  ts: number;
}

const cache = new Map<string, LogEntry>();
const MAX_ENTRIES = 40;

/** TTL by job state: completed logs are immutable, running logs change. */
export function logTtlMs(completed: boolean): number {
  return completed ? 6 * 60 * 60 * 1000 : 15_000;
}

export function sweepLogCache(maxAgeMs: number, now: number = Date.now()): void {
  for (const [k, e] of cache) {
    if (now - e.ts > maxAgeMs) cache.delete(k);
  }
}

export function clearLogCache(): void {
  cache.clear();
}

export async function fetchJobLog(
  owner: string,
  repo: string,
  jobId: number,
  ttlMs: number,
): Promise<string> {
  const key = jobLogsPath(owner, repo, jobId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts <= ttlMs) return hit.text;

  const text = await ghGetText(key);
  cache.set(key, { text, ts: now });

  if (cache.size > MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, e] of cache) {
      if (e.ts < oldestTs) {
        oldestTs = e.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  return text;
}

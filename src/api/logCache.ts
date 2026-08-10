/**
 * In-memory TTL cache for fetched job logs, so re-opening a job's Logs dialog
 * reuses the already-downloaded text instead of refetching. Completed jobs have
 * immutable logs (long TTL); running jobs use a short TTL. Bounded by entry count
 * and swept by TTL. (Kept in memory only — logs can be large; not persisted.)
 */

import { ghGetText } from './githubClient';
import { jobLogsPath } from './endpoints';
import { devLog, devWarn } from '../lib/devLog';
import { Operation, Telemetry } from '../lib/telemetry';

interface LogEntry {
  text: string;
  ts: number;
}

const cache = new Map<string, LogEntry>();
const MAX_ENTRIES = 40;

/**
 * Downloads in flight, so concurrent callers for the same job share one request.
 *
 * Without this, opening a failure's report and immediately asking Claude to explain it
 * downloads the same (often multi-megabyte) log twice in parallel — the second request
 * can't see a cache entry that the first hasn't written yet. Both then block on the
 * slower of two identical downloads.
 */
const inflight = new Map<string, Promise<string>>();

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

/**
 * Whether a fetch would be served from cache — a peek, so a caller can say honestly
 * whether it is reading a log it already has or downloading one now.
 */
export function hasCachedLog(
  owner: string,
  repo: string,
  jobId: number,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  const hit = cache.get(jobLogsPath(owner, repo, jobId));
  return hit !== undefined && now - hit.ts <= ttlMs;
}

export async function fetchJobLog(
  owner: string,
  repo: string,
  jobId: number,
  ttlMs: number,
): Promise<string> {
  return Telemetry.measure(Operation.GH_JOB_LOG_FETCH, () => fetchJobLog__impl(owner, repo, jobId, ttlMs));
}

async function fetchJobLog__impl(
  owner: string,
  repo: string,
  jobId: number,
  ttlMs: number,
): Promise<string> {
  const key = jobLogsPath(owner, repo, jobId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts <= ttlMs) {
    devLog('log-cache', `cache hit for job ${jobId} (${hit.text.length} chars)`);
    return hit.text;
  }

  const pending = inflight.get(key);
  if (pending) {
    devLog('log-cache', `joining in-flight download for job ${jobId}`);
    return await pending;
  }

  devLog('log-cache', `downloading log for job ${jobId}`);
  const request = ghGetText(key).finally(() => inflight.delete(key));
  inflight.set(key, request);
  let text: string;
  try {
    text = await request;
  } catch (err) {
    devWarn('log-cache', `log download failed for job ${jobId}`, err);
    throw err;
  }
  devLog('log-cache', `log for job ${jobId}: ${text.length} chars`);
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

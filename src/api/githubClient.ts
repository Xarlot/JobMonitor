/**
 * Thin fetch wrapper around api.github.com.
 *
 *  - Always targets the hardcoded GitHub host (the token is never sent elsewhere).
 *  - Sends `If-None-Match` using a per-path in-memory ETag cache; a 304 returns
 *    the cached body with `notModified: true` so callers can skip state updates
 *    (and 304s don't count against the rate limit).
 *  - Feeds rate-limit headers into the rateLimit store; surfaces 403/429 secondary
 *    limits as a typed, retry-aware error.
 *  - The fetch implementation and token provider are injectable for tests/mock mode.
 */

import { getTokenInMemory } from '../storage/secureTokenStore';
import {
  recordRateLimitHit,
  updateRateLimitFromHeaders,
} from './rateLimit';
import { recordRequest } from './requestStats';

const API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30_000;

export interface GhResult<T> {
  data: T;
  status: number;
  /** True when served from cache via a 304 response. */
  notModified: boolean;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly isRateLimit: boolean = false,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

interface CacheEntry {
  etag: string;
  data: unknown;
  /** Last write time (ms) — used to evict stale persisted entries by TTL. */
  ts?: number;
}

const etagCache = new Map<string, CacheEntry>();

// ---- Persistent ETag cache (localStorage) --------------------------------
// Persisting {etag, data, ts} per request lets a reload serve data immediately
// and turn the next fetch into a 304 (which doesn't cost rate limit). Bodies are
// repo metadata, never secrets. Oversized entries are kept in memory only, and
// entries older than the TTL are dropped on load.
const ETAG_PREFIX = 'job-monitor.etag.';
const MAX_PERSIST_BYTES = 250_000;
const ETAG_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let persistedLoaded = false;

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function loadPersistedCache(): void {
  if (persistedLoaded) return;
  persistedLoaded = true;
  if (!hasLocalStorage()) return;
  const now = Date.now();
  const expiredKeys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(ETAG_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as CacheEntry;
        if (parsed?.ts && now - parsed.ts > ETAG_TTL_MS) {
          expiredKeys.push(key); // stale -> clean up
          continue;
        }
        if (parsed?.etag) etagCache.set(key.slice(ETAG_PREFIX.length), parsed);
      } catch {
        /* skip corrupt entry */
      }
    }
    for (const k of expiredKeys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

function persistEntry(path: string, entry: CacheEntry): void {
  if (!hasLocalStorage()) return;
  try {
    const raw = JSON.stringify(entry);
    if (raw.length > MAX_PERSIST_BYTES) return;
    localStorage.setItem(ETAG_PREFIX + path, raw);
  } catch {
    // Most likely QuotaExceededError: free the whole response cache namespace so
    // storage stays usable, then give up on persisting this entry (in-memory only).
    clearPersisted();
  }
}

function removePersisted(path: string): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.removeItem(ETAG_PREFIX + path);
  } catch {
    /* ignore */
  }
}

function clearPersisted(): void {
  if (!hasLocalStorage()) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(ETAG_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

type FetchImpl = typeof fetch;
let fetchImpl: FetchImpl = (...args) => globalThis.fetch(...args);
let tokenProvider: () => string | null = getTokenInMemory;

export function setFetchImpl(fn: FetchImpl): void {
  fetchImpl = fn;
}
export function setTokenProvider(fn: () => string | null): void {
  tokenProvider = fn;
}
export function clearEtagCache(): void {
  etagCache.clear();
  clearPersisted();
}
/** Drop a single cached entry (e.g. when a flow run is invalidated). */
export function evictFromCache(path: string): void {
  etagCache.delete(path);
  removePersisted(path);
}

/**
 * Perform a conditional GET. `path` is a GitHub-relative path and also the cache key.
 */
export async function ghGet<T>(path: string): Promise<GhResult<T>> {
  loadPersistedCache();
  const token = tokenProvider();
  if (!token) throw new GitHubApiError('No token available; unlock first.', 401);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const cached = etagCache.get(path);
  if (cached) headers['If-None-Match'] = cached.etag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
      referrerPolicy: 'no-referrer',
    });
  } catch (err) {
    recordRequest('error');
    if (controller.signal.aborted) throw new GitHubApiError('Request timed out.', 0);
    // Network error: do not include any request detail that might carry the token.
    throw new GitHubApiError('Network request to GitHub failed.', 0);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    updateRateLimitFromHeaders(res.headers);
    recordRequest('cached');
    if (!cached) {
      // Should not happen (we only send If-None-Match with a cache), but be safe.
      throw new GitHubApiError('Received 304 without a cached response.', 304);
    }
    return { data: cached.data as T, status: 304, notModified: true };
  }

  if (res.status === 403 || res.status === 429) {
    recordRequest('error');
    const remaining = res.headers.get('x-ratelimit-remaining');
    const isSecondary =
      res.status === 429 ||
      remaining === '0' ||
      res.headers.has('retry-after');
    if (isSecondary) {
      recordRateLimitHit(res.headers);
      throw new GitHubApiError('GitHub rate limit reached.', res.status, true);
    }
    updateRateLimitFromHeaders(res.headers);
    throw new GitHubApiError('Forbidden — check token scopes.', 403);
  }

  if (!res.ok) {
    recordRequest('error');
    updateRateLimitFromHeaders(res.headers);
    throw new GitHubApiError(`GitHub API error (HTTP ${res.status}).`, res.status);
  }

  updateRateLimitFromHeaders(res.headers);
  recordRequest('fresh');
  const data = (await res.json()) as T;
  const etag = res.headers.get('etag');
  if (etag) {
    const entry = { etag, data, ts: Date.now() };
    etagCache.set(path, entry);
    persistEntry(path, entry);
  }

  return { data, status: res.status, notModified: false };
}

/**
 * Fetch a text resource (e.g. Actions job logs). The endpoint 302-redirects to a
 * CORS-enabled signed blob URL; the browser follows it and drops Authorization on
 * the cross-origin hop (the blob uses a signed query). Only `Authorization` is
 * sent so the redirected GET stays a simple, preflight-free request.
 */
export async function ghGetText(path: string): Promise<string> {
  loadPersistedCache();
  const token = tokenProvider();
  if (!token) throw new GitHubApiError('No token available; unlock first.', 401);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
      signal: controller.signal,
      referrerPolicy: 'no-referrer',
    });
  } catch {
    recordRequest('error');
    if (controller.signal.aborted) throw new GitHubApiError('Request timed out.', 0);
    throw new GitHubApiError('Network request failed (logs may be CORS-restricted).', 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    recordRequest('error');
    throw new GitHubApiError(`Failed to load logs (HTTP ${res.status}).`, res.status);
  }
  recordRequest('fresh');
  return res.text();
}

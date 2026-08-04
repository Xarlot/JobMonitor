/**
 * Thin fetch wrapper around api.github.com.
 *
 *  - Always targets the hardcoded GitHub host (the token is never sent elsewhere).
 *  - Reads (`ghGet`/`ghGetText`/`ghGetBlob`) send `If-None-Match` using a per-path
 *    in-memory ETag cache; a 304 returns the cached body with `notModified: true`
 *    so callers can skip state updates (and 304s don't count against the rate limit).
 *  - `ghPost` and `ghWriteJson` are the write paths — uncached, unconditional, and
 *    used only to re-run failed Actions jobs and to arm auto-merge on a PR. Both
 *    funnel through one internal function that is gated by tokenCapability, so no
 *    write is reachable unless the token is known to permit it.
 *  - Feeds rate-limit headers into the rateLimit store and token scopes into the
 *    tokenCapability store; surfaces 403/429 secondary limits as a typed,
 *    retry-aware error.
 *  - The fetch implementation and token provider are injectable for tests/mock mode.
 */

import { getTokenInMemory } from '../storage/secureTokenStore';
import {
  recordRateLimitHit,
  updateRateLimitFromHeaders,
} from './rateLimit';
import { recordRequest } from './requestStats';
import { getTokenCapability, recordTokenScopes } from './tokenCapability';
import { devWarn } from '../lib/devLog';

const API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Separate budget for reading a response *body*, which the request timeout cannot cover.
 *
 * Twenty minutes, not two. A job log from a large repository is tens of megabytes served
 * from blob storage, and two minutes was cutting healthy downloads short — reported as
 * "the response started but never finished", which is what a slow transfer looks like from
 * the inside. This bound exists to stop an indefinite hang, not to police how long a big
 * file may legitimately take.
 *
 * The request timer has to be released once headers arrive — otherwise a large but
 * healthy download would be killed mid-transfer. That left every body read unbounded: a
 * response whose headers came back fine and whose body then stalled hung **forever**,
 * with nothing in the app able to give up on it. Job logs and artifacts are where this
 * bites, since both 302-redirect to blob storage, so the body is the slow part by design.
 */
export const BODY_TIMEOUT_MS = 20 * 60_000;
/** Artifact zips can be large, so downloads get a more generous timeout. */
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;

export interface GhResult<T> {
  data: T;
  status: number;
  /** True when served from cache via a 304 response. */
  notModified: boolean;
}

/**
 * Why a write was refused. GitHub documents only the success code for the Actions
 * re-run endpoints, so these are classified from observed status + message text —
 * always by substring, never exact equality (the permission message has been seen
 * with a trailing `[]`).
 */
export type WriteRefusal =
  /** Primary or secondary rate limit — retryable. */
  | 'rate-limit'
  /** The token definitively lacks permission; the caller should stop offering writes. */
  | 'permission'
  /** Refused, but token-grant vs repo-role is indistinguishable in the response. */
  | 'forbidden'
  /** Outside GitHub's 30-day retry window — permanent for this run only. */
  | 'too-old'
  /** The run isn't in a re-runnable state right now. */
  | 'conflict'
  | 'other';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly isRateLimit: boolean = false,
    /** Set on failed writes; absent for reads. */
    readonly refusal?: WriteRefusal,
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

/**
 * Shared 403/429 handling for reads and writes: decide whether this is a rate
 * limit (primary or secondary) or a plain refusal, and keep the rate-limit store
 * accurate either way. Kept in one place so a write can't drift from a read.
 */
function classifyForbidden(res: Response): { isRateLimit: boolean } {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const isSecondary =
    res.status === 429 ||
    remaining === '0' ||
    res.headers.has('retry-after');
  if (isSecondary) {
    recordRateLimitHit(res.headers);
    return { isRateLimit: true };
  }
  updateRateLimitFromHeaders(res.headers);
  return { isRateLimit: false };
}
/** Drop a single cached entry (e.g. when a flow run is invalidated). */
export function evictFromCache(path: string): void {
  etagCache.delete(path);
  removePersisted(path);
}

/**
 * Perform a conditional GET. `path` is a GitHub-relative path and also the cache key.
 */
/**
 * Read a response body under its own abort deadline. See {@link BODY_TIMEOUT_MS} for why
 * this can't just ride on the request timer.
 */
async function readBody<T>(
  read: () => Promise<T>,
  controller: AbortController,
  ms: number = BODY_TIMEOUT_MS,
): Promise<T> {
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await read();
  } finally {
    clearTimeout(timer);
  }
}

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

  // The scope header rides along on every status, including 304 and errors.
  recordTokenScopes(res.headers);

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
    if (classifyForbidden(res).isRateLimit) {
      throw new GitHubApiError('GitHub rate limit reached.', res.status, true);
    }
    throw new GitHubApiError('Forbidden — check token scopes.', 403);
  }

  if (!res.ok) {
    recordRequest('error');
    updateRateLimitFromHeaders(res.headers);
    throw new GitHubApiError(`GitHub API error (HTTP ${res.status}).`, res.status);
  }

  updateRateLimitFromHeaders(res.headers);
  let data: T;
  try {
    data = await readBody(() => res.json() as Promise<T>, controller);
  } catch {
    recordRequest('error');
    throw new GitHubApiError('The GitHub response body could not be read.', 0);
  }
  recordRequest('fresh');
  const etag = res.headers.get('etag');
  if (etag) {
    const entry = { etag, data, ts: Date.now() };
    etagCache.set(path, entry);
    persistEntry(path, entry);
  }

  return { data, status: res.status, notModified: false };
}

/** Lift GitHub's `message` out of an error body. Never throws. */
async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body?.message === 'string' ? body.message : null;
  } catch {
    return null;
  }
}

function classifyRefusal(status: number, message: string | null): WriteRefusal {
  const m = (message ?? '').toLowerCase();
  if (m.includes('secondary rate limit')) return 'rate-limit';
  if (m.startsWith('resource not accessible by')) return 'permission';
  if (m.includes('created over a month ago')) return 'too-old';
  // A private repo answers 404 rather than 403 when the token can't reach it, so
  // as not to confirm the repo exists. For a run we listed moments ago that is a
  // permission problem, NOT a vanished run — treating it as "gone" would retry
  // forever against a wall.
  if (status === 404) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 403) return 'forbidden';
  return 'other';
}

function refusalMessage(
  refusal: WriteRefusal,
  message: string | null,
  status: number,
): string {
  switch (refusal) {
    case 'rate-limit':
      return 'GitHub rate limit reached.';
    case 'permission':
      return `Your token isn't allowed to re-run jobs${message ? ` (${message})` : ''}.`;
    case 'too-old':
      return message ?? 'This run is too old to re-run (GitHub allows 30 days).';
    case 'conflict':
      return message ?? "GitHub can't re-run this run in its current state.";
    case 'forbidden':
      return status === 404
        ? 'Run not reachable — most likely the token lacks write access to this repository.'
        : (message ?? 'GitHub refused the re-run.');
    default:
      return message ?? `GitHub API error (HTTP ${status}).`;
  }
}

/**
 * Perform a write. Deliberately separate from {@link ghGet}:
 *
 *  - never conditional and never cached — the ETag cache is keyed by path and a
 *    write has no cacheable representation;
 *  - failures are classified into {@link WriteRefusal} so callers can tell
 *    "retry later" from "this run is a lost cause" from "hide the feature".
 *
 * Every write goes through here, whatever its verb, so the capability gate and the
 * refusal classification exist once. Returns the raw response; the two exported
 * wrappers decide what to do with the body.
 */
async function ghWriteRaw(
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = tokenProvider();
  if (!token) throw new GitHubApiError('No token available; unlock first.', 401);

  // Enforced here, not just asserted in prose: several callers check capability
  // before offering a write, and the next one must inherit the guarantee rather
  // than have to remember it.
  if (!getTokenCapability().canRerun) {
    throw new GitHubApiError(
      "This token isn't allowed to write to this repository.",
      403,
      false,
      'permission',
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      referrerPolicy: 'no-referrer',
    });
  } catch {
    recordRequest('error');
    if (controller.signal.aborted) throw new GitHubApiError('Request timed out.', 0);
    throw new GitHubApiError('Network request to GitHub failed.', 0);
  } finally {
    clearTimeout(timer);
  }

  recordTokenScopes(res.headers);

  if (res.ok) {
    updateRateLimitFromHeaders(res.headers);
    // A write costs quota, so it belongs in the same bucket as a fresh read.
    // Adding a new RequestKind would land it in requestStats' catch-all `else`
    // and be reported as an error.
    recordRequest('fresh');
    return res;
  }

  recordRequest('error');
  const message = await readErrorMessage(res);

  if (res.status === 403 || res.status === 429) {
    if (classifyForbidden(res).isRateLimit) {
      throw new GitHubApiError('GitHub rate limit reached.', res.status, true, 'rate-limit');
    }
  } else {
    updateRateLimitFromHeaders(res.headers);
  }

  const refusal = classifyRefusal(res.status, message);
  throw new GitHubApiError(
    refusalMessage(refusal, message, res.status),
    res.status,
    refusal === 'rate-limit',
    refusal,
  );
}

/**
 * A write whose response body is of no interest.
 *
 * The body is deliberately not parsed: the Actions re-run endpoints answer 201 with an
 * empty body, and `res.json()` would throw a bare SyntaxError outside the GitHubApiError
 * contract callers rely on. Returns the HTTP status on success.
 */
export async function ghPost(path: string, body?: unknown): Promise<number> {
  const res = await ghWriteRaw('POST', path, body);
  return res.status;
}

/**
 * A write whose response body carries the answer — a PATCH that returns the updated
 * resource, or a GraphQL mutation, where failure arrives as HTTP 200 with an `errors`
 * array and so cannot be detected from the status at all.
 *
 * An unparseable body is reported as a GitHubApiError rather than a raw SyntaxError, for
 * the same reason {@link ghPost} refuses to parse at all: callers handle one error type.
 */
export async function ghWriteJson<T>(
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await ghWriteRaw(method, path, body);
  try {
    return (await res.json()) as T;
  } catch {
    throw new GitHubApiError('GitHub returned a response that could not be read.', res.status);
  }
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
    // The status is the whole diagnosis here: 403 is usually a token without `repo`,
    // 404 a job whose log has aged out or a private repo hiding itself. The thrown
    // message reaches the UI, but the path is what identifies which job it was.
    devWarn('api', `log request failed: HTTP ${res.status}`, { path });
    throw new GitHubApiError(`Failed to load logs (HTTP ${res.status}).`, res.status);
  }
  let text: string;
  try {
    text = await readBody(() => res.text(), controller);
  } catch {
    recordRequest('error');
    devWarn('api', 'log body stalled or failed after headers arrived', {
      path,
      aborted: controller.signal.aborted,
    });
    throw new GitHubApiError(
      controller.signal.aborted
        ? 'Timed out downloading the log body (the response started but never finished).'
        : 'The log download failed partway through.',
      0,
    );
  }
  recordRequest('fresh');
  return text;
}

/**
 * Fetch a binary resource (e.g. an artifact zip) as a Blob. Like {@link ghGetText},
 * the endpoint 302-redirects to a CORS-enabled signed blob URL; the browser follows
 * it and drops Authorization on the cross-origin hop.
 */
export async function ghGetBlob(path: string): Promise<Blob> {
  const token = tokenProvider();
  if (!token) throw new GitHubApiError('No token available; unlock first.', 401);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
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
    if (controller.signal.aborted) throw new GitHubApiError('Download timed out.', 0);
    throw new GitHubApiError('Network request failed (download may be CORS-restricted).', 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    recordRequest('error');
    throw new GitHubApiError(`Failed to download (HTTP ${res.status}).`, res.status);
  }
  let blob: Blob;
  try {
    blob = await readBody(() => res.blob(), controller);
  } catch {
    recordRequest('error');
    throw new GitHubApiError(
      controller.signal.aborted
        ? 'Timed out downloading the file (the response started but never finished).'
        : 'The download failed partway through.',
      0,
    );
  }
  recordRequest('fresh');
  return blob;
}

/**
 * Tracks GitHub rate-limit state from response headers and exposes it as a tiny
 * external store (consumed via useSyncExternalStore). Also computes whether we
 * are currently throttled and when it is safe to retry.
 *
 * Note: conditional requests that return 304 do NOT count against the primary
 * rate limit, which is why the client uses ETags aggressively.
 */

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Unix epoch seconds when the window resets. */
  reset: number | null;
  used: number | null;
  /** From Retry-After on 403/429 secondary limits: epoch ms to retry at. */
  retryAtMs: number | null;
  /** Date.now() of the last update. */
  updatedAt: number | null;
}

const initial: RateLimitInfo = {
  limit: null,
  remaining: null,
  reset: null,
  used: null,
  retryAtMs: null,
  updatedAt: null,
};

let current: RateLimitInfo = initial;
const listeners = new Set<() => void>();

export function getRateLimit(): RateLimitInfo {
  return current;
}

export function subscribeRateLimit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(next: RateLimitInfo): void {
  current = next;
  for (const l of listeners) l();
}

function toInt(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Update store from a normal (2xx/304) response's headers. */
export function updateRateLimitFromHeaders(headers: Headers): void {
  const limit = toInt(headers.get('x-ratelimit-limit'));
  const remaining = toInt(headers.get('x-ratelimit-remaining'));
  const reset = toInt(headers.get('x-ratelimit-reset'));
  const used = toInt(headers.get('x-ratelimit-used'));
  emit({
    ...current,
    limit: limit ?? current.limit,
    remaining: remaining ?? current.remaining,
    reset: reset ?? current.reset,
    used: used ?? current.used,
    // A successful call clears any prior secondary-limit backoff.
    retryAtMs: null,
    updatedAt: Date.now(),
  });
}

/** Record a 403/429 secondary rate-limit hit and compute when to retry. */
export function recordRateLimitHit(headers: Headers): void {
  const retryAfter = toInt(headers.get('retry-after'));
  const reset = toInt(headers.get('x-ratelimit-reset'));
  let retryAtMs: number;
  if (retryAfter != null) {
    retryAtMs = Date.now() + retryAfter * 1000;
  } else if (reset != null) {
    retryAtMs = reset * 1000;
  } else {
    retryAtMs = Date.now() + 60_000; // conservative default backoff
  }
  emit({
    ...current,
    remaining: toInt(headers.get('x-ratelimit-remaining')) ?? current.remaining,
    reset: reset ?? current.reset,
    retryAtMs,
    updatedAt: Date.now(),
  });
}

/** True while a primary (remaining 0 before reset) or secondary limit is active. */
export function isThrottled(info: RateLimitInfo = current, now: number = Date.now()): boolean {
  if (info.retryAtMs != null && now < info.retryAtMs) return true;
  if (
    info.remaining === 0 &&
    info.reset != null &&
    now < info.reset * 1000
  ) {
    return true;
  }
  return false;
}

/** Epoch ms when requests may resume, or null if not throttled. */
export function throttledUntil(info: RateLimitInfo = current, now: number = Date.now()): number | null {
  if (!isThrottled(info, now)) return null;
  const resetMs = info.reset != null ? info.reset * 1000 : 0;
  return Math.max(info.retryAtMs ?? 0, resetMs);
}

/** True when remaining has dropped at/below the configured warning threshold. */
export function isLow(info: RateLimitInfo, warnAt: number): boolean {
  return info.remaining != null && info.remaining <= warnAt;
}

/** Test-only: reset the store to its initial state. */
export function __resetRateLimit(): void {
  emit(initial);
}

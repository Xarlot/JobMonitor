import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRateLimit,
  getRateLimit,
  isLow,
  isThrottled,
  recordRateLimitHit,
  throttledUntil,
  updateRateLimitFromHeaders,
} from '../api/rateLimit';

function headers(h: Record<string, string>): Headers {
  return new Headers(h);
}

describe('rateLimit', () => {
  beforeEach(() => __resetRateLimit());

  it('parses X-RateLimit-* headers', () => {
    updateRateLimitFromHeaders(
      headers({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4990',
        'x-ratelimit-used': '10',
        'x-ratelimit-reset': '2000000000',
      }),
    );
    const info = getRateLimit();
    expect(info.limit).toBe(5000);
    expect(info.remaining).toBe(4990);
    expect(info.used).toBe(10);
    expect(info.reset).toBe(2000000000);
  });

  it('flags low remaining against a threshold', () => {
    updateRateLimitFromHeaders(headers({ 'x-ratelimit-remaining': '40' }));
    expect(isLow(getRateLimit(), 50)).toBe(true);
    expect(isLow(getRateLimit(), 10)).toBe(false);
  });

  it('treats remaining 0 before reset as throttled', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    updateRateLimitFromHeaders(
      headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(future) }),
    );
    expect(isThrottled(getRateLimit())).toBe(true);
    expect(throttledUntil(getRateLimit())).toBe(future * 1000);
  });

  it('records a secondary-limit hit with Retry-After', () => {
    const now = Date.now();
    recordRateLimitHit(headers({ 'retry-after': '30' }));
    const until = throttledUntil(getRateLimit(), now);
    expect(until).not.toBeNull();
    expect(until!).toBeGreaterThanOrEqual(now + 29_000);
  });
});

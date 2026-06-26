import { useSyncExternalStore } from 'react';
import { getRateLimit, subscribeRateLimit, type RateLimitInfo } from '../api/rateLimit';

/** Subscribe to the rate-limit external store. */
export function useRateLimit(): RateLimitInfo {
  return useSyncExternalStore(subscribeRateLimit, getRateLimit, getRateLimit);
}

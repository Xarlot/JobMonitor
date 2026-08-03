import { useSyncExternalStore } from 'react';
import {
  getTokenCapability,
  subscribeTokenCapability,
  type TokenCapability,
} from '../api/tokenCapability';

/** Subscribe to the token-capability external store. */
export function useTokenCapability(): TokenCapability {
  return useSyncExternalStore(subscribeTokenCapability, getTokenCapability, getTokenCapability);
}

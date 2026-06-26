import { useEffect, useReducer } from 'react';
import {
  getRequestStats,
  subscribeRequestStats,
  type RequestStats,
} from '../api/requestStats';

/** Live request stats over the sliding 1h window (re-renders on new requests + a tick). */
export function useRequestStats(): RequestStats {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const unsub = subscribeRequestStats(tick);
    const id = setInterval(tick, 5000); // advance the sliding window
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);
  return getRequestStats();
}

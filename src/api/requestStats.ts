/**
 * Records every network request the app makes (fresh 200, conditional 304, or
 * error) and exposes counts over a **sliding 1-hour window**. Events are
 * persisted to localStorage and pruned to the window on load and on each record,
 * so the store self-cleans by TTL (anything older than the window is dropped).
 */

export type RequestKind = 'fresh' | 'cached' | 'error';

interface ReqEvent {
  ts: number;
  kind: RequestKind;
}

export interface RequestStats {
  total: number;
  fresh: number;
  cached: number;
  error: number;
  windowMs: number;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const STORAGE_KEY = 'job-monitor.reqstats';
const MAX_EVENTS = 5000; // safety cap

const listeners = new Set<() => void>();

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function load(): ReqEvent[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ReqEvent[];
    const cut = Date.now() - WINDOW_MS;
    return Array.isArray(arr)
      ? arr.filter((e) => e && typeof e.ts === 'number' && e.ts >= cut)
      : [];
  } catch {
    return [];
  }
}

let events: ReqEvent[] = load();

function persist(): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    /* quota — non-fatal */
  }
}

/** Drop events older than the window (events are append-ordered by ts). */
function prune(now: number): void {
  const cut = now - WINDOW_MS;
  let i = 0;
  while (i < events.length && events[i].ts < cut) i++;
  if (i > 0) events.splice(0, i);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function emit(): void {
  for (const l of listeners) l();
}

export function recordRequest(kind: RequestKind): void {
  const now = Date.now();
  events.push({ ts: now, kind });
  prune(now);
  persist();
  emit();
}

export function getRequestStats(now: number = Date.now()): RequestStats {
  prune(now);
  const cut = now - WINDOW_MS;
  let fresh = 0;
  let cached = 0;
  let error = 0;
  for (const e of events) {
    if (e.ts < cut) continue;
    if (e.kind === 'fresh') fresh++;
    else if (e.kind === 'cached') cached++;
    else error++;
  }
  return { total: fresh + cached + error, fresh, cached, error, windowMs: WINDOW_MS };
}

export function subscribeRequestStats(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function clearRequestStats(): void {
  events = [];
  persist();
  emit();
}

/**
 * A small keyed cache in localStorage with a TTL and hard size limits.
 *
 * Exists because several things worth remembering across a reload are *immutable
 * once fetched* — a completed job's annotations and logs never change — so the only
 * reason to refetch them is that we forgot. The limits are the important part:
 * localStorage is a shared ~5 MB budget, and `githubClient` reacts to a quota error
 * by wiping its **entire** ETag namespace, so an unbounded cache here would degrade
 * something unrelated. Entries are therefore capped by count *and* by serialized
 * bytes, evicting least-recently-written first.
 *
 * Reads are served from an in-memory copy, so repeated lookups cost nothing.
 */

interface Entry<T> {
  /** Epoch ms of the write, for TTL and cross-session recency. */
  at: number;
  /**
   * Monotonic write counter, breaking `at` ties. Without it a burst of writes in
   * the same millisecond all compare equal, and the stable sort would then evict
   * the *newest* entries — the exact opposite of what eviction is for. Only
   * meaningful within a session; `at` orders across sessions.
   */
  seq: number;
  value: T;
}

let writeSeq = 0;

export interface TtlCacheOptions {
  /** localStorage key holding the whole map. */
  storageKey: string;
  ttlMs: number;
  maxEntries: number;
  /** Ceiling on the serialized map; oldest entries are dropped to fit. */
  maxBytes: number;
}

export interface TtlCache<T> {
  get(id: string): T | undefined;
  /** Everything currently live, for bulk hydration. */
  entries(): [string, T][];
  set(id: string, value: T): void;
  setMany(items: readonly [string, T][]): void;
  clear(): void;
}

export function createTtlCache<T>(options: TtlCacheOptions): TtlCache<T> {
  const { storageKey, ttlMs, maxEntries, maxBytes } = options;
  let memory: Map<string, Entry<T>> | null = null;

  function live(now: number): Map<string, Entry<T>> {
    if (memory) return memory;
    memory = new Map();
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, Entry<T>>;
        for (const [id, entry] of Object.entries(parsed ?? {})) {
          if (entry && typeof entry.at === 'number' && now - entry.at <= ttlMs) {
            memory.set(id, entry);
          }
        }
      }
    } catch {
      // Corrupt or unreadable — start empty rather than fail the caller.
    }
    return memory;
  }

  /** Newest first, so trimming from the end drops the least recently written. */
  function byRecency(a: [string, Entry<T>], b: [string, Entry<T>]): number {
    return b[1].at - a[1].at || (b[1].seq ?? 0) - (a[1].seq ?? 0);
  }

  function persist(now: number): void {
    const map = live(now);
    let kept = [...map.entries()]
      .filter(([, e]) => now - e.at <= ttlMs)
      .sort(byRecency)
      .slice(0, maxEntries);

    try {
      // Shrink until it fits the byte budget. Log tails dominate the size, so a
      // handful of large entries can otherwise blow the whole budget.
      let serialized = JSON.stringify(Object.fromEntries(kept));
      while (kept.length > 0 && serialized.length > maxBytes) {
        kept = kept.slice(0, Math.max(0, kept.length - Math.ceil(kept.length / 4)));
        serialized = JSON.stringify(Object.fromEntries(kept));
      }
      memory = new Map(kept);
      if (kept.length === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, serialized);
    } catch {
      // Quota or unavailable: keep serving from memory this session.
      memory = new Map(kept);
    }
  }

  return {
    get(id) {
      const now = Date.now();
      const entry = live(now).get(id);
      if (!entry) return undefined;
      if (now - entry.at > ttlMs) {
        live(now).delete(id);
        return undefined;
      }
      return entry.value;
    },

    entries() {
      const now = Date.now();
      return [...live(now).entries()]
        .filter(([, e]) => now - e.at <= ttlMs)
        .map(([id, e]) => [id, e.value] as [string, T]);
    },

    set(id, value) {
      const now = Date.now();
      live(now).set(id, { at: now, seq: ++writeSeq, value });
      persist(now);
    },

    setMany(items) {
      if (items.length === 0) return;
      const now = Date.now();
      const map = live(now);
      for (const [id, value] of items) map.set(id, { at: now, seq: ++writeSeq, value });
      persist(now);
    },

    clear() {
      memory = new Map();
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    },
  };
}

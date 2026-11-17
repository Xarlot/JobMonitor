/**
 * A keyed cache in an IndexedDB object store, with a TTL and an entry cap.
 *
 * The IndexedDB counterpart of `localTtlCache`, for values too big for localStorage: its quota is a
 * share of the disk rather than a shared ~5 MB, and each entry is its own record, so writing one
 * does not re-serialise the rest. The price is that reading is asynchronous — `load()` resolves
 * once per session, and `peek()` serves the loaded copy synchronously after that.
 *
 * Storage failures (private mode, a blocked database) degrade to an in-memory cache for the
 * session: the caller refetches, which is what it would do with no cache at all.
 */

import { idbEntries, idbWrite } from './db';

interface Entry<T> {
  /** Epoch ms of the write, for TTL and eviction order. */
  at: number;
  value: T;
}

export interface IdbTtlCacheOptions {
  store: string;
  ttlMs: number;
  maxEntries: number;
}

export interface IdbTtlCache<T> {
  /** Everything live, read from IndexedDB on the first call; expired records are deleted. */
  load(): Promise<[string, T][]>;
  /** What `load()` gave plus later writes, or null before the first load has finished. */
  peek(): [string, T][] | null;
  /** One live entry, from what has been loaded or written this session. */
  get(id: string): T | undefined;
  setMany(items: readonly [string, T][]): Promise<void>;
}

export function createIdbTtlCache<T>(options: IdbTtlCacheOptions): IdbTtlCache<T> {
  const { store, ttlMs, maxEntries } = options;
  const memory = new Map<string, Entry<T>>();
  let loaded = false;
  let loading: Promise<void> | null = null;

  const isLive = (e: Entry<T>, now: number) => now - e.at <= ttlMs;

  function live(): [string, T][] {
    const now = Date.now();
    return [...memory.entries()].filter(([, e]) => isLive(e, now)).map(([id, e]) => [id, e.value]);
  }

  /** Keys to delete so that only live entries remain, at most `maxEntries`, newest kept. */
  function overflow(): string[] {
    const now = Date.now();
    const sorted = [...memory.entries()].sort((a, b) => b[1].at - a[1].at);
    const drop = sorted.filter(([, e], i) => i >= maxEntries || !isLive(e, now)).map(([id]) => id);
    for (const id of drop) memory.delete(id);
    return drop;
  }

  async function readAll(): Promise<void> {
    try {
      for (const [id, entry] of await idbEntries<Entry<T>>(store)) {
        // A write made while the read was in flight is newer than what the read found.
        if (entry && typeof entry.at === 'number' && !memory.has(id)) memory.set(id, entry);
      }
      const drop = overflow();
      if (drop.length > 0) await idbWrite(store, [], drop);
    } catch {
      // Unavailable or corrupt — serve this session from memory.
    }
    loaded = true;
  }

  return {
    async load() {
      loading ??= readAll();
      await loading;
      return live();
    },

    peek() {
      return loaded ? live() : null;
    },

    get(id) {
      const entry = memory.get(id);
      return entry && isLive(entry, Date.now()) ? entry.value : undefined;
    },

    async setMany(items) {
      if (items.length === 0) return;
      const at = Date.now();
      const puts = items.map(([id, value]) => [id, { at, value }] as [string, Entry<T>]);
      for (const [id, entry] of puts) memory.set(id, entry);
      const drop = overflow();
      try {
        await idbWrite(
          store,
          puts.filter(([id]) => memory.has(id)),
          drop,
        );
      } catch {
        // Kept in memory for this session.
      }
    },
  };
}

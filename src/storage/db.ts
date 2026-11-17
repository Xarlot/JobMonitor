/**
 * Minimal promise-based IndexedDB wrapper (no dependency).
 *
 * Object stores hold non-indexed values by string key:
 * - `kv` — the encrypted token envelope;
 * - `runJobs` — finished runs' job lists, too big for localStorage's shared ~5 MB (a single matrix
 *   run is megabytes). See `idbTtlCache`.
 * Everything small and needed synchronously at startup lives in localStorage.
 */

const DB_NAME = 'job-monitor';
const DB_VERSION = 3;
export const KV_STORE = 'kv';
export const FLOW_RUN_JOBS_STORE = 'runJobs';
const STORES = [KV_STORE, FLOW_RUN_JOBS_STORE];
/** Stores of earlier versions, dropped on upgrade. `flowRunJobs` held failing jobs only. */
const RETIRED_STORES = ['flowRunJobs'];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      for (const name of RETIRED_STORES) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another window upgrading the schema must not be blocked by this connection.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  }).catch((e) => {
    dbPromise = null; // let a later call try again
    throw e;
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = fn(transaction.objectStore(store));
        transaction.oncomplete = () => resolve(request ? request.result : (undefined as T));
        transaction.onabort = transaction.onerror = () =>
          reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      }),
  );
}

export function idbGet<T>(key: string, store = KV_STORE): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbSet<T>(key: string, value: T, store = KV_STORE): Promise<void> {
  return tx(store, 'readwrite', (s) => s.put(value as unknown as object, key)).then(() => undefined);
}

export function idbDelete(key: string, store = KV_STORE): Promise<void> {
  return tx(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
}

/** Every key/value pair of a store, in one transaction. */
export function idbEntries<T>(store: string): Promise<[string, T][]> {
  let keys: IDBValidKey[] = [];
  let values: T[] = [];
  return tx<void>(store, 'readonly', (s) => {
    s.getAllKeys().onsuccess = (e) => {
      keys = (e.target as IDBRequest<IDBValidKey[]>).result;
    };
    s.getAll().onsuccess = (e) => {
      values = (e.target as IDBRequest<T[]>).result;
    };
  }).then(() => keys.map((k, i) => [String(k), values[i]] as [string, T]));
}

/** Puts and deletes in one transaction. */
export function idbWrite<T>(
  store: string,
  puts: readonly [string, T][],
  deletes: readonly string[] = [],
): Promise<void> {
  return tx<void>(store, 'readwrite', (s) => {
    for (const key of deletes) s.delete(key);
    for (const [key, value] of puts) s.put(value as unknown as object, key);
  });
}

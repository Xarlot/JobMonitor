/**
 * Minimal promise-based IndexedDB wrapper (no dependency).
 *
 * A single object store `kv` holds non-indexed values by string key. Used only
 * for the encrypted token envelope — everything non-secret lives in localStorage.
 */

const DB_NAME = 'job-monitor';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = fn(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = transaction.onerror = () =>
          reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      }),
  );
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return tx<T | undefined>('readonly', (store) => store.get(key) as IDBRequest<T | undefined>);
}

export function idbSet<T>(key: string, value: T): Promise<void> {
  return tx('readwrite', (store) => store.put(value as unknown as object, key)).then(() => undefined);
}

export function idbDelete(key: string): Promise<void> {
  return tx('readwrite', (store) => store.delete(key)).then(() => undefined);
}

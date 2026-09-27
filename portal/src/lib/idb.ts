// Minimal promise wrapper over IndexedDB, for caches that outgrow localStorage.
//
// localStorage is a ~5 MB cliff shared by everything the app keeps there, and it
// is synchronous — so a cache of anything page-sized (a drawing's stroke JSON
// plus its baked SVG runs to hundreds of KB) either blows the quota or has to
// refuse its biggest entries, which are the ones worth caching most. IndexedDB
// has room and stays off the main thread.
//
// Every operation resolves rather than rejects: the store is unavailable in
// private mode, when site data is blocked, and intermittently in Safari. A
// cache that cannot be reached is a missing optimisation, never an error a
// caller should have to handle — so reads come back null and writes are dropped.
//
// Deliberately keyval-shaped. Nothing here needs indexes or cursors, and a
// smaller surface is a smaller thing to be wrong about.

const DB_NAME    = 'pghubtech'
const DB_VERSION = 1

/** Add a store by listing it here and bumping DB_VERSION. */
const STORES = ['scratch'] as const
export type StoreName = typeof STORES[number]

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(DB_NAME, DB_VERSION) }
    catch { resolve(null); return }            // blocked entirely (some private modes)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => resolve(null)
    // Another tab holds an older version open. Giving up is right: this is a
    // cache, and waiting would stall whatever is waiting on us.
    req.onblocked = () => resolve(null)
  })
  // A failed open should not poison every later call.
  void dbPromise.then(db => { if (!db) dbPromise = null })
  return dbPromise
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return openDb().then(db => {
    if (!db) return null
    return new Promise<T | null>(resolve => {
      let req: IDBRequest
      try { req = body(db.transaction(store, mode).objectStore(store)) }
      catch { resolve(null); return }
      req.onsuccess = () => resolve(req.result as T)
      req.onerror   = () => resolve(null)      // quota, or a store that vanished
    })
  }).catch(() => null)
}

export function idbGet<T>(store: StoreName, key: string): Promise<T | null> {
  return run<T>(store, 'readonly', s => s.get(key))
}

export function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  return run(store, 'readwrite', s => s.put(value, key)).then(() => undefined)
}

export function idbDel(store: StoreName, key: string): Promise<void> {
  return run(store, 'readwrite', s => s.delete(key)).then(() => undefined)
}

// Minimal IndexedDB wrapper (no external deps). All story data lives here —
// never localStorage — so very long documents stay supported.

const DB_NAME = 'pairquill'
const LEGACY_DB_NAME = 'pairui'
const DB_VERSION = 1

type StoreName = 'documents' | 'profiles' | 'settings' | 'generations'

let dbPromise: Promise<IDBDatabase> | null = null

async function migrateLegacyDB(newDb: IDBDatabase): Promise<void> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return
  try {
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === LEGACY_DB_NAME)) return

    // Don't overwrite if newDb already has documents
    const docCount = await new Promise<number>((res) => {
      const tx = newDb.transaction('documents', 'readonly')
      const req = tx.objectStore('documents').count()
      req.onsuccess = () => res(req.result)
      req.onerror = () => res(0)
    })
    if (docCount > 0) return

    const legacyDb = await new Promise<IDBDatabase>((res, rej) => {
      const req = indexedDB.open(LEGACY_DB_NAME, 1)
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })

    const stores: StoreName[] = ['documents', 'profiles', 'settings', 'generations']
    const available = stores.filter((s) => legacyDb.objectStoreNames.contains(s))
    if (available.length > 0) {
      const legacyTx = legacyDb.transaction(available, 'readonly')
      const newTx = newDb.transaction(stores, 'readwrite')

      for (const store of available) {
        const target = newTx.objectStore(store)
        if (store === 'settings') {
          const getReq = legacyTx.objectStore(store).get('app')
          getReq.onsuccess = () => {
            if (getReq.result !== undefined) target.put(getReq.result, 'app')
          }
        } else {
          const getReq = legacyTx.objectStore(store).getAll()
          getReq.onsuccess = () => {
            if (Array.isArray(getReq.result)) {
              for (const item of getReq.result) target.put(item)
            }
          }
        }
      }

      await new Promise<void>((res) => {
        newTx.oncomplete = () => res()
        newTx.onerror = () => res()
      })
    }
    legacyDb.close()
  } catch {
    // Non-fatal if legacy migration fails
  }
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings')
      if (!db.objectStoreNames.contains('generations')) db.createObjectStore('generations', { keyPath: 'id' })
    }
    req.onsuccess = async () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      try {
        await migrateLegacyDB(db)
      } catch {}
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error ?? new Error('Failed to open IndexedDB'))
    }
  })
  return dbPromise
}

export async function requestPersistentStorage(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      await navigator.storage.persist()
    }
  } catch {
    /* ignore */
  }
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
      }),
  )
}

export function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
  return run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)))
}

export function idbPutMany(store: StoreName, items: unknown[]): Promise<void> {
  if (items.length === 0) return Promise.resolve()
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        const s = tx.objectStore(store)
        for (const item of items) s.put(item)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB batch write failed'))
      }),
  )
}

export function idbDeleteMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve()
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        const s = tx.objectStore(store)
        for (const k of keys) s.delete(k)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB batch delete failed'))
      }),
  )
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, 'readonly', (s) => s.getAll())
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<undefined> {
  return run(store, 'readwrite', (s) => s.delete(key))
}


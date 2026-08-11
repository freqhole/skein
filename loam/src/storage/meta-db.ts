// ---------------------------------------------------------------------------
// shared IndexedDB helpers for the skein-meta key-value store.
//
// this module owns the "skein-meta" database that holds small metadata
// values (narthex doc id, identity records, etc.) separate from
// automerge's own indexeddb storage so we don't couple to its schema.
//
// in tauri mode, getMetaValue/setMetaValue transparently route through
// skein_dispatch to the tauri app's own sqlite-backed `meta_kv` table
// instead of indexeddb (tauri's webview indexeddb is unreliable to depend
// on long-term — see docs/tauri-progress.md).
// ---------------------------------------------------------------------------

import { dispatch, isTauriMode } from "../p2p/tauri-transport";

/** database name used for skein metadata persistence. */
export const NARTHEX_DB_NAME = "skein-meta";

/** the single object store inside the meta database. */
export const META_STORE_NAME = "kv";

/**
 * open (or create) the skein-meta indexeddb database.
 *
 * version 1 creates the "kv" object store if it doesn't already exist.
 * callers are responsible for closing the returned database when done.
 */
export async function openMetaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NARTHEX_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * read a plain string value directly from indexeddb, bypassing tauri mode.
 *
 * returns `null` when the key does not exist.
 */
async function getMetaValueFromIndexedDb(key: string): Promise<string | null> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readonly");
    const store = tx.objectStore(META_STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * read a plain string value from the meta store.
 *
 * returns `null` when the key does not exist.
 */
export async function getMetaValue(key: string): Promise<string | null> {
  if (isTauriMode()) {
    const result = await dispatch("meta_get_value", { key });
    const sqliteValue = (result?.value as string | undefined) ?? null;
    if (sqliteValue !== null) return sqliteValue;

    // one-time backfill: existing tauri installs (before the meta_kv sqlite
    // table existed) had this value in the webview's own indexeddb, which is
    // still readable here — fall back to it so an install doesn't silently
    // "lose" a narthex/profile/canvas-bin doc id and see an empty canvas
    // list. write it into sqlite so future reads hit the fast path.
    const legacyValue = await getMetaValueFromIndexedDb(key).catch(() => null);
    if (legacyValue !== null) {
      await dispatch("meta_set_value", { key, value: legacyValue }).catch(() => undefined);
    }
    return legacyValue;
  }
  return getMetaValueFromIndexedDb(key);
}

/**
 * write a plain string value into the meta store.
 */
export async function setMetaValue(key: string, value: string): Promise<void> {
  if (isTauriMode()) {
    await dispatch("meta_set_value", { key, value });
    return;
  }
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readwrite");
    const store = tx.objectStore(META_STORE_NAME);
    store.put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * read a structured record from the meta store.
 *
 * the value is stored as-is by indexeddb's structured clone algorithm,
 * so any cloneable object (plain objects, arrays, dates, etc.) works.
 * returns `null` when the key does not exist.
 */
export async function getMetaRecord<T>(key: string): Promise<T | null> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readonly");
    const store = tx.objectStore(META_STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * write a structured record into the meta store.
 *
 * the value is persisted using indexeddb's structured clone algorithm,
 * so any cloneable object (plain objects, arrays, dates, etc.) works.
 */
export async function setMetaRecord<T>(key: string, value: T): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readwrite");
    const store = tx.objectStore(META_STORE_NAME);
    store.put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * delete a record from the meta store by key.
 *
 * resolves silently if the key does not exist.
 */
export async function deleteMetaRecord(key: string): Promise<void> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readwrite");
    const store = tx.objectStore(META_STORE_NAME);
    store.delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// ---------------------------------------------------------------------------
// skein blob store — browser-mode blob storage using OPFS for raw bytes
// and raw IndexedDB for metadata.
//
// follows the meta-db.ts pattern: open the database fresh for each
// operation, close it when done. no idb library dependency.
// ---------------------------------------------------------------------------

// ---- interfaces -----------------------------------------------------------

export interface SkeinBlobRecord {
  blob_id: string;
  sha256: string;
  blake3: string;
  filename: string;
  mime: string;
  size: number;
  domain: string;
  blob_type: string;
  parent_blob_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
}

// ---- constants ------------------------------------------------------------

const BLOB_DB_NAME = "skein-blobs";
const BLOB_STORE = "blobs";
const OPFS_DIR = "skein-blobs";
const BAO_OPFS_DIR = "skein-blobs-bao";

// ---- session url cache ----------------------------------------------------

const blobUrlCache = new Map<string, string>();
let beforeUnloadRegistered = false;

function ensureBeforeUnloadListener(): void {
  if (beforeUnloadRegistered) return;
  if (typeof window === "undefined") return;
  window.addEventListener("beforeunload", () => {
    for (const url of blobUrlCache.values()) {
      URL.revokeObjectURL(url);
    }
    blobUrlCache.clear();
  });
  beforeUnloadRegistered = true;
}

/**
 * revoke all cached object urls and clear the cache.
 */
export function clearBlobUrlCache(): void {
  for (const url of blobUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  blobUrlCache.clear();
}

// ---- database helpers -----------------------------------------------------

/**
 * open (or create) the skein-blobs indexeddb database.
 *
 * version history:
 *   v1 — initial: "blobs" + "domain_entities" object stores; sha256 + domain
 *        indexes on blobs.
 *   v2 — added blake3 index to blobs.
 *   v3 — dropped the "domain_entities" store entirely (skein never reads it;
 *        the freqhole-era entity layer is gone). the `domain` field on
 *        SkeinBlobRecord is preserved — the file widget still classifies media
 *        by it.
 *
 * callers are responsible for closing the returned database when done.
 */
export async function openBlobDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BLOB_DB_NAME, 3);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        // fresh install — create the blobs store and all indexes
        const blobStore = db.createObjectStore(BLOB_STORE, {
          keyPath: "blob_id",
        });
        blobStore.createIndex("sha256", "sha256", { unique: false });
        blobStore.createIndex("domain", "domain", { unique: false });
        blobStore.createIndex("blake3", "blake3", { unique: false });
      }

      if (oldVersion < 2) {
        // upgrade from v1 — add blake3 index to existing blobs store
        if (db.objectStoreNames.contains(BLOB_STORE)) {
          const tx = (event.target as IDBOpenDBRequest).transaction!;
          const blobStore = tx.objectStore(BLOB_STORE);
          if (!blobStore.indexNames.contains("blake3")) {
            blobStore.createIndex("blake3", "blake3", { unique: false });
          }
        }
      }

      if (oldVersion < 3) {
        // upgrade from v2 — drop the now-unused "domain_entities" store.
        if (db.objectStoreNames.contains("domain_entities")) {
          db.deleteObjectStore("domain_entities");
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- OPFS helpers ---------------------------------------------------------

/**
 * get (or create) the skein-blobs directory handle in OPFS.
 */
async function getOpfsDir(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create });
  } catch (err) {
    console.warn("[skein-blob-store] OPFS directory access failed:", err);
    return null;
  }
}

// ---- public api -----------------------------------------------------------

/**
 * check whether the origin private file system API is available.
 */
export function isOPFSSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function"
  );
}

/**
 * compute the SHA-256 hash of an ArrayBuffer and return it as a hex string.
 */
export async function computeSha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// blake3 hashing has moved into the blob worker (see
// `src/workers/blob-worker-client.ts`); the upload pipeline calls
// `processBlobBytes` directly so no main-thread wrapper is needed here.

/**
 * classify a MIME type into a domain string.
 */
export function classifyDomain(mime: string): string {
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "document";
  return "file";
}

/**
 * try to write bytes to OPFS via the blob worker (uses
 * `FileSystemSyncAccessHandle` for max throughput when available, falling
 * back to the async writable-stream API). silently no-ops when OPFS or
 * Worker isn't available.
 *
 * NOTE: transfers ownership of `data` to the worker — callers must not
 * use the buffer after this returns. when the buffer is still needed on
 * the main thread, slice it first.
 */
async function tryWriteOpfs(blobId: string, data: ArrayBuffer): Promise<void> {
  try {
    const { writeBlobToOpfs } = await import("../workers/blob-worker-client");
    await writeBlobToOpfs(blobId, data);
  } catch (err) {
    console.warn("[skein-blob-store] tryWriteOpfs failed for", blobId.slice(0, 16), err);
  }
}

/**
 * store raw blob bytes in OPFS and write the metadata record to IndexedDB.
 *
 * the `meta` parameter should contain everything except `created_at`,
 * which is set automatically to `Date.now()`.
 */
export async function storeBlob(
  blobId: string,
  data: ArrayBuffer,
  meta: Omit<SkeinBlobRecord, "created_at">
): Promise<void> {
  // write bytes to OPFS — best-effort. webkit (tauri's webview) does not
  // expose `createWritable()` on the main thread; in that case the bytes
  // are expected to live in the rust-side blob store and `getBlobData()`
  // will fall back to a `blob_get` dispatch.
  await tryWriteOpfs(blobId, data);

  // write metadata record to IndexedDB
  const record: SkeinBlobRecord = {
    ...meta,
    created_at: Date.now(),
  };

  const db = await openBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readwrite");
    const store = tx.objectStore(BLOB_STORE);
    store.put(record);
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
 * convenience method to store a browser File object as a blob.
 *
 * uses the SHA-256 hash of the file content as the blob_id for
 * content-addressed deduplication. if a blob with the same id already
 * exists, the existing record is returned without writing again.
 */
export async function storeBlobFromFile(file: File, domain?: string): Promise<SkeinBlobRecord> {
  const buffer = await file.arrayBuffer();
  const mime = file.type || "application/octet-stream";

  // hand the whole upload pipeline to the blob worker: sha256 + blake3
  // hashing AND the OPFS write happen off the main thread in a single
  // round-trip. transfers ownership of `buffer` \u2014 do not use it after.
  const { processBlobBytes } = await import("../workers/blob-worker-client");
  const processed = await processBlobBytes(buffer, file.name, mime);
  const blobId = processed.sha256;

  // dedup \u2014 return existing record if already stored. (the worker has
  // already written the bytes to OPFS, but that's a no-op overwrite of an
  // identical content-addressed file.)
  const existing = await getBlobRecord(blobId);
  if (existing) return existing;

  const resolvedDomain = domain ?? classifyDomain(mime);

  const record: SkeinBlobRecord = {
    blob_id: blobId,
    sha256: processed.sha256,
    blake3: processed.blake3,
    filename: file.name,
    mime,
    size: processed.size,
    domain: resolvedDomain,
    blob_type: "original",
    parent_blob_id: null,
    metadata: {},
    created_at: Date.now(),
  };

  // bypass storeBlob() because the worker already wrote OPFS bytes \u2014
  // we just need to persist the IndexedDB metadata record.
  const db = await openBlobDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readwrite");
    tx.objectStore(BLOB_STORE).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });

  const stored = await getBlobRecord(blobId);
  return stored!;
}

/**
 * update the blake3 hash for an existing blob record.
 */
export async function updateBlake3(blobId: string, blake3: string): Promise<void> {
  const db = await openBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readwrite");
    const store = tx.objectStore(BLOB_STORE);
    const getReq = store.get(blobId);
    getReq.onsuccess = () => {
      const record = getReq.result as SkeinBlobRecord | undefined;
      if (record) {
        record.blake3 = blake3;
        store.put(record);
      }
    };
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
 * retrieve a blob metadata record by its id.
 *
 * returns `null` when the blob does not exist. on tauri, blob ids are
 * blake3 hashes, so a miss falls back to a rust-side blobz lookup.
 */
export async function getBlobRecord(blobId: string): Promise<SkeinBlobRecord | null> {
  const db = await openBlobDb();
  const fromIdb = await new Promise<SkeinBlobRecord | null>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readonly");
    const store = tx.objectStore(BLOB_STORE);
    const req = store.get(blobId);
    req.onsuccess = () => resolve((req.result as SkeinBlobRecord) ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
  if (fromIdb) return fromIdb;
  return tauriBlobRecordByBlake3(blobId);
}

/**
 * look up a blob record by its sha256 hash using the sha256 index.
 *
 * returns `null` when no matching record is found.
 */
export async function getBlobRecordBySha256(sha256: string): Promise<SkeinBlobRecord | null> {
  if (!sha256) return null;
  const db = await openBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readonly");
    const store = tx.objectStore(BLOB_STORE);
    const index = store.index("sha256");
    const req = index.get(sha256);
    req.onsuccess = () => resolve((req.result as SkeinBlobRecord) ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * look up a blob record by its blake3 hash using the blake3 index.
 *
 * returns `null` when no matching record is found.
 */
export async function getBlobRecordByBlake3(blake3Hash: string): Promise<SkeinBlobRecord | null> {
  if (!blake3Hash) return null;
  const db = await openBlobDb();
  const fromIdb = await new Promise<SkeinBlobRecord | null>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readonly");
    const store = tx.objectStore(BLOB_STORE);
    const index = store.index("blake3");
    const req = index.get(blake3Hash);
    req.onsuccess = () => resolve((req.result as SkeinBlobRecord) ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
  if (fromIdb) return fromIdb;

  // tauri fallback: rust blobz is keyed by blake3, so try a path lookup.
  return tauriBlobRecordByBlake3(blake3Hash);
}

/**
 * look up a blob record by querying the rust blobz store via IPC. used as
 * a fallback when the IDB index misses (eg. blobs uploaded directly into
 * the tauri app never touch IDB). returns null in browser mode.
 */
async function tauriBlobRecordByBlake3(blake3Hash: string): Promise<SkeinBlobRecord | null> {
  try {
    const { isTauriMode, dispatch } = await import("../p2p/tauri-transport");
    if (!isTauriMode()) return null;
    const response = (await dispatch("blob_get_path", { blake3: blake3Hash })) as {
      path?: string;
      mime?: string | null;
      size?: number | null;
    } | null;
    if (!response?.path) return null;
    return synthesizeTauriRecord(blake3Hash, response.mime ?? "", response.size ?? 0);
  } catch {
    return null;
  }
}

/**
 * build a minimal SkeinBlobRecord from rust-side blobz metadata. rust uses
 * blake3 as the canonical id, so blob_id and blake3 are the same; sha256 is
 * not tracked there and stays empty.
 */
function synthesizeTauriRecord(
  blake3Hash: string,
  mime: string,
  size: number
): SkeinBlobRecord {
  return {
    blob_id: blake3Hash,
    sha256: "",
    blake3: blake3Hash,
    filename: "",
    mime: mime || "application/octet-stream",
    size,
    domain: classifyDomain(mime || ""),
    blob_type: "original",
    parent_blob_id: null,
    metadata: { source: "tauri" },
    created_at: Date.now(),
  };
}

/**
 * read the raw blob bytes from OPFS, with a tauri fallback to the
 * rust-side blob store via `blob_get` when OPFS doesn't have the bytes
 * (eg. webkit can't write OPFS on the main thread, so the canonical
 * copy lives in reliquary).
 *
 * returns `null` if the bytes can't be located anywhere.
 */
export async function getBlobData(blobId: string): Promise<ArrayBuffer | null> {
  try {
    const dir = await getOpfsDir(false);
    if (dir) {
      try {
        const fileHandle = await dir.getFileHandle(blobId);
        const file = await fileHandle.getFile();
        return await file.arrayBuffer();
      } catch {
        // fall through to tauri fallback below
      }
    }
  } catch (err) {
    console.warn("[skein-blob-store] getBlobData OPFS access failed for", blobId, err);
  }

  // tauri fallback — ask the rust side for the bytes by blake3.
  try {
    const { isTauriMode, dispatch } = await import("../p2p/tauri-transport");
    if (!isTauriMode()) return null;
    const response = (await dispatch("blob_get", { blake3: blobId })) as
      | { data: string }
      | null;
    if (!response?.data) return null;
    // base64 decode delegated to the blob worker — these payloads are
    // routinely megabyte-scale (full blob bytes shipped over IPC).
    const { base64Decode } = await import("../workers/blob-worker-client");
    const out = await base64Decode(response.data);
    // best-effort: cache the bytes back into OPFS so future reads are local.
    // (no-op on webkit where createWritable is missing.)
    void tryWriteOpfs(blobId, out.buffer as ArrayBuffer);
    return out.buffer as ArrayBuffer;
  } catch (err) {
    console.warn("[skein-blob-store] getBlobData tauri fallback failed for", blobId, err);
    return null;
  }
}

// ---- bao outboard OPFS cache ----------------------------------------------

/**
 * get (or create) the bao cache directory handle in OPFS.
 */
async function getBaoOpfsDir(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(BAO_OPFS_DIR, { create });
  } catch (err) {
    console.warn("[skein-blob-store] bao OPFS directory access failed:", err);
    return null;
  }
}

/**
 * store bao-encoded bytes (data + outboard tree interleaved) in OPFS.
 *
 * keyed by blake3 hash so it can be looked up when a peer requests the blob
 * via ensure_blob. the bao data is the format returned by iroh-blobs
 * `export_bao().bao_to_vec()` and accepted by `import_bao_bytes()`.
 */
export async function storeBaoData(blake3Hash: string, baoData: ArrayBuffer): Promise<void> {
  const dir = await getBaoOpfsDir(true);
  if (!dir) {
    console.warn("[skein-blob-store] cannot store bao data — OPFS unavailable");
    return;
  }
  try {
    const fileHandle = await dir.getFileHandle(blake3Hash, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(baoData);
    await writable.close();
  } catch (err) {
    console.warn("[skein-blob-store] storeBaoData failed for", blake3Hash.slice(0, 16), err);
  }
}

/**
 * retrieve cached bao-encoded bytes for a given blake3 hash.
 *
 * returns null if no cached bao data exists or OPFS is unavailable.
 */
export async function getBaoData(blake3Hash: string): Promise<ArrayBuffer | null> {
  try {
    const dir = await getBaoOpfsDir(false);
    if (!dir) return null;
    const fileHandle = await dir.getFileHandle(blake3Hash);
    const file = await fileHandle.getFile();
    return await file.arrayBuffer();
  } catch {
    // file not found or OPFS unavailable — expected for blobs without cached bao
    return null;
  }
}

/**
 * delete cached bao data for a given blake3 hash.
 */
export async function deleteBaoData(blake3Hash: string): Promise<void> {
  try {
    const dir = await getBaoOpfsDir(false);
    if (dir) {
      await dir.removeEntry(blake3Hash);
    }
  } catch {
    // file may not exist — that's fine
  }
}

/**
 * resolve a blobId to a SkeinBlobRecord using multiple lookup strategies.
 * tries: primary key → sha256 index → blake3 index (if provided).
 *
 * this handles the case where the automerge doc's blobId was overwritten
 * by a Tauri peer with a server-assigned UUID that doesn't match the
 * browser's sha256-based primary key.
 */
export async function resolveBlob(
  blobId: string,
  blake3?: string
): Promise<SkeinBlobRecord | null> {
  if (!blobId) return null;

  // 1. try primary key (most common case — blobId IS the sha256)
  const byKey = await getBlobRecord(blobId);
  if (byKey) return byKey;

  // 2. try sha256 index (blobId might be stored as sha256 but under a different primary key)
  const bySha = await getBlobRecordBySha256(blobId);
  if (bySha) return bySha;

  // 3. try blake3 index if available
  if (blake3) {
    const byBlake3 = await getBlobRecordByBlake3(blake3);
    if (byBlake3) return byBlake3;
  }

  return null;
}

/**
 * resolve a blobId and return the raw data from OPFS.
 * uses resolveBlob to find the correct IDB record, then reads OPFS
 * using the record's actual blob_id (which is the OPFS filename).
 */
export async function resolveBlobData(
  blobId: string,
  blake3?: string
): Promise<{ record: SkeinBlobRecord; data: ArrayBuffer } | null> {
  const record = await resolveBlob(blobId, blake3);
  if (!record) return null;

  const data = await getBlobData(record.blob_id);
  if (!data) return null;

  return { record, data };
}

/**
 * check whether a blob record exists in the store.
 */
export async function hasBlob(blobId: string): Promise<boolean> {
  const record = await getBlobRecord(blobId);
  return record !== null;
}

/**
 * get (or create) a temporary object url for a stored blob.
 *
 * urls are cached for the lifetime of the page session and revoked
 * automatically on beforeunload. returns `null` if the blob is not found.
 */
export async function getBlobObjectURL(blobId: string): Promise<string | null> {
  ensureBeforeUnloadListener();

  // check the session cache first
  const cached = blobUrlCache.get(blobId);
  if (cached) return cached;

  const record = await resolveBlob(blobId);
  if (!record) return null;

  const data = await getBlobData(record.blob_id);
  if (!data) return null;

  const mime = record.mime ?? "application/octet-stream";

  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(blobId, url);
  return url;
}

// ---- deletion -------------------------------------------------------------

/**
 * delete a blob and all associated data.
 *
 * removes the OPFS file, the IndexedDB metadata record, the cached bao
 * outboard data, and any cached object url.
 */
export async function deleteBlob(blobId: string): Promise<void> {
  // look up the record so we can clean up the bao cache by blake3 hash
  const record = await getBlobRecord(blobId);
  if (record?.blake3) {
    await deleteBaoData(record.blake3);
  }

  // remove from OPFS
  try {
    const dir = await getOpfsDir(false);
    if (dir) {
      await dir.removeEntry(blobId);
    }
  } catch {
    // file may not exist — that's fine
  }

  // revoke any cached url
  const cachedUrl = blobUrlCache.get(blobId);
  if (cachedUrl) {
    URL.revokeObjectURL(cachedUrl);
    blobUrlCache.delete(blobId);
  }

  // delete the blob record from IDB
  const db = await openBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readwrite");
    tx.objectStore(BLOB_STORE).delete(blobId);
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
 * clear all blob data — the IndexedDB blob store, both OPFS directories,
 * and the session url cache.
 */
export async function clearAll(): Promise<void> {
  // clear the url cache
  clearBlobUrlCache();

  // clear the blob store
  const db = await openBlobDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readwrite");
    tx.objectStore(BLOB_STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });

  // remove the OPFS directories (blobs + bao cache)
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_DIR, { recursive: true });
  } catch {
    // directory may not exist — that's fine
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(BAO_OPFS_DIR, { recursive: true });
  } catch {
    // directory may not exist — that's fine
  }
}

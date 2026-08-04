// ---------------------------------------------------------------------------
// blob storage for skein — wraps @freqhole/reliquary/blobs's content-
// addressed blob store with the pieces that stay app-specific: file-type
// classification used for widget rendering choices, a lazy File handle for
// chunk-streaming into the p2p node, and an outboard bao tree cache used to
// speed up serving blobs to peers.
//
// domain classification (photo/video/audio/document/file) has no place in
// the shared record shape — it lives in this store's `metadata.domain`
// field instead of a first-class column.
// ---------------------------------------------------------------------------

import { createBlobStore, type BlobRecord } from "@freqhole/reliquary/blobs";
import { BLOB_OPFS_DIR } from "@freqhole/reliquary/worker";

export type { BlobRecord, ListBlobsOptions, ListBlobsPage } from "@freqhole/reliquary/blobs";

/** IndexedDB database name — matches the name skein has always used, so
 *  existing browser data keeps resolving after adopting the shared store. */
const BLOB_DB_NAME = "skein-blobs";

const store = createBlobStore({
  dbName: BLOB_DB_NAME,
  // opfs-only, throw on failure: a blob record whose bytes silently landed
  // in a fallback cache (or nowhere at all) previously left playback
  // finding nothing with no re-snatch ever offered — fail loudly instead
  // so the caller can retry or surface it.
  allowCacheFallback: false,
});

export const {
  storeBlob,
  storeBlobFromFile,
  getBlobRecord,
  getBlobRecordByBlake3,
  getBlobRecordBySha256,
  resolveBlob,
  getBlobData,
  getBlob,
  getBlobObjectURL,
  clearBlobUrlCache,
  hasBlobBytes,
  checkBlobLocality,
  clearAll,
  addCanvasRef,
  removeCanvasRef,
  getCanvasRefs,
  removeAllCanvasRefsForCanvas,
  listBlobs,
} = store;

/** classify a MIME type into a domain string used for widget rendering
 *  choices (which viewer to show, thumbnail strategy, etc.) — app-level
 *  classification that has no equivalent field on the shared blob record. */
export function classifyDomain(mime: string): string {
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "document";
  return "file";
}

/** read a record's domain back out of its metadata, falling back to a
 *  fresh classification for records that predate this field. */
export function getBlobDomain(record: BlobRecord): string {
  const stored = record.metadata?.domain;
  return typeof stored === "string" ? stored : classifyDomain(record.mime);
}

/**
 * resolve a blobId to both its record and raw bytes in one call — the
 * combination the p2p handler needs to serve a blob's data to a peer.
 */
export async function resolveBlobData(
  blobId: string,
  blake3?: string
): Promise<{ record: BlobRecord; data: ArrayBuffer } | null> {
  const record = await resolveBlob(blobId, blake3);
  if (!record) return null;
  const data = await getBlobData(record.blob_id, record.blake3);
  if (!data) return null;
  return { record, data };
}

/**
 * get a blob's OPFS bytes as a lazily-read File object (no bytes loaded
 * until the caller reads/streams it) — the chunked alternative to
 * getBlobData() for large blobs, feeding a chunk-by-chunk consumer (e.g.
 * midden's ImportSession) without ever materializing the whole payload.
 * returns null when the file is missing.
 */
export async function getBlobFile(blobId: string): Promise<File | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(BLOB_OPFS_DIR, { create: false });
    const fileHandle = await dir.getFileHandle(blobId, { create: false });
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}

/**
 * delete a blob and all associated data: bytes + metadata record (via the
 * shared store), plus any cached bao outboard data this app keeps on the
 * side.
 */
export async function deleteBlob(blobId: string): Promise<void> {
  const record = await store.getBlobRecord(blobId);
  if (record?.blake3) {
    await deleteBaoData(record.blake3);
  }
  await store.deleteBlob(blobId);
}

// ---------------------------------------------------------------------------
// bao outboard tree cache
//
// bao-encoded bytes (data + outboard tree interleaved — the format iroh-
// blobs' export_bao()/import_bao_bytes() produce/accept) cached by blake3
// hash so a peer's ensure_blob request can skip recomputing the tree.
// unrelated to the blake3-keyed blob record store above — its own OPFS
// directory, since bao trees are a p2p-serving optimization, not part of
// the shared blob schema.
// ---------------------------------------------------------------------------

const BAO_OPFS_DIR = "skein-blobs-bao";

async function getBaoOpfsDir(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(BAO_OPFS_DIR, { create });
  } catch (err) {
    console.warn("[blob-store] bao OPFS directory access failed:", err);
    return null;
  }
}

/**
 * store bao-encoded bytes (data + outboard tree interleaved) in OPFS.
 *
 * keyed by blake3 hash so it can be looked up when a peer requests the blob
 * via ensure_blob.
 */
export async function storeBaoData(blake3Hash: string, baoData: ArrayBuffer): Promise<void> {
  const dir = await getBaoOpfsDir(true);
  if (!dir) {
    console.warn("[blob-store] cannot store bao data — OPFS unavailable");
    return;
  }
  try {
    const fileHandle = await dir.getFileHandle(blake3Hash, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(baoData);
    await writable.close();
  } catch (err) {
    console.warn("[blob-store] storeBaoData failed for", blake3Hash.slice(0, 16), err);
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

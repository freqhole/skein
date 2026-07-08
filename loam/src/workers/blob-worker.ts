// blob worker — moves CPU-bound blob work (blake3 hashing, sha256 hashing,
// base64 encode/decode, OPFS writes) off the main thread.
//
// architecture: comlink-exposed module. spun up lazily by `blob-worker-client.ts`
// on first use. shares no state with the main thread other than what's passed
// across postMessage (with transfer ownership for ArrayBuffers).
//
// browser-only — tauri builds alias `midden` to a stub, so blake3 hashing here
// returns "" in tauri mode. callers in tauri mode shouldn't be calling this
// worker at all (rust handles hashing).

import * as Comlink from "comlink";
import * as middenWasm from "@freqhole/midden";

const OPFS_DIR = "skein-blobs";

/**
 * compute blake3 hash of a Uint8Array using midden's WASM module.
 * returns empty string if midden is unavailable.
 *
 * the `data` ArrayBuffer should be transferred (via comlink's `transfer()`)
 * to avoid a copy on the postMessage boundary. callers must not use it after.
 */
async function hashBlake3(data: Uint8Array): Promise<string> {
  try {
    return typeof middenWasm.hash_blake3 === "function" ? middenWasm.hash_blake3(data) : "";
  } catch {
    return "";
  }
}

/**
 * compute sha256 hash via SubtleCrypto. SubtleCrypto.digest is already
 * async/non-blocking on the main thread, but we expose it here too so
 * callers can do sha256 + blake3 in a single round-trip.
 */
async function hashSha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * base64-encode an ArrayBuffer. uses chunked btoa to avoid stack overflow
 * on large buffers (`String.fromCharCode(...veryLargeArray)` blows up).
 */
async function base64Encode(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32 KiB at a time
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * decode a base64 string into a Uint8Array.
 */
async function base64Decode(b64: string): Promise<Uint8Array> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---- OPFS write path ------------------------------------------------------

async function getOpfsDir(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create });
  } catch {
    return null;
  }
}

// minimal structural type for FileSystemSyncAccessHandle — the lib.dom
// typings shipped with our tsconfig don't include it. only the methods we
// actually call are typed.
interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

/**
 * write blob bytes to OPFS. prefers `FileSystemSyncAccessHandle` (worker-only,
 * fastest path on chromium/safari/firefox) and falls back to the async
 * writable-stream API. silently no-ops if OPFS is unavailable.
 *
 * `data` should be transferred across postMessage to avoid a copy.
 */
async function writeBlobToOpfs(blobId: string, data: ArrayBuffer): Promise<void> {
  const dir = await getOpfsDir(true);
  if (!dir) return;
  const fileHandle = await dir.getFileHandle(blobId, { create: true });

  // sync access handle: only available in workers, much faster than
  // createWritable(). uses synchronous I/O on a dedicated I/O thread.
  const createSync = (
    fileHandle as unknown as {
      createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
    }
  ).createSyncAccessHandle;
  if (typeof createSync === "function") {
    let handle: SyncAccessHandle | null = null;
    try {
      handle = await createSync.call(fileHandle);
      handle.truncate(0);
      handle.write(data, { at: 0 });
      handle.flush();
    } finally {
      handle?.close();
    }
    return;
  }

  // fallback: async writable stream (works on main thread too)
  const createWritable = (
    fileHandle as unknown as {
      createWritable?: () => Promise<FileSystemWritableFileStream>;
    }
  ).createWritable;
  if (typeof createWritable !== "function") return;
  const writable = await createWritable.call(fileHandle);
  await writable.write(data);
  await writable.close();
}

/**
 * read blob bytes from OPFS into a transferable ArrayBuffer. returns null
 * if the file doesn't exist or OPFS is unavailable.
 */
async function readBlobFromOpfs(blobId: string): Promise<ArrayBuffer | null> {
  const dir = await getOpfsDir(false);
  if (!dir) return null;
  try {
    const fileHandle = await dir.getFileHandle(blobId, { create: false });
    const file = await fileHandle.getFile();
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

// ---- combo: full upload pipeline ------------------------------------------

export interface ProcessedBlob {
  blob_id: string; // blake3 hex — the canonical content-address for the blob db
  sha256: string; // legacy hash, kept so old records/doc references still resolve
  blake3: string;
  size: number;
  mime: string;
  filename: string;
}

/**
 * one-shot: hash bytes (sha256 + blake3), write to OPFS, return metadata.
 * lets callers avoid three round-trips across the worker boundary for an
 * upload. `data` should be transferred.
 *
 * blake3 is the canonical blob id (matches iroh-blobs / tauri's rust
 * store); sha256 is still computed so legacy sha256-keyed records and old
 * doc references keep resolving via the sha256 index.
 */
async function processBlobBytes(
  data: ArrayBuffer,
  filename: string,
  mime: string
): Promise<ProcessedBlob> {
  // run sha256 and blake3 concurrently. SubtleCrypto.digest does its own
  // copy of the bytes, so we can't transfer-and-reuse — do them in parallel
  // and let the runtime overlap them.
  const [sha256, blake3] = await Promise.all([hashSha256(data), hashBlake3(new Uint8Array(data))]);
  await writeBlobToOpfs(blake3, data);
  return {
    blob_id: blake3,
    sha256,
    blake3,
    size: data.byteLength,
    mime,
    filename,
  };
}

// ---- thumbnail / image resize -------------------------------------------

export interface ResizeImageOptions {
  /** maximum output width in pixels (default: 200) */
  maxWidth?: number;
  /** maximum output height in pixels (default: 200) */
  maxHeight?: number;
  /** WebP quality 0..1 (default: 0.8) */
  quality?: number;
  /** if true, center-crop to a square before resizing */
  cropSquare?: boolean;
  /** output mime type (default: "image/webp") */
  mime?: string;
}

/**
 * resize an image Blob to a WebP data URL via OffscreenCanvas. all heavy
 * work (image decode, resize, WebP encode, base64 encode) happens here in
 * the worker. returns null on any failure.
 *
 * the input Blob is structured-cloned across postMessage by reference
 * (the underlying bytes aren't copied), so this is cheap to call.
 */
async function resizeImageToWebpDataUrl(
  blob: Blob,
  options?: ResizeImageOptions
): Promise<string | null> {
  const maxWidth = options?.maxWidth ?? 200;
  const maxHeight = options?.maxHeight ?? 200;
  const quality = options?.quality ?? 0.8;
  const cropSquare = options?.cropSquare ?? false;
  const mime = options?.mime ?? "image/webp";

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);

    let sx = 0;
    let sy = 0;
    let sw = bitmap.width;
    let sh = bitmap.height;

    if (cropSquare) {
      const minDim = Math.min(bitmap.width, bitmap.height);
      sx = (bitmap.width - minDim) / 2;
      sy = (bitmap.height - minDim) / 2;
      sw = minDim;
      sh = minDim;
    }

    const sourceAspect = sw / sh;
    let outW = sw;
    let outH = sh;

    if (outW > maxWidth) {
      outW = maxWidth;
      outH = Math.round(outW / sourceAspect);
    }
    if (outH > maxHeight) {
      outH = maxHeight;
      outW = Math.round(outH * sourceAspect);
    }

    outW = Math.max(1, outW);
    outH = Math.max(1, outH);

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);

    const out = await canvas.convertToBlob({ type: mime, quality });
    const buf = await out.arrayBuffer();
    const b64 = await base64Encode(buf);
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/**
 * convenience wrapper that mirrors the legacy `generateThumbnailDataUrl`
 * signature: skips non-image blobs, fits inside `maxSize` x `maxSize`,
 * encodes WebP at 0.75 quality.
 */
async function generateThumbnailDataUrl(blob: Blob, maxSize = 200): Promise<string | null> {
  if (!blob.type.startsWith("image/")) return null;
  return resizeImageToWebpDataUrl(blob, {
    maxWidth: maxSize,
    maxHeight: maxSize,
    quality: 0.75,
  });
}

// ---- streaming upload sessions --------------------------------------------
// chunked counterpart to processBlobBytes: the main thread feeds a File's
// stream() chunks one at a time, so neither thread ever holds the whole
// payload. bytes land incrementally in a temp OPFS file (sync access
// handle), blake3 is computed incrementally via midden's Blake3Hasher, and
// on finish the temp file is renamed to the final blake3 content address.

interface UploadSession {
  handle: SyncAccessHandle;
  tmpName: string;
  hasher: { update(chunk: Uint8Array): void; finalize(): string; free(): void };
  size: number;
}

const uploadSessions = new Map<number, UploadSession>();
let nextUploadSessionId = 1;

/**
 * begin a streaming upload session. throws when the environment can't
 * support it (no OPFS sync access handles, or the midden wasm stub without
 * Blake3Hasher) — callers fall back to the one-shot processBlobBytes path.
 */
async function uploadBegin(): Promise<number> {
  const Blake3HasherCtor = (middenWasm as any).Blake3Hasher;
  if (typeof Blake3HasherCtor !== "function") {
    throw new Error("streaming upload unavailable: midden Blake3Hasher missing");
  }
  const dir = await getOpfsDir(true);
  if (!dir) throw new Error("streaming upload unavailable: OPFS inaccessible");

  const id = nextUploadSessionId++;
  const tmpName = `.upload-${id}-${Date.now()}`;
  const fileHandle = await dir.getFileHandle(tmpName, { create: true });
  const createSync = (
    fileHandle as unknown as { createSyncAccessHandle?: () => Promise<SyncAccessHandle> }
  ).createSyncAccessHandle;
  if (typeof createSync !== "function") {
    await dir.removeEntry(tmpName).catch(() => {});
    throw new Error("streaming upload unavailable: no sync access handle support");
  }
  const handle = await createSync.call(fileHandle);
  handle.truncate(0);

  uploadSessions.set(id, { handle, tmpName, hasher: new Blake3HasherCtor(), size: 0 });
  return id;
}

/** append the next chunk (transferred buffer) to a session. */
async function uploadPush(id: number, buffer: ArrayBuffer): Promise<void> {
  const session = uploadSessions.get(id);
  if (!session) throw new Error(`unknown upload session ${id}`);
  const bytes = new Uint8Array(buffer);
  session.hasher.update(bytes);
  session.handle.write(bytes, { at: session.size });
  session.size += bytes.byteLength;
}

/**
 * finish a session: flush + close the temp file, then rename it to the
 * final blake3 content address. returns { blake3, size }.
 */
async function uploadFinish(id: number): Promise<{ blake3: string; size: number }> {
  const session = uploadSessions.get(id);
  if (!session) throw new Error(`unknown upload session ${id}`);
  uploadSessions.delete(id);

  let blake3 = "";
  try {
    session.handle.flush();
    session.handle.close();
    blake3 = session.hasher.finalize();
  } finally {
    session.hasher.free();
  }

  const dir = await getOpfsDir(true);
  if (!dir) throw new Error("OPFS inaccessible at upload finish");
  const tmpHandle = await dir.getFileHandle(session.tmpName);

  // dedup: if the content-addressed file already exists, drop the temp copy
  let exists = false;
  try {
    await dir.getFileHandle(blake3, { create: false });
    exists = true;
  } catch {
    // target doesn't exist — rename below
  }
  if (exists) {
    await dir.removeEntry(session.tmpName).catch(() => {});
    return { blake3, size: session.size };
  }

  const move = (tmpHandle as unknown as { move?: (name: string) => Promise<void> }).move;
  if (typeof move === "function") {
    await move.call(tmpHandle, blake3);
  } else {
    // rare fallback (no FileSystemFileHandle.move): copy then remove.
    // buffers once in the worker — still better than failing the upload.
    const file = await tmpHandle.getFile();
    await writeBlobToOpfs(blake3, await file.arrayBuffer());
    await dir.removeEntry(session.tmpName).catch(() => {});
  }
  return { blake3, size: session.size };
}

/** abort a session: close and delete the temp file. */
async function uploadAbort(id: number): Promise<void> {
  const session = uploadSessions.get(id);
  if (!session) return;
  uploadSessions.delete(id);
  try {
    session.handle.close();
  } catch {
    // already closed
  }
  session.hasher.free();
  const dir = await getOpfsDir(false);
  await dir?.removeEntry(session.tmpName).catch(() => {});
}

/**
 * stage-0 opfs-store spike selftest — runs midden's out-of-crate iroh-blobs
 * store round trip against real OPFS. must run here (dedicated worker):
 * sync access handles don't exist on the main thread. throws on failure.
 */
async function opfsStoreSelftest(): Promise<string> {
  const fn = (middenWasm as any).opfs_store_selftest;
  if (typeof fn !== "function") {
    throw new Error("opfs_store_selftest missing from midden wasm build");
  }
  return fn();
}

/**
 * persistence selftest — blobs + tags must survive a store shutdown and
 * reopen over the same OPFS directory (the whole point of the store:
 * cross-reload resume without re-import). worker context required.
 */
async function opfsStoreSelftestPersistence(): Promise<string> {
  const fn = (middenWasm as any).opfs_store_selftest_persistence;
  if (typeof fn !== "function") {
    throw new Error("opfs_store_selftest_persistence missing from midden wasm build");
  }
  return fn();
}

const api = {
  hashBlake3,
  hashSha256,
  base64Encode,
  base64Decode,
  writeBlobToOpfs,
  readBlobFromOpfs,
  processBlobBytes,
  resizeImageToWebpDataUrl,
  generateThumbnailDataUrl,
  uploadBegin,
  uploadPush,
  uploadFinish,
  uploadAbort,
  opfsStoreSelftest,
  opfsStoreSelftestPersistence,
};

export type BlobWorkerApi = typeof api;

Comlink.expose(api);

// signal readiness *after* Comlink has registered its message listener.
//
// without this, a Comlink RPC call sent right after `new Worker()` can race
// the worker's own startup (fetching + instantiating the ~19MB midden wasm
// takes a couple of seconds). if the browser dispatches the postMessage'd
// call before Comlink.expose() above has added its "message" listener, the
// event fires with no listener attached and is silently dropped forever —
// the caller's promise never resolves. see `getBlobWorker()` in
// blob-worker-client.ts, which waits for this signal before handing out
// the worker proxy.
postMessage("skein-blob-worker-ready");

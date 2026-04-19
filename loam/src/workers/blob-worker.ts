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
    const midden = (await import("midden")) as unknown as {
      hash_blake3?: (bytes: Uint8Array) => string;
    };
    if (typeof midden.hash_blake3 === "function") {
      return midden.hash_blake3(data);
    }
    return "";
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
  blob_id: string; // sha256 hex (skein's content-address for the blob db)
  sha256: string;
  blake3: string;
  size: number;
  mime: string;
  filename: string;
}

/**
 * one-shot: hash bytes (sha256 + blake3), write to OPFS, return metadata.
 * lets callers avoid three round-trips across the worker boundary for an
 * upload. `data` should be transferred.
 */
async function processBlobBytes(
  data: ArrayBuffer,
  filename: string,
  mime: string
): Promise<ProcessedBlob> {
  // run sha256 and blake3 concurrently. SubtleCrypto.digest does its own
  // copy of the bytes, so we can't transfer-and-reuse — do them in parallel
  // and let the runtime overlap them.
  const [sha256, blake3] = await Promise.all([
    hashSha256(data),
    hashBlake3(new Uint8Array(data)),
  ]);
  await writeBlobToOpfs(sha256, data);
  return {
    blob_id: sha256,
    sha256,
    blake3,
    size: data.byteLength,
    mime,
    filename,
  };
}

const api = {
  hashBlake3,
  hashSha256,
  base64Encode,
  base64Decode,
  writeBlobToOpfs,
  readBlobFromOpfs,
  processBlobBytes,
};

export type BlobWorkerApi = typeof api;

Comlink.expose(api);

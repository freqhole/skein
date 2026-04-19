// blob-worker-client — lazy comlink wrapper around the blob worker.
//
// the worker is spun up on first call to `getBlobWorker()` and reused for
// the lifetime of the page. importing this module costs nothing — the
// worker bundle is only fetched/instantiated on first use.
//
// in environments without Worker support (e.g. SSR / certain test runners)
// the client falls back to a synchronous in-process implementation so
// callers don't have to branch.

import * as Comlink from "comlink";
import type { BlobWorkerApi } from "./blob-worker";

let workerProxy: Comlink.Remote<BlobWorkerApi> | null = null;
let workerInstance: Worker | null = null;

function canSpawnWorker(): boolean {
  return typeof Worker !== "undefined";
}

/**
 * get (and lazily spawn) the comlink-wrapped blob worker proxy.
 *
 * returns null if Worker isn't available — callers should branch and use
 * a main-thread fallback (see `getBlobWorkerOrFallback()` for the common
 * path).
 */
export async function getBlobWorker(): Promise<Comlink.Remote<BlobWorkerApi> | null> {
  if (workerProxy) return workerProxy;
  if (!canSpawnWorker()) return null;

  // vite ?worker import: returns a constructor for a module-format worker.
  // the wasm + topLevelAwait plugins are applied to worker bundles via
  // vite.config.ts `worker.plugins`.
  const WorkerCtor = (await import("./blob-worker?worker")).default;
  workerInstance = new WorkerCtor();
  workerProxy = Comlink.wrap<BlobWorkerApi>(workerInstance);
  return workerProxy;
}

/**
 * tear down the worker. mainly useful for tests; production code can leave
 * the worker alive for the page lifetime.
 */
export function shutdownBlobWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    workerProxy = null;
  }
}

// ---- main-thread fallbacks -----------------------------------------------
// used when Worker isn't available. these mirror the worker's API exactly
// so consumers can share a single code path.

async function fallbackHashBlake3(data: Uint8Array): Promise<string> {
  try {
    const midden = (await import("midden")) as unknown as {
      hash_blake3?: (bytes: Uint8Array) => string;
    };
    return typeof midden.hash_blake3 === "function" ? midden.hash_blake3(data) : "";
  } catch {
    return "";
  }
}

async function fallbackHashSha256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function fallbackBase64Encode(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

// ---- convenience helpers --------------------------------------------------

/**
 * hash bytes with blake3, preferring the worker. accepts a Uint8Array.
 * note: this DOES copy across the worker boundary (Uint8Array isn't
 * transferable directly without giving up the underlying ArrayBuffer);
 * for upload pipelines, prefer `processBlobBytes` which transfers the
 * underlying buffer.
 */
export async function hashBlake3(data: Uint8Array): Promise<string> {
  const worker = await getBlobWorker();
  if (worker) return worker.hashBlake3(data);
  return fallbackHashBlake3(data);
}

/**
 * sha256 hash of an ArrayBuffer.
 */
export async function hashSha256(data: ArrayBuffer): Promise<string> {
  const worker = await getBlobWorker();
  if (worker) return worker.hashSha256(data);
  return fallbackHashSha256(data);
}

/**
 * base64-encode an ArrayBuffer. transfers ownership of `buffer` to the
 * worker — the caller must not use it after this returns.
 */
export async function base64Encode(buffer: ArrayBuffer): Promise<string> {
  const worker = await getBlobWorker();
  if (worker) return worker.base64Encode(Comlink.transfer(buffer, [buffer]));
  return fallbackBase64Encode(buffer);
}

/**
 * one-shot upload pipeline: hash + write to OPFS in the worker, return
 * metadata. transfers the buffer.
 */
export async function processBlobBytes(
  buffer: ArrayBuffer,
  filename: string,
  mime: string
): Promise<{
  blob_id: string;
  sha256: string;
  blake3: string;
  size: number;
  mime: string;
  filename: string;
}> {
  const worker = await getBlobWorker();
  if (worker) {
    return worker.processBlobBytes(Comlink.transfer(buffer, [buffer]), filename, mime);
  }
  // main-thread fallback path — rare, mostly for tests.
  const [sha256, blake3] = await Promise.all([
    fallbackHashSha256(buffer),
    fallbackHashBlake3(new Uint8Array(buffer)),
  ]);
  return {
    blob_id: sha256,
    sha256,
    blake3,
    size: buffer.byteLength,
    mime,
    filename,
  };
}

/**
 * write a blob to OPFS via the worker (uses `FileSystemSyncAccessHandle`
 * for max throughput). transfers the buffer.
 */
export async function writeBlobToOpfs(blobId: string, buffer: ArrayBuffer): Promise<void> {
  const worker = await getBlobWorker();
  if (worker) {
    await worker.writeBlobToOpfs(blobId, Comlink.transfer(buffer, [buffer]));
    return;
  }
  // no main-thread fallback — opfs writes from main thread don't have a
  // sync access handle path anyway. silently no-op.
}

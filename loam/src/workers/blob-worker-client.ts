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
import * as middenWasm from "midden";

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
    return typeof middenWasm.hash_blake3 === "function" ? middenWasm.hash_blake3(data) : "";
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
 * base64-encode an ArrayBuffer.
 *
 * NOTE: the buffer is structured-cloned (copied) across the worker
 * boundary so callers can safely reuse it afterwards. if you have a
 * dedicated buffer that won't be touched again, you can transfer
 * ownership manually for a small perf win.
 */
export async function base64Encode(buffer: ArrayBuffer): Promise<string> {
  const worker = await getBlobWorker();
  if (worker) return worker.base64Encode(buffer);
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
 * for max throughput).
 *
 * NOTE: the buffer is structured-cloned (copied) across the worker
 * boundary so callers can safely reuse it afterwards — important for
 * code paths like snatch / `getBlobData` cache-back-fill that read or
 * return the buffer after kicking off an OPFS write. for the upload
 * pipeline use `processBlobBytes` instead, which transfers.
 */
export async function writeBlobToOpfs(blobId: string, buffer: ArrayBuffer): Promise<void> {
  const worker = await getBlobWorker();
  if (worker) {
    await worker.writeBlobToOpfs(blobId, buffer);
    return;
  }
  // no main-thread fallback — opfs writes from main thread don't have a
  // sync access handle path anyway. silently no-op.
}

// ---- thumbnail / image resize -------------------------------------------

export interface ResizeImageOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  cropSquare?: boolean;
  mime?: string;
}

/**
 * resize an image Blob to a (default WebP) data URL inside the worker.
 * the Blob is structured-cloned by reference so postMessage cost is O(1).
 * returns null on failure (non-image input, decode failure, etc.).
 */
export async function resizeImageToWebpDataUrl(
  blob: Blob,
  options?: ResizeImageOptions
): Promise<string | null> {
  const worker = await getBlobWorker();
  if (worker) return worker.resizeImageToWebpDataUrl(blob, options);
  // main-thread fallback — works on any modern browser.
  return mainThreadResizeImage(blob, options);
}

/**
 * generate a thumbnail data URL (default 200x200 WebP @ q=0.75) for an
 * image Blob. delegates to the worker.
 */
export async function generateThumbnailDataUrl(blob: Blob, maxSize = 200): Promise<string | null> {
  if (!blob.type.startsWith("image/")) return null;
  return resizeImageToWebpDataUrl(blob, {
    maxWidth: maxSize,
    maxHeight: maxSize,
    quality: 0.75,
  });
}

/**
 * decode a base64 string into a Uint8Array via the worker. for large
 * payloads (megabyte-scale snatch responses) this avoids blocking the
 * main thread on a tight `String.charCodeAt` loop.
 */
export async function base64Decode(b64: string): Promise<Uint8Array> {
  const worker = await getBlobWorker();
  if (worker) return worker.base64Decode(b64);
  // main-thread fallback
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---- main-thread fallbacks -----------------------------------------------

async function mainThreadResizeImage(
  blob: Blob,
  options?: ResizeImageOptions
): Promise<string | null> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    return null;
  }
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
    const aspect = sw / sh;
    let outW = sw;
    let outH = sh;
    if (outW > maxWidth) {
      outW = maxWidth;
      outH = Math.round(outW / aspect);
    }
    if (outH > maxHeight) {
      outH = maxHeight;
      outW = Math.round(outH * aspect);
    }
    outW = Math.max(1, outW);
    outH = Math.max(1, outH);
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);
    const out = await canvas.convertToBlob({ type: mime, quality });
    const buf = await out.arrayBuffer();
    const b64 = await fallbackBase64Encode(buf);
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

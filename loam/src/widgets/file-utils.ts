/**
 * utilities for file picking, uploading, blob data fetching, snatch,
 * and save-to-disk in the skein widget system.
 *
 * supports two runtime modes:
 * - Tauri mode: native file dialogs + IPC invoke for uploads
 * - browser mode: hidden <input> file picker (upload requires Tauri)
 *
 * thumbnail fetching has a P2P fallback: when the blob isn't available
 * locally (e.g. a peer uploaded it), we proxy the thumbnail request
 * through connected canvas peers via the node's proxy_request method (a
 * skein/1 stream exchange, real for a tauri node - see tauri-transport.ts -
 * and via `p2p/skein-proxy-client.ts`'s `open_bi`-based sender for a
 * browser node).
 *
 * snatch: download a full blob from a canvas peer via iroh-blobs verified
 * transfer, then ingest it into the local grimoire (creating a media_blobz
 * entry, domain entity, and thumbnail job).
 *
 * snatch to disk (browser only): same download, but written straight to a
 * user-chosen disk location via the File System Access API instead of
 * being persisted into OPFS/IndexedDB — useful for large files the user
 * doesn't want a second copy of sitting in browser storage. not needed in
 * Tauri mode, which already writes blob storage to the user's real
 * filesystem.
 *
 * save to disk: export a locally-stored blob to a user-chosen filesystem
 * path via the native save dialog.
 */

import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import { log } from "@freqhole/reliquary/utils";
import { getStoredIdentity, getMiddenNode } from "../p2p/identity";
import {
  requestDocumentPagesFromPeers,
  type SkeinProxyNode,
} from "../p2p/skein-proxy-client";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  hasBlobBytes,
  getBlobObjectURL,
  storeBlob,
  storeBlobFromFile,
  resolveBlob,
  getBlobData,
  getBlobDomain,
  classifyDomain,
  deleteBlob,
} from "../storage/blob-store";
import { generateThumbnailDataUrl as generateThumbnailDataUrlWorker } from "@freqhole/reliquary/worker";
import {
  discardPausedDownload as transferDiscardPausedDownload,
  pauseSnatchDownload as transferPauseSnatchDownload,
  snatchBlob as transferSnatchBlob,
  snatchBlobToDisk as transferSnatchBlobToDisk,
  type BlobCapableNode,
  type SnatchInfo as TransferSnatchInfo,
  type SnatchOptions as TransferSnatchOptions,
} from "@freqhole/reliquary/transfer";
import { ensureBlobOverAlpn } from "@freqhole/reliquary/ensure";
import { isFriend } from "../p2p/friendz-bridge";

const TAG = "file-utils";

const PEER_TIMEOUT_MS = 8000;

/** minimal extension -> mime guesser used when the tauri native file picker
 *  hands us only a path (no mime). intentionally tiny: just covers the file
 *  types the canvas widgets actually render. unknown extensions fall back
 *  to application/octet-stream and the file widget treats them as opaque. */
function guessMimeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "pdf":
      return "application/pdf";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "txt":
      return "text/plain";
    case "md":
    case "markdown":
      return "text/markdown";
    case "epub":
      return "application/epub+zip";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "odt":
      return "application/vnd.oasis.opendocument.text";
    case "rtf":
      return "application/rtf";
    case "html":
    case "htm":
      return "text/html";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/** decode a base64 string to a fresh Uint8Array. browser-native, no deps. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** coerce automerge Text objects (or any value) to a plain JS string.
 *  automerge stores strings as Text objects which have toString() but lack
 *  string methods like slice(). wrapping in String() normalizes them. */
function coerceStr(v: unknown): string {
  // eslint-disable-next-line eqeqeq -- intentional: catches both null and undefined
  if (v == null) return "";
  return String(v);
}

async function withPeerTimeout<T>(promise: Promise<T>, ms = PEER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("peer timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** result from picking a file */
export interface PickedFile {
  /** file path (Tauri mode only — null in browser mode) */
  path: string | null;
  /** filename with extension */
  filename: string;
  /** file size in bytes (0 when unknown, e.g. Tauri mode before upload) */
  size: number;
  /** the raw File object (browser mode only — null in Tauri mode) */
  file: File | null;
}

/** result from uploading a file */
export interface FileUploadResult {
  blobId: string;
  domain: string;
  jobId: string | null;
  sha256: string;
  blake3: string | null;
  size: number;
  mime: string;
  existing: boolean;
  /** embedded thumbnail data URL (browser-generated or fetched from grimoire) */
  thumbnailDataUrl?: string | null;
}

/** blob locality — whether the blob exists in the local grimoire DB */
export type BlobLocality = "local" | "remote" | "unknown";

/** result from checking blob locality */
export interface BlobLocalityInfo {
  /** whether the blob is in the local grimoire DB */
  locality: BlobLocality;
  /** blob metadata (only present when local) */
  metadata?: {
    id: string;
    mime?: string;
    filename?: string;
    size?: number;
    blake3?: string;
    /** blob-level metadata JSON — check source field for snatch detection */
    blobMetadata?: Record<string, unknown>;
  };
}

/** metadata about a blob needed for snatch operations */
export interface SnatchBlobInfo {
  blobId: string;
  filename: string;
  mime: string;
  size: number;
  blake3: string;
  domain: string;
}

/** options for snatch operations */
export interface SnatchOptions {
  /** called with progress updates during download (0.0 to 1.0, or -1 if total unknown) */
  onProgress?: (fraction: number) => void;
  /** abort signal to cancel an in-progress snatch */
  signal?: AbortSignal;
  /** check whether a peer nodeId is currently connected at the transport level.
   *  when provided, enables parallel probe-then-download: all peers are probed
   *  in parallel, the first responsive peer wins, then download starts from it. */
  isPeerOnline?: (nodeId: string) => boolean;
  /** called when switching to a new peer attempt. useful for UI feedback like
   *  "trying peer 2/3..." between download attempts. */
  onPeerAttempt?: (peerIndex: number, peerCount: number, online: boolean) => void;
  /** opaque id registered with the midden worker for this download — pass the
   *  same id to pauseSnatchDownload() to pause the in-flight transfer. the
   *  partial stays in the persistent store (pinned against gc), so a later
   *  snatch of the same blake3 resumes: only the missing ranges transfer. */
  downloadId?: string;
}

/** error message midden/tauri use for a deliberately cancelled download */
const DOWNLOAD_CANCELLED_MSG = "download cancelled";

/** true when an error came from a deliberate pause/cancel of the transfer
 *  (midden CancelToken or tauri blob_iroh_download_cancel), as opposed to a
 *  genuine failure. paused snatches must NOT fall through to next-peer retry. */
export function isDownloadCancelled(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(DOWNLOAD_CANCELLED_MSG);
}

/**
 * pause an in-flight snatch download. the transfer stops at the next chunk
 * boundary and the snatch promise rejects with a cancelled error
 * (recognizable via isDownloadCancelled). the partial data stays in the
 * persistent store, pinned against gc — resume by calling snatchBlob again
 * with the same blake3 (only missing ranges transfer).
 *
 * browser mode pauses by downloadId, delegating to the transport package's
 * own `pauseSnatchDownload` against the midden node. tauri mode pauses by
 * blake3 (the native download registry key) — that path has no equivalent
 * in the package (its contract is browser-only) and stays exactly as
 * skein's own tauri IPC call. returns true when an in-flight download was
 * actually flagged.
 */
export async function pauseSnatchDownload(opts: {
  downloadId?: string;
  blake3?: string | null;
}): Promise<boolean> {
  if (isTauriMode()) {
    const node = (await getMiddenNode()) as any;
    if (opts.blake3 && typeof node.cancel_native_download === "function") {
      return (await node.cancel_native_download(opts.blake3)) === true;
    }
    return false;
  }
  if (!opts.downloadId) return false;
  const node = (await getMiddenNode()) as unknown as BlobCapableNode;
  return transferPauseSnatchDownload(node, opts.downloadId);
}

/**
 * discard a paused partial: releases the gc pin that a paused download left
 * behind so the store can reclaim the partial data. browser mode only
 * (tauri's FsStore keeps partials on disk; harmless). call when the user
 * cancels for good rather than pausing. delegates to the transport
 * package's own `discardPausedDownload`, which is already best-effort
 * (failures are logged, never thrown).
 */
export async function discardPausedDownload(blake3: string | null | undefined): Promise<void> {
  if (!blake3 || isTauriMode()) return;
  const node = (await getMiddenNode()) as unknown as BlobCapableNode;
  await transferDiscardPausedDownload(node, blake3);
}

/** options for file upload */
export interface UploadOptions {
  title?: string;
  description?: string;
  metadata?: string;
  /** wait for thumbnail job to complete before returning (default: true) */
  waitForCompletion?: boolean;
  /**
   * incremental progress during upload, 0..1. tauri mode reports the
   * rust-side streaming hash pass (`blob-insert-progress` events); browser
   * mode reports bytes streamed into OPFS for large files (small files
   * complete in one shot and only report 1 at the end).
   */
  onProgress?: (fraction: number) => void;
  /** abort signal — cancels the upload. browser mode aborts the worker
   *  upload session between chunks; tauri mode dispatches
   *  blob_insert_cancel for the in-flight hashing pass. a cancelled upload
   *  rejects with a DOMException AbortError (browser) or an error whose
   *  message contains "upload cancelled" (tauri). */
  signal?: AbortSignal;
}

/** options for thumbnail fetching */
export interface ThumbnailOptions {
  /** thumbnail size in pixels (default: 200) */
  size?: number;
  /** canvas peers to try for P2P fallback — keys are peer IDs, values have nodeId */
  peers?: Record<string, { nodeId: string }>;
}

/** peers map type — extracted for reuse across functions */
export type PeersMap = Record<string, { nodeId: string }>;

// ---------------------------------------------------------------------------
// peer node ID helper (cached)
// ---------------------------------------------------------------------------

let _cachedLocalNodeId: string | null | undefined = undefined;

export async function getLocalNodeId(): Promise<string | null> {
  if (_cachedLocalNodeId !== undefined) return _cachedLocalNodeId;
  try {
    const identity = await getStoredIdentity();
    _cachedLocalNodeId = identity?.node_id ?? null;
  } catch {
    _cachedLocalNodeId = null;
  }
  return _cachedLocalNodeId;
}

/** extract peer node IDs from the peers map, filtering out the local node */
async function getPeerNodeIds(
  peers: PeersMap | Record<string, { nodeId: string }>
): Promise<string[]> {
  const localNodeId = await getLocalNodeId();
  return Object.values(peers)
    .map((p) => String(p.nodeId))
    .filter((id): id is string => Boolean(id) && id !== localNodeId);
}

// ---------------------------------------------------------------------------
// @freqhole/reliquary/transfer adapter glue
// ---------------------------------------------------------------------------

/** translate a widget-shaped blob descriptor into the transport package's
 *  own shape: `blobId` becomes the optional, app-addressable `id` (used
 *  only to build the strategy-3 proxy path), everything else carries over
 *  unchanged. */
function toTransferSnatchInfo(info: SnatchBlobInfo): TransferSnatchInfo {
  return { id: info.blobId, blake3: info.blake3, size: info.size, mime: info.mime };
}

/** translate widget-facing snatch options into the transport package's own
 *  option shape, wiring the skein/1 proxy fallback (strategy 3, used for
 *  tauri peers whose rust backend only accepts the skein/1 ALPN) to the
 *  exact envelope skein-handler sends: `{ success, data: { data, mime } }`. */
function toTransferOptions(options?: SnatchOptions): TransferSnatchOptions {
  return {
    onProgress: options?.onProgress,
    signal: options?.signal,
    downloadId: options?.downloadId,
    proxyPath: (id) => `/api/blobs/${id}/data`,
    parseProxyResponse: (body) => {
      const parsed = JSON.parse(body) as {
        success?: boolean;
        data?: { data?: string; mime?: string };
      };
      if (!parsed.success || typeof parsed.data?.data !== "string") return null;
      return { data: parsed.data.data, mime: parsed.data.mime };
    },
  };
}

// ---------------------------------------------------------------------------
// tauri bridge helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// thumbnail cache
// ---------------------------------------------------------------------------

/**
 * in-memory cache of fetched thumbnails. keyed by "blobId:size".
 * survives for the session — cleared on page reload.
 * avoids redundant local + P2P fetches when widgets re-render.
 */
const thumbnailCache = new Map<string, string>();

/** session-scoped locality cache — avoids repeated IDB lookups for blobs we already know are local */
const localityCache = new Map<string, BlobLocalityInfo>();

function cacheKey(blobId: string, size: number): string {
  return `${blobId}:${size}`;
}

/**
 * delete the LOCAL copy of a blob (OPFS bytes + IndexedDB record + session
 * caches) to reclaim disk space, without touching the widget doc — the file
 * widget stays on the canvas and the blob becomes snatchable again from
 * whoever still has it (e.g. a hub peer). browser-only: tauri blob storage
 * is the durable native store and is managed separately.
 *
 * records can be keyed by either the blake3 or a legacy sha256 blob id, so
 * both ids are cleaned when known.
 */
export async function freeUpLocalBlobCopy(
  blobId: string,
  blake3?: string | null
): Promise<void> {
  if (isTauriMode()) {
    throw new Error("free up space is browser-only — tauri manages native blob storage");
  }
  const ids = [...new Set([blobId, blake3 ?? ""].filter(Boolean))];
  for (const id of ids) {
    try {
      await deleteBlob(id);
    } catch (err) {
      log.debug(TAG, `freeUpLocalBlobCopy: deleteBlob(${id.slice(0, 12)}...) failed:`, err);
    }
    localityCache.delete(id);
    thumbnailCache.delete(cacheKey(id, 200));
    thumbnailCache.delete(cacheKey(id, 50));
  }
  log.debug(TAG, `freed local copy of blob ${blobId.slice(0, 12)}...`);
}

// ---------------------------------------------------------------------------
// blob locality check
// ---------------------------------------------------------------------------

/**
 * check whether a blob exists in the local grimoire database.
 * used to determine whether to show "snatch" (remote) or "save to disk" (local).
 *
 * returns locality info including metadata when the blob is local.
 */
export async function checkBlobLocality(
  blobId: string,
  blake3?: string
): Promise<BlobLocalityInfo> {
  if (!blobId) {
    return { locality: "unknown" };
  }

  const cached = localityCache.get(blobId);
  if (cached && cached.locality === "local") {
    return cached;
  }

  if (!isTauriMode()) {
    try {
      // resolveBlob tries primary key → blake3(blobId) → sha256 →
      // blake3(param), covering both id generations (blake3 canonical,
      // sha256 legacy) and tauri-overwritten doc ids.
      const record = await resolveBlob(blobId, blake3);
      if (!record) {
        return { locality: "remote" };
      }
      // a record alone is not enough — the bytes must actually be present
      // in OPFS. a stranded record (e.g. an old snatch whose best-effort
      // OPFS write silently failed) previously claimed "local" forever
      // while playback found nothing and no re-snatch was offered. treat
      // it as remote so the snatch path can repair it.
      const bytesPresent = await hasBlobBytes(record.blob_id);
      if (!bytesPresent) {
        log.warn(
          TAG,
          `blob record ${record.blob_id.slice(0, 16)}... exists but OPFS bytes are missing — treating as remote (re-snatch will repair)`
        );
        return { locality: "remote" };
      }
      const result: BlobLocalityInfo = {
        locality: "local",
        metadata: {
          id: record.blob_id,
          mime: record.mime || undefined,
          filename: record.filename || undefined,
          size: record.size || undefined,
          blake3: record.blake3 || undefined,
        },
      };
      localityCache.set(blobId, result);
      return result;
    } catch (err) {
      log.debug(TAG, "browser blob locality check failed:", err);
      return { locality: "unknown" };
    }
  }

  try {
    // skein: blobId is the blake3 hex. blob_get_path returns
    // { path, mime, size } when the blob exists locally, errors otherwise.
    const meta = (await dispatch("blob_get_path", {
      blake3: blobId,
    })) as { path?: string; mime?: string | null; size?: number | null } | null;

    if (!meta?.path) {
      return { locality: "remote" };
    }

    const result: BlobLocalityInfo = {
      locality: "local",
      metadata: {
        id: blobId,
        mime: meta.mime ?? undefined,
        size: meta.size ?? undefined,
        blake3: blobId,
      },
    };
    localityCache.set(blobId, result);
    return result;
  } catch (err) {
    // dispatch throws on NotFound — that's the "remote" signal in skein
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("NotFound")) {
      return { locality: "remote" };
    }
    log.debug(TAG, "blob locality check failed:", err);
    return { locality: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// snatch (download from peer + ingest locally)
// ---------------------------------------------------------------------------

/**
 * in-flight snatch dedup: keyed by blake3 (falls back to blobId when no
 * blake3 is known yet). without this, two widgets referencing the same
 * content (e.g. the same file dropped into two separate file widgets, or
 * a file widget and an audio-recording widget that happen to hash-collide)
 * each independently probing + downloading the same blob at nearly the same
 * time would double the P2P network traffic for no benefit — storeBlob()
 * is idempotent for identical content, so the redundant work was always
 * wasted, never actually harmful/corrupting.
 *
 * caveat (documented, not solved here): only the FIRST caller's
 * onProgress/onPeerAttempt/isPeerOnline options are honored — a second,
 * joining caller's progress callbacks never fire (it only gets the final
 * resolved/rejected result). similarly, if the FIRST caller's `signal`
 * aborts, every joiner's shared promise rejects too, even if the joiner
 * never asked to abort. both are acceptable for the common case (the
 * whole point is that joiners get the exact same result as the original
 * request), but worth knowing if per-caller cancellation semantics are
 * ever needed here.
 */
const inFlightSnatches = new Map<string, Promise<FileUploadResult>>();

/**
 * snatch a blob from a canvas peer: download the full file via iroh-blobs
 * verified transfer, then ingest it into the local grimoire to create a
 * media_blobz entry, domain entity, and thumbnail job.
 *
 * after snatch, the blob resolves locally (no more P2P dependency for
 * thumbnails or previews).
 *
 * in browser mode, uses the midden node's fetch methods and stores
 * in OPFS + IndexedDB. in Tauri mode, uses IPC commands.
 *
 * deduplicates concurrent calls for the same content (see inFlightSnatches
 * above) — a second call for a blake3/blobId already being snatched joins
 * the same in-flight promise instead of starting a redundant P2P transfer.
 */
export async function snatchBlob(
  info: SnatchBlobInfo,
  peers: PeersMap,
  options?: SnatchOptions
): Promise<FileUploadResult> {
  const dedupKey = coerceStr(info.blake3) || coerceStr(info.blobId);
  const existing = dedupKey ? inFlightSnatches.get(dedupKey) : undefined;
  if (existing) {
    log.debug(TAG, `snatch already in flight for ${dedupKey.slice(0, 16)}..., joining it`);
    return existing;
  }

  const promise = snatchBlobUncached(info, peers, options);
  if (dedupKey) {
    inFlightSnatches.set(dedupKey, promise);
    // `.finally()` returns a NEW promise distinct from `promise` — if
    // `promise` rejects, this derived promise rejects too (same reason),
    // even though `promise` itself is already properly awaited/caught by
    // whoever called snatchBlob(). without the trailing `.catch(() => {})`
    // below, a failed snatch (offline peer, blob not found, aborted, etc.)
    // fires a real unhandled-promise-rejection event — confirmed via a
    // standalone repro and covered by a regression test — regardless of
    // the caller correctly handling the snatch failure. the empty catch is
    // safe because the actual error is never swallowed: it still reaches
    // every caller via the returned `promise`/`existing` above.
    void promise
      .finally(() => {
        // only delete if we're still the tracked promise for this key — a
        // later snatch of the same content may have already replaced us.
        if (inFlightSnatches.get(dedupKey) === promise) {
          inFlightSnatches.delete(dedupKey);
        }
      })
      .catch(() => {});
  }
  return promise;
}

/**
 * thrown by `snatchBlob()`/`snatchBlobToDisk()` (and anything built on
 * `resolveAudioBytes()`) when every peer known to have the blob (per the
 * ensure/1 probe) isn't a friend yet. we don't attempt those peers' actual
 * downloads at all - both platforms currently deny non-friend blob
 * fetches, so it'd just hang or fail - the caller should offer to send a
 * friend request instead (see `pending-blob-access.ts` for retrying once
 * the request is accepted).
 */
export class BlobAccessDeniedError extends Error {
  /** the peer to target for a friend request - the first peer (by probe/
   *  connectivity order) known to have the blob. */
  readonly peerNodeId: string;
  /** every peer known to have the blob but not currently a friend. */
  readonly peerNodeIds: string[];

  constructor(peerNodeIds: string[]) {
    super(`peer ${peerNodeIds[0]!.slice(0, 16)}... has this blob but isn't a friend yet`);
    this.name = "BlobAccessDeniedError";
    this.peerNodeId = peerNodeIds[0]!;
    this.peerNodeIds = peerNodeIds;
  }
}

async function snatchBlobUncached(
  info: SnatchBlobInfo,
  peers: PeersMap,
  options?: SnatchOptions
): Promise<FileUploadResult> {
  const allPeerAddrs = await getPeerNodeIds(peers);

  // defensive: coerce blob info strings — automerge may store them as Text objects
  info = {
    ...info,
    blobId: coerceStr(info.blobId),
    filename: coerceStr(info.filename),
    mime: coerceStr(info.mime),
    blake3: coerceStr(info.blake3),
    domain: coerceStr(info.domain),
  };

  if (allPeerAddrs.length === 0) {
    throw new Error("no peers available for snatch");
  }

  // tauri: short-circuit if the blob already exists in the local rust
  // blobz store under the same blake3 — no need to round-trip P2P. the
  // freqhole-era `api_call("/api/blob_metadata_by_blake3")` path doesn't
  // exist in skein, so we use the skein blob_get_path dispatch instead.
  if (isTauriMode() && info.blake3) {
    try {
      const local = await dispatch("blob_get_path", { blake3: info.blake3 });
      if (local?.path) {
        log.debug(
          TAG,
          `blob found locally in rust blobz by blake3 (${info.blake3.slice(0, 16)}...), skipping P2P snatch`
        );
        const key200 = cacheKey(info.blobId, 200);
        const key50 = cacheKey(info.blobId, 50);
        thumbnailCache.delete(key200);
        thumbnailCache.delete(key50);
        localityCache.set(info.blobId, { locality: "local" });
        return {
          blobId: info.blake3,
          domain: info.domain,
          jobId: null,
          sha256: "",
          blake3: info.blake3,
          size: typeof local.size === "number" ? local.size : info.size,
          mime: typeof local.mime === "string" ? local.mime : info.mime,
          existing: true,
        };
      }
    } catch (err) {
      log.debug(TAG, "local rust blobz blake3 check failed, proceeding to P2P:", err);
    }
  }

  if (options?.signal?.aborted) {
    throw new DOMException("snatch cancelled", "AbortError");
  }

  // probe every peer once up front (parallel), then hand the whole
  // available/ordered list to the transport package in a single call — its
  // own per-peer retry loop already tries each peer's full download in
  // order, falling through to the next on a non-cancelled failure.
  const availablePeers = await probeAllPeersForBlob(info, allPeerAddrs, options);
  if (availablePeers.length === 0) {
    throw new Error("no peer has the blob (all probes failed)");
  }

  // don't bother attempting a download from a peer we're not friends with —
  // both platforms currently deny non-friend blob fetches, so it'd just
  // hang or fail. if every peer that has it is a non-friend, surface that
  // distinctly so the caller can offer a friend-request UI instead.
  const friendPeers = availablePeers.filter((peer) => isFriend(peer));
  if (friendPeers.length === 0) {
    throw new BlobAccessDeniedError(availablePeers);
  }

  const winner = friendPeers[0]!;
  const winnerOnline = options?.isPeerOnline?.(winner) ?? false;
  options?.onPeerAttempt?.(allPeerAddrs.indexOf(winner), allPeerAddrs.length, winnerOnline);
  log.debug(
    TAG,
    `probe winner: ${winner.slice(0, 16)}... (${winnerOnline ? "connected" : "responded to probe"}), starting download`
  );

  // both browser midden and TauriStreamNode satisfy the snatch contract
  // (download_verified_* on midden, proxy_request fallback on tauri).
  return snatchFromBrowserPeer(info, friendPeers, options);
}

// ---------------------------------------------------------------------------
// parallel peer probing
// ---------------------------------------------------------------------------

/** timeout for individual peer probes (short — probes should be fast) */
const PROBE_TIMEOUT_MS = 8000;

/**
 * probe all candidate peers in parallel and return every peer that reports
 * having the blob, in probe order (see `sortPeersByConnectivity` — connected
 * peers first). unlike `probePeersForBlob` (a single Promise.any winner,
 * used by the batch "probe once, download many" flow below),
 * `snatchBlob`/`snatchBlobToDisk` hand this whole ordered list to
 * `@freqhole/reliquary/transfer` in one call so its own per-peer retry loop
 * — which correctly does not retry a disk-write failure against another
 * peer, only a download failure — stays intact.
 */
async function probeAllPeersForBlob(
  info: SnatchBlobInfo,
  peerAddrs: string[],
  options?: SnatchOptions
): Promise<string[]> {
  if (peerAddrs.length === 0) return [];

  const sorted = sortPeersByConnectivity(peerAddrs, options?.isPeerOnline);

  log.debug(
    TAG,
    `probing ${sorted.length} peer(s) for blob ${info.blobId.slice(0, 8)}... blake3=${info.blake3?.slice(0, 16) ?? "<none>"}`
  );

  const settled = await Promise.allSettled(
    sorted.map((peerAddr) => probeSinglePeer(info, peerAddr, options))
  );
  const available = sorted.filter((_, i) => settled[i]!.status === "fulfilled");

  if (available.length === 0) {
    const errs = settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);
    log.warn(
      TAG,
      `all ${sorted.length} peer probe(s) failed for blob ${info.blobId.slice(0, 8)}...`,
      errs.map((e: unknown) => (e instanceof Error ? e.message : String(e)))
    );
  }

  return available;
}

/**
 * probe all candidate peers in parallel to find one that has the blob.
 * uses EnsureBlobRequest (lightweight: checks availability without downloading).
 * returns the nodeId of the first peer to respond positively, or null if none.
 * requires blake3 hash to be present on the blob info.
 */
async function probePeersForBlob(
  info: SnatchBlobInfo,
  peerAddrs: string[],
  options?: SnatchOptions
): Promise<string | null> {
  if (peerAddrs.length === 0) return null;

  // sort so connected peers are probed first (their responses arrive faster)
  const sorted = sortPeersByConnectivity(peerAddrs, options?.isPeerOnline);

  log.debug(
    TAG,
    `probing ${sorted.length} peer(s) for blob ${info.blobId.slice(0, 8)}... blake3=${info.blake3?.slice(0, 16) ?? "<none>"}`
  );

  const probes = sorted.map((peerAddr) => probeSinglePeer(info, peerAddr, options));

  try {
    // Promise.any resolves with the first fulfilled promise.
    // rejected probes (offline, doesn't have blob) are ignored until all fail.
    return await Promise.any(probes);
  } catch (err) {
    // AggregateError — all probes failed. surface each underlying error so
    // the failure mode (connection lost, blob unavailable, timeout, etc.)
    // is visible instead of just "all peer probes failed".
    const errs = (err as AggregateError | undefined)?.errors ?? [];
    log.warn(
      TAG,
      `all ${sorted.length} peer probe(s) failed for blob ${info.blobId.slice(0, 8)}...`,
      errs.map((e: unknown) => (e instanceof Error ? e.message : String(e)))
    );
    return null;
  }
}

/**
 * probe a single peer to check if it has the blob.
 * resolves with the peerAddr if the peer has it, rejects otherwise.
 */
async function probeSinglePeer(
  info: SnatchBlobInfo,
  peerAddr: string,
  options?: SnatchOptions
): Promise<string> {
  if (options?.signal?.aborted) {
    throw new DOMException("snatch cancelled", "AbortError");
  }

  const node = await getMiddenNode();

  if (typeof (node as any).open_bi !== "function") {
    throw new Error("p2p node does not support open_bi (required for ensure-blob protocol)");
  }

  log.debug(
    TAG,
    `probing peer ${peerAddr.slice(0, 16)}... for blake3=${info.blake3?.slice(0, 16) ?? "<none>"} (blobId=${info.blobId.slice(0, 16)}...)`
  );

  const attempt = async (label: string): Promise<boolean> => {
    return await withPeerTimeout(
      ensureBlobOverAlpn(node as any, peerAddr, info.blake3),
      PROBE_TIMEOUT_MS
    ).catch((err) => {
      log.warn(
        TAG,
        `probe ${label} to ${peerAddr.slice(0, 16)} threw:`,
        err instanceof Error ? err.message : err
      );
      throw err;
    });
  };

  let available: boolean;
  try {
    available = await attempt("attempt 1");
  } catch (err) {
    // connection lost / closed mid-probe is the common failure when the
    // friend transport is mid-reconnect. retry once after a short delay
    // — the iroh adapter auto-reconnect typically lands within a second.
    const msg = err instanceof Error ? err.message : String(err);
    const isTransient = /connection (lost|closed)|stream closed|reset|broken/i.test(msg);
    if (!isTransient) throw err;
    log.debug(TAG, `retrying probe to ${peerAddr.slice(0, 16)} after transient error`);
    await new Promise((r) => setTimeout(r, 1500));
    available = await attempt("attempt 2");
  }

  if (available) {
    log.debug(TAG, `probe to ${peerAddr.slice(0, 16)}: available=true`);
    return peerAddr;
  }
  log.warn(
    TAG,
    `probe to ${peerAddr.slice(0, 16)}: peer reported blob unavailable (blake3=${info.blake3?.slice(0, 16) ?? "<none>"})`
  );
  throw new Error(`peer ${peerAddr.slice(0, 16)} does not have the blob`);
}

/**
 * sort peer nodeIds so that connected peers come first.
 * preserves relative order within each group.
 */
function sortPeersByConnectivity(
  peerAddrs: string[],
  isPeerOnline?: (nodeId: string) => boolean
): string[] {
  if (!isPeerOnline) return peerAddrs;

  const online: string[] = [];
  const offline: string[] = [];

  for (const addr of peerAddrs) {
    if (isPeerOnline(addr)) {
      online.push(addr);
    } else {
      offline.push(addr);
    }
  }

  if (online.length > 0 && offline.length > 0) {
    log.debug(TAG, `peer ordering: ${online.length} connected, ${offline.length} not connected`);
  }

  return [...online, ...offline];
}

// ---------------------------------------------------------------------------
// per-peer download (browser)
// ---------------------------------------------------------------------------

/**
 * download and ingest a blob from an ordered list of candidate browser
 * peers, persisting the result into OPFS + IndexedDB via storeBlob.
 *
 * in tauri mode, prefers the native download path against the first
 * candidate: the rust side streams the blob into the FsStore and exports
 * it straight into blobz — the payload never crosses the IPC boundary and
 * never exists in JS memory. progress arrives via real
 * `blob-download-progress` events. this path has no equivalent in the
 * transport package (its contract is browser-only) and stays exactly as
 * skein's own tauri IPC call.
 *
 * the browser path hands the whole peer list to
 * `@freqhole/reliquary/transfer`'s `snatchBlob`, which owns the actual
 * download mechanics: per-peer retry, the bulk/streamed/proxy strategy
 * fallthrough, the tail-chunk wait, and the proxy fallback's explicit
 * hash check. this function then persists the result into OPFS +
 * IndexedDB via storeBlob (widget-specific concern, not part of the
 * package's contract).
 */
async function snatchFromBrowserPeer(
  info: SnatchBlobInfo,
  peerAddrs: string[],
  options?: SnatchOptions
): Promise<FileUploadResult> {
  if (isTauriMode() && info.blake3) {
    const peerAddr = peerAddrs[0]!;
    const node = (await getMiddenNode()) as any;
    if (typeof node.download_to_native_store === "function") {
      const meta = await withPeerTimeout(
        node.download_to_native_store(
          peerAddr,
          info.blake3,
          info.size || 0,
          options?.onProgress,
          info.filename,
          info.mime
        ) as Promise<{ size: number; mime: string | null }>,
        10 * 60_000
      );
      if (options?.signal?.aborted) {
        throw new DOMException("snatch cancelled", "AbortError");
      }
      localityCache.set(info.blobId, { locality: "local" });
      localityCache.set(info.blake3, { locality: "local" });
      log.debug(
        TAG,
        `tauri native snatch complete: ${formatFileSize(meta.size)} into blobz (no IPC payload)`
      );
      return {
        blobId: info.blake3,
        domain: info.domain,
        jobId: null,
        sha256: "",
        blake3: info.blake3,
        size: meta.size || info.size || 0,
        mime: meta.mime || info.mime,
        existing: false,
      };
    }
  }

  const node = (await getMiddenNode()) as unknown as BlobCapableNode;
  const downloaded = await transferSnatchBlob(
    node,
    peerAddrs,
    toTransferSnatchInfo(info),
    toTransferOptions(options)
  );

  if (downloaded.mime && downloaded.mime !== info.mime) {
    info = { ...info, mime: downloaded.mime };
  }

  if (options?.signal?.aborted) {
    throw new DOMException("snatch cancelled", "AbortError");
  }

  log.debug(TAG, `browser snatch: storing ${formatFileSize(downloaded.bytes.length)} in OPFS...`);

  // store the bytes — the store computes its own blake3/sha256 from the
  // data (and a legacy-metadata sha256), but the package already handed
  // back a cryptographically verified blake3 for this content, so that
  // known-good hash stays authoritative for the returned/cached id rather
  // than trusting a freshly recomputed one. widget-level domain
  // classification has no field on the shared record, so it goes into
  // metadata instead.
  const record = await storeBlob(downloaded.bytes.buffer as ArrayBuffer, {
    filename: info.filename,
    mime: info.mime,
    blob_type: "original",
    parent_blob_id: null,
    metadata: { domain: info.domain, source: "snatch" },
  });
  const blake3Id = downloaded.blake3 || record.blob_id;

  // clear thumbnail cache for this blob
  const key200 = cacheKey(info.blobId, 200);
  const key50 = cacheKey(info.blobId, 50);
  thumbnailCache.delete(key200);
  thumbnailCache.delete(key50);

  localityCache.set(info.blobId, { locality: "local" });
  localityCache.set(blake3Id, { locality: "local" });

  log.debug(
    TAG,
    `browser snatch complete: blob ${blake3Id.slice(0, 8)}... (doc blobId=${info.blobId.slice(0, 8)}...)`
  );

  return {
    blobId: blake3Id,
    domain: info.domain,
    jobId: null,
    sha256: record.sha256 ?? "",
    blake3: blake3Id,
    size: info.size || record.size,
    mime: info.mime,
    existing: false,
  };
}

// ---------------------------------------------------------------------------
// snatch straight to disk (browser only — skips OPFS/IndexedDB entirely)
// ---------------------------------------------------------------------------

/** result from a disk-only snatch — no local blob record is created. */
export interface SnatchToDiskResult {
  /** number of bytes written to disk */
  size: number;
  /** mime type, refined by the responding peer when available */
  mime: string;
  /** blake3 hash of the downloaded content, when known */
  blake3: string | null;
}

/**
 * check whether "download straight to disk" is available in the current
 * runtime. this is deliberately browser-only: tauri mode already writes
 * blob storage straight to the user's real filesystem (there's no OPFS
 * concept to skip there), and the reliquary hub peer has no UI at all.
 * requires the File System Access API (`window.showSaveFilePicker`) —
 * unsupported in Safari and some older browsers as of this writing.
 */
export function canSnatchToDisk(): boolean {
  if (isTauriMode()) return false;
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/**
 * download a blob straight from a canvas peer to a user-chosen disk
 * location, without ever writing it into OPFS/IndexedDB.
 *
 * probes every candidate peer once up front, then hands the whole ordered
 * list of peers that reported having the blob to
 * `@freqhole/reliquary/transfer`'s `snatchBlobToDisk` in a single call —
 * its own per-peer retry loop owns the actual transfer mechanics (chunk-
 * streamed direct-to-`writable` when the node supports it, buffered
 * download + single write otherwise, the tail-chunk wait, and the
 * truncate-on-failure/no-truncate-on-cancel semantics), including the
 * important distinction between a download failure (retried against the
 * next peer) and a disk-write failure (surfaced immediately, never
 * retried — retrying would re-download the whole payload for nothing).
 *
 * browser-only; throws in tauri mode.
 */
export async function snatchBlobToDisk(
  info: SnatchBlobInfo,
  peers: PeersMap,
  writable: FileSystemWritableFileStream,
  options?: SnatchOptions
): Promise<SnatchToDiskResult> {
  if (isTauriMode()) {
    throw new Error("snatchBlobToDisk is browser-only — tauri already writes blobs to disk");
  }

  const allPeerAddrs = await getPeerNodeIds(peers);

  // defensive: coerce blob info strings — automerge may store them as Text objects
  info = {
    ...info,
    blobId: coerceStr(info.blobId),
    filename: coerceStr(info.filename),
    mime: coerceStr(info.mime),
    blake3: coerceStr(info.blake3),
    domain: coerceStr(info.domain),
  };

  if (allPeerAddrs.length === 0) {
    throw new Error("no peers available for snatch");
  }

  if (options?.signal?.aborted) {
    throw new DOMException("snatch cancelled", "AbortError");
  }

  const availablePeers = await probeAllPeersForBlob(info, allPeerAddrs, options);
  if (availablePeers.length === 0) {
    throw new Error("no peer has the blob (all probes failed)");
  }

  const winner = availablePeers[0]!;
  const winnerOnline = options?.isPeerOnline?.(winner) ?? false;
  options?.onPeerAttempt?.(allPeerAddrs.indexOf(winner), allPeerAddrs.length, winnerOnline);

  const node = (await getMiddenNode()) as unknown as BlobCapableNode;
  const result = await transferSnatchBlobToDisk(
    node,
    availablePeers,
    toTransferSnatchInfo(info),
    writable,
    toTransferOptions(options)
  );
  log.debug(
    TAG,
    `snatch-to-disk complete: ${formatFileSize(result.size)} written to disk (OPFS/IndexedDB skipped)`
  );
  return {
    size: result.size,
    mime: result.mime || info.mime,
    blake3: result.blake3 || info.blake3 || null,
  };
}

// ---------------------------------------------------------------------------
// batch snatch
// ---------------------------------------------------------------------------


/** options for batch snatch operations */
export interface BatchSnatchOptions {
  /** called after each blob is successfully snatched (or confirmed local).
   *  use for progressive rendering — display each blob as it becomes available. */
  onBlobComplete?: (index: number, result: FileUploadResult) => void;
  /** called with overall progress. completedCount includes already-local blobs.
   *  blobProgress is 0-1 for the current download, or -1 between downloads. */
  onProgress?: (completedCount: number, totalCount: number, blobProgress: number) => void;
  /** abort signal */
  signal?: AbortSignal;
  /** check if a peer is currently connected */
  isPeerOnline?: (nodeId: string) => boolean;
  /** a representative blob to probe for when finding peers. if not provided,
   *  the first blob in the array with a blake3 hash is used.
   *  for peedeeeff: pass the first page blob (a peer with page 1 has all pages).
   *  for bins: pass any representative blob. */
  probeBlobInfo?: SnatchBlobInfo;
}

/**
 * snatch multiple blobs from peers in a single batch.
 * the key optimisation is: probe once, download many. instead of probing
 * for each blob individually, we probe with a single representative blob
 * and then download all pending blobs from the winning peer.
 *
 * already-local blobs are skipped (via locality cache or grimoire lookup).
 * returns an array parallel to the input — null for blobs that couldn't
 * be snatched from any peer.
 */
export async function snatchBlobBatch(
  blobs: SnatchBlobInfo[],
  peers: PeersMap,
  options?: BatchSnatchOptions
): Promise<(FileUploadResult | null)[]> {
  const allPeerAddrs = await getPeerNodeIds(peers);
  if (allPeerAddrs.length === 0) {
    throw new Error("no peers available for batch snatch");
  }

  if (options?.signal?.aborted) {
    throw new DOMException("cancelled", "AbortError");
  }

  const totalCount = blobs.length;
  const results: (FileUploadResult | null)[] = new Array(totalCount).fill(null);
  let completedCount = 0;

  // coerce all blob info strings (automerge Text objects -> plain strings)
  const coercedBlobs: SnatchBlobInfo[] = blobs.map((b) => ({
    ...b,
    blobId: coerceStr(b.blobId),
    filename: coerceStr(b.filename),
    mime: coerceStr(b.mime),
    blake3: coerceStr(b.blake3),
    domain: coerceStr(b.domain),
  }));

  // --- skip already-local blobs ---
  const pending: number[] = [];

  for (let i = 0; i < coercedBlobs.length; i++) {
    const info = coercedBlobs[i];

    // check locality cache first (O(1) Map lookup)
    const cached = localityCache.get(info.blobId);
    if (cached && cached.locality === "local") {
      const result: FileUploadResult = {
        blobId: cached.metadata?.id ?? info.blobId,
        domain: info.domain,
        jobId: null,
        sha256: "",
        blake3: cached.metadata?.blake3 ?? info.blake3 ?? null,
        size: cached.metadata?.size ?? info.size ?? 0,
        mime: cached.metadata?.mime ?? info.mime,
        existing: true,
      };
      results[i] = result;
      completedCount++;
      options?.onBlobComplete?.(i, result);
      options?.onProgress?.(completedCount, totalCount, -1);
      continue;
    }

    // tauri mode with blake3: try a quick local check via blob_get_path.
    // skein keys blobs by blake3 so blobId === blake3 in most cases; if the
    // caller passed a different identifier, fall back to the blake3 hash.
    if (isTauriMode() && info.blake3) {
      try {
        const localCheck = (await dispatch("blob_get_path", {
          blake3: info.blake3,
        })) as { path?: string; mime?: string | null; size?: number | null } | null;
        if (localCheck?.path) {
          log.debug(
            TAG,
            `batch: blob ${i} found locally by blake3 (${info.blake3.slice(0, 8)}...)`
          );
          localityCache.set(info.blobId, { locality: "local" });
          const result: FileUploadResult = {
            blobId: info.blake3,
            domain: info.domain,
            jobId: null,
            sha256: "",
            blake3: info.blake3,
            size: localCheck.size ?? info.size ?? 0,
            mime: localCheck.mime ?? info.mime,
            existing: true,
          };
          results[i] = result;
          completedCount++;
          options?.onBlobComplete?.(i, result);
          options?.onProgress?.(completedCount, totalCount, -1);
          continue;
        }
      } catch (err) {
        // NotFound is the expected "remote" signal — only log unexpected errors
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("not found") && !msg.includes("NotFound")) {
          log.debug(TAG, `batch: local blake3 check failed for blob ${i}:`, err);
        }
      }
    }

    // non-tauri mode: use checkBlobLocality
    if (!isTauriMode()) {
      try {
        const localInfo = await checkBlobLocality(info.blobId, info.blake3);
        if (localInfo.locality === "local") {
          log.debug(TAG, `batch: blob ${i} already local`);
          const result: FileUploadResult = {
            blobId: localInfo.metadata?.id ?? info.blobId,
            domain: info.domain,
            jobId: null,
            sha256: "",
            blake3: localInfo.metadata?.blake3 ?? info.blake3 ?? null,
            size: localInfo.metadata?.size ?? info.size ?? 0,
            mime: localInfo.metadata?.mime ?? info.mime,
            existing: true,
          };
          results[i] = result;
          completedCount++;
          options?.onBlobComplete?.(i, result);
          options?.onProgress?.(completedCount, totalCount, -1);
          continue;
        }
      } catch (err) {
        log.debug(TAG, `batch: locality check failed for blob ${i}:`, err);
      }
    }

    pending.push(i);
  }

  log.debug(
    TAG,
    `batch: ${completedCount}/${totalCount} already local, ${pending.length} to download`
  );

  // if everything is local, we're done
  if (pending.length === 0) {
    return results;
  }

  // --- phase 2: probe once, download many ---
  let remaining = [...allPeerAddrs];

  while (remaining.length > 0 && pending.length > 0) {
    if (options?.signal?.aborted) {
      throw new DOMException("cancelled", "AbortError");
    }

    // pick the probe blob: user-specified, or first pending blob with blake3
    const probeBlob =
      options?.probeBlobInfo ??
      coercedBlobs[pending.find((i) => coercedBlobs[i].blake3) ?? pending[0]];

    // probe with SnatchOptions-compatible options
    const probeOpts: SnatchOptions = {
      isPeerOnline: options?.isPeerOnline,
      signal: options?.signal,
    };
    const bestPeer = await probePeersForBlob(probeBlob, remaining, probeOpts);

    if (!bestPeer) {
      log.debug(TAG, "batch: no peer responded to probe, aborting");
      break;
    }

    log.debug(
      TAG,
      `batch: probe winner ${bestPeer.slice(0, 16)}..., downloading ${pending.length} blob(s)`
    );

    const failedOnThisPeer: number[] = [];

    for (let p = 0; p < pending.length; p++) {
      const idx = pending[p];

      if (options?.signal?.aborted) {
        throw new DOMException("cancelled", "AbortError");
      }

      const info = coercedBlobs[idx];
      const snatchOpts: SnatchOptions = {
        signal: options?.signal,
        isPeerOnline: options?.isPeerOnline,
        onProgress: (fraction) => {
          options?.onProgress?.(completedCount, totalCount, fraction);
        },
      };

      try {
        const result = await snatchFromBrowserPeer(info, [bestPeer], snatchOpts);
        results[idx] = result;
        completedCount++;
        options?.onBlobComplete?.(idx, result);
        options?.onProgress?.(completedCount, totalCount, -1);
      } catch (err) {
        log.debug(
          TAG,
          `batch: download failed for blob ${idx} from ${bestPeer.slice(0, 16)}...:`,
          err
        );
        failedOnThisPeer.push(idx);
      }
    }

    // remove successfully downloaded blobs from pending, keep only failures
    pending.length = 0;
    pending.push(...failedOnThisPeer);

    // exclude this peer and retry with remaining peers if there are failures
    remaining = remaining.filter((p) => p !== bestPeer);

    if (pending.length > 0 && remaining.length > 0) {
      // re-enter the loop — probeBlob will pick from the updated pending list
      // (which now only contains blobs that failed on the previous peer).
      // if options.probeBlobInfo was set, re-probing with the same representative
      // blob on a different peer is still valid.
      log.debug(
        TAG,
        `batch: ${pending.length} blob(s) failed, retrying with ${remaining.length} remaining peer(s)`
      );
    }
  }

  if (pending.length > 0) {
    log.debug(TAG, `batch: ${pending.length} blob(s) could not be snatched from any peer`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// save blob to disk
// ---------------------------------------------------------------------------

/**
 * save a locally-stored blob to a user-chosen location on the filesystem.
 * opens a native save dialog, then copies the blob file to the chosen path.
 *
 * only works after the blob exists locally (either uploaded or snatched).
 * requires Tauri mode.
 *
 * for browser mode, falls back to a programmatic <a download> click using
 * blob data fetched from the local API.
 *
 * returns true if the file was saved, false if the user cancelled.
 */
export async function saveBlobToDisk(blobId: string, filename: string): Promise<boolean> {
  if (!isTauriMode()) {
    // browser fallback: fetch blob data and trigger download
    return saveBlobToDiskBrowser(blobId, filename);
  }

  try {
    // open native save dialog with suggested filename
    const destPath = await save({
      defaultPath: filename,
      title: "save file",
    });

    if (!destPath) {
      return false; // user cancelled
    }

    // copy blob file to chosen path via custom Tauri command
    await invoke("save_blob_to_path", {
      blobId,
      destPath,
    });

    log.debug(TAG, `saved blob ${blobId.slice(0, 8)}... to ${destPath}`);
    return true;
  } catch (err) {
    log.error(TAG, "save to disk failed:", err);
    throw err;
  }
}

/**
 * reveal a blob's file in the OS file manager (Finder on macOS, Explorer on Windows).
 * only works in Tauri mode — the blob must exist locally.
 * returns true if the reveal succeeded, false if the path couldn't be resolved.
 */
export async function revealBlobInFinder(blobId: string): Promise<boolean> {
  if (!isTauriMode()) {
    return false;
  }

  try {
    const localPath = await getBlobLocalPath(blobId);
    if (!localPath) {
      log.warn(TAG, "no local path for blob, cannot reveal:", blobId.slice(0, 8));
      return false;
    }

    await revealItemInDir(localPath);
    return true;
  } catch (err) {
    log.error(TAG, "reveal in finder failed:", err);
    return false;
  }
}

/**
 * browser fallback for save to disk — fetch blob data as base64 and
 * trigger a programmatic download via a hidden <a> element.
 */
async function saveBlobToDiskBrowser(blobId: string, filename: string): Promise<boolean> {
  try {
    // fetch blob data from local API (browser mode would need HTTP transport)
    const dataUrl = await getFullBlobDataUrl(blobId);
    if (!dataUrl) {
      throw new Error("could not fetch blob data for download");
    }

    // convert data URL to blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    // trigger download via hidden <a> element
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();

    // cleanup after a short delay
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);

    return true;
  } catch (err) {
    log.error(TAG, "browser save to disk failed:", err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// full blob data (for previews)
// ---------------------------------------------------------------------------

/**
 * fetch the full blob data (not just thumbnail) as a data URL.
 * used for full-screen photo preview, video playback, etc.
 *
 * resolution order:
 * 1. local grimoire via api_call
 * 2. P2P proxy via connected canvas peers
 *
 * returns null if the blob data is not available.
 */
export async function getFullBlobDataUrl(blobId: string, peers?: PeersMap): Promise<string | null> {
  // try local first
  const localResult = await fetchFullBlobLocal(blobId);
  if (localResult) {
    return localResult;
  }

  // try P2P fallback
  if (peers) {
    const peerResult = await fetchFullBlobFromPeers(blobId, peers);
    if (peerResult) {
      return peerResult;
    }
  }

  return null;
}

/**
 * fetch full blob data from local grimoire.
 * tries the path-based approach first (for asset:// URL in Tauri),
 * falls back to base64 data endpoint.
 */
async function fetchFullBlobLocal(blobId: string): Promise<string | null> {
  if (!isTauriMode()) {
    try {
      const url = await getBlobObjectURL(blobId);
      return url;
    } catch {
      return null;
    }
  }

  try {
    // skein dispatch action returns { meta: { mime, ... }, data: base64 }
    const response = (await dispatch("blob_get", {
      blake3: blobId,
    })) as { meta?: { mime?: string | null }; data?: string } | null;
    if (!response?.data) return null;
    const mime = response.meta?.mime ?? "application/octet-stream";
    return `data:${mime};base64,${response.data}`;
  } catch {
    return null;
  }
}

/**
 * fetch full blob data from canvas peers via P2P proxy.
 */
async function fetchFullBlobFromPeers(blobId: string, peers: PeersMap): Promise<string | null> {
  const peerAddrs = await getPeerNodeIds(peers);

  if (peerAddrs.length === 0) {
    return null;
  }

  if (!isTauriMode()) {
    try {
      const node = await getMiddenNode();
      const nodeAny = node as any;

      for (const peerAddr of peerAddrs) {
        try {
          let bytes: Uint8Array | null = null;
          let contentType = "application/octet-stream";

          if (typeof nodeAny.download_verified_by_id === "function") {
            const result = await withPeerTimeout<any>(
              nodeAny.download_verified_by_id(peerAddr, blobId),
              30000
            );
            bytes = result[0] as Uint8Array;
          } else if (typeof nodeAny.fetch_blob === "function") {
            const result = await withPeerTimeout<any>(nodeAny.fetch_blob(peerAddr, blobId), 30000);
            bytes = result.data;
            contentType = result.content_type || contentType;
          }

          if (bytes) {
            const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
            log.debug(
              TAG,
              `fetched full blob ${blobId.slice(0, 8)}... from browser peer ${peerAddr.slice(0, 16)}...`
            );
            return URL.createObjectURL(blob);
          }
        } catch (err) {
          log.debug(
            TAG,
            `browser peer ${peerAddr.slice(0, 16)}... failed for full blob ${blobId.slice(0, 8)}...:`,
            err
          );
          continue;
        }
      }
    } catch (err) {
      log.debug(TAG, "browser P2P full blob fetch setup failed:", err);
    }
    return null;
  }

  // tauri mode has no working P2P full-blob-data fallback here — blob
  // transfer between tauri peers goes through the native iroh-blobs/skein/1
  // download paths (see snatchFromBrowserPeer's download_to_native_store
  // branch), not this preview-data-URL path.
  return null;
}

// ---------------------------------------------------------------------------
// blob local path (for asset:// URLs in Tauri video/audio playback)
// ---------------------------------------------------------------------------

/**
 * get the local filesystem path for a blob.
 * used to construct asset:// URLs for video/audio playback in Tauri.
 * returns null if the blob has no local path or isn't available locally.
 */
export async function getBlobLocalPath(blobId: string): Promise<string | null> {
  if (!isTauriMode()) {
    return null;
  }

  try {
    // skein dispatch action returns { path, mime, size }
    const response = (await dispatch("blob_get_path", {
      blake3: blobId,
    })) as { path?: string } | null;
    return response?.path ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// document pages (PDF rendered page images)
// ---------------------------------------------------------------------------

/**
 * resolve a blob ID to a locally-available URL — no peer fallback.
 * - Tauri: tries getBlobLocalPath → convertToAssetUrl (asset:// URL)
 *   falls back to base64 data URL via IPC
 * - browser: tries OPFS blob: URL via the blob store
 * returns null if the blob is not available locally.
 */
export async function getLocalBlobUrl(blobId: string, blake3?: string): Promise<string | null> {
  if (!blobId) {
    log.debug(TAG, "getLocalBlobUrl: no blobId provided");
    return null;
  }

  log.debug(
    TAG,
    "getLocalBlobUrl:",
    blobId,
    "blake3:",
    blake3?.slice(0, 12),
    "isTauri:",
    isTauriMode()
  );

  if (isTauriMode()) {
    // in skein, blobId is already the blake3 hex — no separate UUID lookup
    // needed (unlike grimoire). try the asset:// path first, fall back to
    // base64 data URL if path resolution fails.
    const resolvedId = blobId;

    try {
      log.debug(TAG, "getLocalBlobUrl: trying getBlobLocalPath for", blobId);
      const localPath = await getBlobLocalPath(resolvedId);
      log.debug(TAG, "getLocalBlobUrl: getBlobLocalPath returned:", localPath);
      if (localPath) {
        const assetUrl = await convertToAssetUrl(localPath);
        log.debug(TAG, "getLocalBlobUrl: asset URL:", assetUrl.slice(0, 80));
        return assetUrl;
      }
    } catch (err) {
      log.debug(TAG, "getLocalBlobUrl: getBlobLocalPath threw:", err);
      // fall through to data URL approach
    }

    // fall back to base64 data URL via blob_get dispatch
    try {
      log.debug(TAG, "getLocalBlobUrl: trying blob_get fallback for", resolvedId);
      const dataUrl = await fetchFullBlobLocal(resolvedId);
      if (dataUrl) {
        log.debug(TAG, "getLocalBlobUrl: returning base64 data URL");
        return dataUrl;
      }
    } catch (err) {
      log.debug(TAG, "getLocalBlobUrl: blob_get fallback threw:", err);
    }

    log.debug(TAG, "getLocalBlobUrl: tauri — all paths failed for", blobId);
    return null;
  }

  // browser mode: check OPFS — use resolveBlob which tries blob_id, sha256,
  // and blake3 indexes. getBlobObjectURL only passes blobId (no blake3) so
  // it misses blobs uploaded by Tauri peers (whose server UUID doesn't match
  // the browser's sha256-based primary key).
  try {
    log.debug(TAG, "getLocalBlobUrl: browser — trying OPFS resolveBlob...");
    const record = await resolveBlob(blobId, blake3);
    log.debug(
      TAG,
      "getLocalBlobUrl: resolveBlob returned:",
      record ? { blob_id: record.blob_id, filename: record.filename } : null
    );
    if (!record) return null;

    const data = await getBlobData(record.blob_id);
    if (!data) {
      log.debug(TAG, "getLocalBlobUrl: OPFS file not found for resolved blob_id:", record.blob_id);
      return null;
    }

    const mime = record.mime ?? "application/octet-stream";
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    log.debug(TAG, "getLocalBlobUrl: OPFS blob URL created:", url.slice(0, 60));
    return url;
  } catch (err) {
    log.debug(TAG, "getLocalBlobUrl: OPFS threw:", err);
    return null;
  }
}

/**
 * fetch the list of rendered page image blobs for a document.
 * returns an array of page info objects, or an empty array if no pages
 * are available yet (the rendering job may still be running, or — in
 * browser mode — no candidate peer could be reached).
 *
 * in tauri mode, renders locally via the `pdf_render_pages` dispatch (the
 * tauri host itself has the imagemagick/ghostscript pipeline). in browser
 * mode, `peerNodeIds` (hub peers should be listed first) are tried in
 * order over the `skein/1` proxy protocol — see `p2p/skein-proxy-client.ts`
 * — since a browser peer has no native rendering backend of its own.
 */
export interface DocumentPageInfo {
  page_blob_id: string;
  page_number: number | null;
  total_pages: number | null;
  blake3: string | null;
  size: number | null;
  mime: string | null;
  filename: string | null;
}

export async function getDocumentPages(
  blobId: string,
  peerNodeIds: string[] = []
): Promise<DocumentPageInfo[]> {
  // session cache — document rendering is expensive, and the peedeeeff
  // widget polls this function repeatedly. cache the result by source
  // blake3 so subsequent polls return immediately.
  const cached = pdfPagesCache.get(blobId);
  if (cached) return cached;

  if (isTauriMode()) {
    try {
      const pages = (await dispatch("pdf_render_pages", {
        blake3: blobId,
      })) as DocumentPageInfo[] | null;

      const result = Array.isArray(pages) ? pages : [];
      if (result.length > 0) {
        pdfPagesCache.set(blobId, result);
      }
      return result;
    } catch (err) {
      log.warn(TAG, "getDocumentPages failed:", err);
      return [];
    }
  }

  if (peerNodeIds.length === 0) {
    return [];
  }

  try {
    const node = (await getMiddenNode()) as unknown as SkeinProxyNode;
    const pages = await requestDocumentPagesFromPeers(node, peerNodeIds, blobId);
    if (pages && pages.length > 0) {
      pdfPagesCache.set(blobId, pages);
      return pages;
    }
    return [];
  } catch (err) {
    log.warn(TAG, "getDocumentPages: peer render request failed:", err);
    return [];
  }
}

const pdfPagesCache = new Map<string, DocumentPageInfo[]>();

/**
 * convert a local filesystem path to a Tauri asset:// URL.
 * used for streaming video/audio from local storage without loading
 * the entire file into memory.
 */
export async function convertToAssetUrl(localPath: string): Promise<string> {
  return convertFileSrc(localPath);
}

// ---------------------------------------------------------------------------
// pickFiles
// ---------------------------------------------------------------------------

/**
 * pick multiple files via the native file picker.
 * returns an array of picked files, or an empty array on cancel.
 */
export async function pickFiles(): Promise<PickedFile[]> {
  if (isTauriMode()) {
    return pickFilesTauri();
  }
  return pickFilesBrowser();
}

/** extensions the peedeeeff widget can rasterize directly via magick+gs —
 *  kept in sync with `pickDocumentFile`'s dialog filter/accept list below.
 *  always available in tauri mode (gated separately at boot by
 *  `pdf_check_available`, which hides the whole widget if magick/gs are
 *  missing) and always offered in browser mode (rendering is delegated to
 *  a hub/tauri peer regardless — see file-utils.ts's `getDocumentPages`). */
const DOCUMENT_EXTENSIONS = new Set(["pdf", "ps", "eps", "txt", "text", "log"]);

/** additional formats rasterizable only when `pandoc` + `typst` are both
 *  available (converted to pdf first, then rasterized via the same
 *  magick+gs pipeline as a native pdf — see tauri's `pdf.rs`). gated by
 *  `pandocFormatsAvailable` in tauri mode (probed at boot, see boot.ts's
 *  `pandoc_check_available` dispatch); always offered in browser mode,
 *  since rendering there is always delegated to a peer anyway. */
const PANDOC_DOCUMENT_EXTENSIONS = new Set([
  "epub",
  "docx",
  "odt",
  "rtf",
  "md",
  "markdown",
  "html",
  "htm",
]);

/** whether the local tauri host has `pandoc` + `typst` available — set once
 *  at boot (see boot.ts) via a `pandoc_check_available` dispatch. defaults
 *  to `true` so browser mode (which never calls the setter, since it has no
 *  local backend to probe and always delegates rendering to a peer instead)
 *  offers the broader format list unconditionally. */
let pandocFormatsAvailable = true;

/** set from boot.ts once the local `pandoc_check_available` capability
 *  probe resolves (tauri mode only). */
export function setPandocFormatsAvailable(available: boolean): void {
  pandocFormatsAvailable = available;
}

/**
 * true if `filename`'s extension matches a format the peedeeeff widget can
 * rasterize (pdf, postscript, plain text, and — when pandoc+typst are
 * available — epub/docx/odt/rtf/md/html). used to route document files to
 * an auto-created peedeeeff widget during multi-file uploads.
 */
export function isDocumentFilename(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return false;
  if (DOCUMENT_EXTENSIONS.has(ext)) return true;
  return pandocFormatsAvailable && PANDOC_DOCUMENT_EXTENSIONS.has(ext);
}

/**
 * open a file picker filtered to document formats the peedeeeff widget can
 * rasterize: pdf, postscript (ps/eps), plain text, and — when pandoc+typst
 * are available — epub/docx/odt/rtf/md/html (converted to pdf first). in
 * Tauri mode, uses the native dialog with an extension filter. in browser
 * mode, uses a hidden input with a matching `accept` list. returns null if
 * the user cancels.
 */
export async function pickDocumentFile(): Promise<PickedFile | null> {
  if (isTauriMode()) {
    return pickDocumentFileTauri();
  }
  return pickDocumentFileBrowser();
}

function documentPickerExtensions(): string[] {
  const extensions = [...DOCUMENT_EXTENSIONS];
  if (pandocFormatsAvailable) {
    extensions.push(...PANDOC_DOCUMENT_EXTENSIONS);
  }
  return extensions;
}

async function pickDocumentFileTauri(): Promise<PickedFile | null> {
  try {
    const result = await open({
      multiple: false,
      filters: [{ name: "documents", extensions: documentPickerExtensions() }],
    });

    if (result === null) return null;

    const filePath = Array.isArray(result) ? result[0] : result;
    if (!filePath) return null;

    const filename = filePath.split(/[\\/]/).pop() ?? filePath;

    return {
      path: filePath,
      filename,
      size: 0,
      file: null,
    };
  } catch (err) {
    log.error(TAG, "document file picker failed:", err);
    return null;
  }
}

async function pickDocumentFileBrowser(): Promise<PickedFile | null> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = documentPickerExtensions()
    .map((ext) => `.${ext}`)
    .join(",");
  input.style.display = "none";


  document.body.appendChild(input);

  try {
    input.click();

    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener("change", () => {
        resolve(input.files?.[0] ?? null);
      });

      const onFocus = () => {
        window.removeEventListener("focus", onFocus);
        setTimeout(() => resolve(null), 300);
      };
      window.addEventListener("focus", onFocus);
    });

    if (!file) return null;

    return {
      path: null,
      filename: file.name,
      size: file.size,
      file,
    };
  } catch (err) {
    log.error(TAG, "browser PDF file picker failed:", err);
    return null;
  } finally {
    input.remove();
  }
}

/** Tauri-mode multi-file picker — uses @tauri-apps/plugin-dialog with multiple: true */
async function pickFilesTauri(): Promise<PickedFile[]> {
  try {
    const result = await open({ multiple: true });

    if (result === null) {
      return [];
    }

    // open() with multiple:true returns string[] | null
    const paths = Array.isArray(result) ? result : [result];
    return paths
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((filePath) => ({
        path: filePath,
        filename: filePath.split(/[\\/]/).pop() ?? filePath,
        size: 0,
        file: null,
      }));
  } catch (err) {
    log.error(TAG, "native multi-file picker failed:", err);
    return [];
  }
}

/** browser-mode multi-file picker — uses a hidden <input type="file" multiple> */
async function pickFilesBrowser(): Promise<PickedFile[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";

  document.body.appendChild(input);

  try {
    input.click();

    const files = await new Promise<FileList | null>((resolve) => {
      input.addEventListener("change", () => {
        resolve(input.files);
      });

      const onFocus = () => {
        window.removeEventListener("focus", onFocus);
        setTimeout(() => resolve(null), 300);
      };
      window.addEventListener("focus", onFocus);
    });

    if (!files || files.length === 0) {
      return [];
    }

    return Array.from(files).map((file) => ({
      path: null,
      filename: file.name,
      size: file.size,
      file,
    }));
  } catch (err) {
    log.error(TAG, "browser multi-file picker failed:", err);
    return [];
  } finally {
    input.remove();
  }
}

// ---------------------------------------------------------------------------
// formatUploadError
// ---------------------------------------------------------------------------

/**
 * turn an upload failure (a plain string from a rejected tauri `dispatch()`
 * call, an Error, or anything else) into a short, user-facing message.
 * widgets have very little room for text, so this stays terse (~60 chars)
 * rather than surfacing the full rust error chain.
 */
export function formatUploadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("no space left") || lower.includes("enospc")) {
    return "upload failed: not enough disk space";
  }
  if (lower.includes("permission denied") || lower.includes("eacces")) {
    return "upload failed: permission denied";
  }
  if (
    lower.includes("no such file or directory") ||
    lower.includes("enoent")
  ) {
    return "upload failed: file not found (moved or deleted?)";
  }
  if (lower.includes("must be an absolute path")) {
    return "upload failed: invalid file path";
  }

  const trimmed = raw.trim();
  if (!trimmed) return "upload failed";
  return trimmed.length > 60
    ? `upload failed: ${trimmed.slice(0, 57)}...`
    : `upload failed: ${trimmed}`;
}

// ---------------------------------------------------------------------------
// uploadFile
// ---------------------------------------------------------------------------

/**
 * upload a picked file to grimoire via the ingest pipeline.
 * in Tauri mode, passes the file path directly (no data copy needed).
 * in browser mode, reads the file as base64 and sends the data.
 *
 * NOTE: upload currently requires Tauri mode. browser-only upload will
 * be supported once an HTTP fallback is implemented.
 */
export async function uploadFile(
  picked: PickedFile,
  options?: UploadOptions
): Promise<FileUploadResult> {
  if (!isTauriMode()) {
    if (!picked.file) {
      throw new Error("no File object available in browser mode");
    }

    const domain = classifyDomain(picked.file.type || "application/octet-stream");
    const record = await storeBlobFromFile(
      picked.file,
      { metadata: { domain } },
      {
        onProgress: options?.onProgress,
        signal: options?.signal,
      }
    );

    if (options?.signal?.aborted) {
      throw new DOMException("upload cancelled", "AbortError");
    }

    // generate browser-side thumbnail for images
    let thumbnailDataUrl: string | null = null;
    if (picked.file) {
      thumbnailDataUrl = await generateThumbnailDataUrl(picked.file);
    }

    return {
      blobId: record.blob_id,
      domain: getBlobDomain(record),
      jobId: null,
      sha256: record.sha256 ?? "",
      blake3: record.blake3 || "",
      size: record.size,
      mime: record.mime,
      existing: false,
      thumbnailDataUrl,
    };
  }

  // ---- tauri mode --------------------------------------------------------
  // routes the file through rust's `blobz::Store::register_path()`, which
  // streams it through blake3 in fixed-size chunks and registers it as an
  // "external" reference (the file stays exactly where the native picker
  // found it) — never loads the whole file into memory, unlike the old
  // read-the-whole-file-then-base64-round-trip path this replaced (see
  // docs/narthex-widgets-and-file-transfer-plan.md section 7 for the full
  // "three copies of a multi-gigabyte file in memory" root-cause writeup).
  //
  // no OPFS/IndexedDB mirror here — tauri never reads blobs back through
  // the browser blob-store (media playback, locality checks, and preview
  // data all go through rust dispatch calls like `blob_get_path`/`blob_get`,
  // see getLocalBlobUrl()/getMediaPlaybackUrl()/checkBlobLocality()), and
  // the browser blob worker's blake3 hasher has no midden module to hash
  // with in a tauri build (it always degrades to an empty string), so a
  // mirror write here was keyed under a bogus id and, once OPFS started
  // rejecting empty names outright, threw and failed the whole upload even
  // though rust had already stored the blob successfully.

  if (!picked.path) {
    throw new Error("tauri uploadFile requires picked.path");
  }

  const mime = guessMimeFromFilename(picked.filename);
  const uploadId = crypto.randomUUID();

  // wire cancellation: flag the rust-side hashing pass by upload id. the
  // dispatch rejects with "upload cancelled" in its message when the flag
  // lands before the pass finishes.
  let onAbort: (() => void) | null = null;
  if (options?.signal) {
    onAbort = () => {
      void dispatch("blob_insert_cancel", { upload_id: uploadId }).catch((err) => {
        log.debug(TAG, "blob_insert_cancel dispatch failed (non-fatal):", err);
      });
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let unlisten: (() => void) | null = null;
  if (options?.onProgress) {
    const onProgress = options.onProgress;
    try {
      unlisten = await listen<{ uploadId: string; bytesRead: number; total: number }>(
        "blob-insert-progress",
        (event) => {
          if (event.payload.uploadId !== uploadId) return;
          if (event.payload.total <= 0) return;
          onProgress(Math.min(1, event.payload.bytesRead / event.payload.total));
        }
      );
    } catch (err) {
      // progress is a nice-to-have — a failure to subscribe must not block
      // the actual upload.
      log.debug(TAG, "failed to subscribe to blob-insert-progress:", err);
    }
  }

  let response: {
    meta: {
      blake3: string;
      iroh_hash: string;
      filename: string | null;
      mime: string | null;
      size: number;
      created_at: number;
    };
    data: string | null;
  };
  try {
    response = (await dispatch("blob_insert_from_path", {
      local_path: picked.path,
      filename: picked.filename,
      mime,
      upload_id: uploadId,
    })) as typeof response;
  } catch (err) {
    if (options?.signal?.aborted) {
      throw new DOMException("upload cancelled", "AbortError");
    }
    throw new Error(formatUploadError(err));
  } finally {
    unlisten?.();
    if (onAbort && options?.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  const meta = response.meta;
  const resolvedMime = meta.mime || mime;
  const domain = classifyDomain(resolvedMime);

  let thumbnailDataUrl: string | null = null;

  if (response.data !== null) {
    const bytes = base64ToBytes(response.data);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;

    // generate a thumbnail data url for images so the widget can paint
    // immediately without a follow-up fetch.
    if (resolvedMime.startsWith("image/")) {
      try {
        const blob = new Blob([new Uint8Array(buffer)], { type: resolvedMime });
        thumbnailDataUrl = await generateThumbnailDataUrl(blob);
      } catch (err) {
        log.debug(TAG, "tauri thumbnail generation failed:", err);
      }
    }
  } else {
    log.debug(
      TAG,
      `blob ${meta.blake3.slice(0, 8)}... (${formatFileSize(meta.size)}) exceeded the mirror-to-browser-storage threshold — staying rust-only`
    );
  }

  return {
    blobId: meta.blake3,
    domain,
    jobId: null,
    sha256: "",
    blake3: meta.blake3,
    size: meta.size,
    mime: resolvedMime,
    existing: false,
    thumbnailDataUrl,
  };
}

// ---------------------------------------------------------------------------
// getThumbnailDataUrl
// ---------------------------------------------------------------------------

/**
 * fetch thumbnail image data for a blob and return it as a data URL.
 * walks the blob parent-child chain to find the best available thumbnail.
 *
 * resolution order:
 * 1. in-memory cache (instant, session-scoped)
 * 2. local grimoire via api_call (blob is on this machine)
 * 3. P2P proxy via connected canvas peers (blob is on a peer's machine)
 *
 * returns null if no thumbnail is available from any source.
 */
export async function getThumbnailDataUrl(
  blobId: string,
  options?: ThumbnailOptions | number
): Promise<string | null> {
  // support legacy call signature: getThumbnailDataUrl(blobId, 200)
  const opts: ThumbnailOptions = typeof options === "number" ? { size: options } : (options ?? {});
  const size = opts.size ?? 200;

  // 1. check in-memory cache
  const key = cacheKey(blobId, size);
  const cached = thumbnailCache.get(key);
  if (cached) {
    return cached;
  }

  // 2. try local grimoire (blob exists on this machine)
  const localResult = await fetchThumbnailLocal(blobId, size);
  if (localResult) {
    thumbnailCache.set(key, localResult);
    return localResult;
  }

  // 3. try P2P fallback — proxy the request through connected canvas peers
  const peers = opts.peers;
  if (peers) {
    const peerResult = await fetchThumbnailFromPeers(blobId, size, peers);
    if (peerResult) {
      thumbnailCache.set(key, peerResult);
      return peerResult;
    }
  }

  return null;
}

/**
 * try fetching thumbnail data from the local grimoire instance.
 * returns a data URL on success, null on failure.
 */
async function fetchThumbnailLocal(blobId: string, size: number): Promise<string | null> {
  if (!isTauriMode()) {
    // browser mode: try generating thumbnail from OPFS data.
    // use resolveBlob to handle the case where the automerge doc's blobId
    // was overwritten by a Tauri peer with a server UUID that doesn't match
    // the browser's sha256-based primary key.
    try {
      const record = await resolveBlob(blobId);
      if (!record) return null;

      // only generate thumbnails for images — video/audio need ffmpeg (Tauri only)
      if (!record.mime.startsWith("image/")) return null;

      const data = await getBlobData(record.blob_id);
      if (!data) return null;

      const blob = new Blob([data], { type: record.mime });
      return await generateThumbnailDataUrl(blob, size);
    } catch {
      return null;
    }
  }

  try {
    const response = (await dispatch("blob_thumbnail", {
      blake3: blobId,
      size,
    })) as { data: string | null; mime?: string } | null;

    if (!response?.data || !response.mime) {
      return null;
    }

    return `data:${response.mime};base64,${response.data}`;
  } catch {
    // not an error — just means the blob isn't available locally
    return null;
  }
}

/**
 * try fetching thumbnail data by proxying the request through canvas peers.
 * iterates connected peers and tries each one until one succeeds.
 * uses the same /api/blobs/thumbnail_data endpoint on the remote side via
 * the skein/1 proxy protocol (`p2p/skein-proxy-client.ts`), so the peer
 * does all the thumbnail chain walking. works for both tauri and browser
 * nodes — both support the underlying `open_bi` primitive the client
 * builds on.
 */
async function fetchThumbnailFromPeers(
  blobId: string,
  size: number,
  peers: Record<string, { nodeId: string }>
): Promise<string | null> {
  const peerIds = await getPeerNodeIds(peers);

  if (peerIds.length === 0) {
    return null;
  }

  try {
    const node = (await getMiddenNode()) as unknown as SkeinProxyNode;

    const fetchFromPeer = async (peerAddr: string): Promise<string> => {
      const result = await withPeerTimeout(
        sendSkeinProxyRequest(node, peerAddr, "POST", "/api/blobs/thumbnail_data", {
          blob_id: blobId,
          size,
        })
      );

      if (result.status !== 200) throw new Error("non-200 status");
      if (!result.body.success || !result.body.data) throw new Error("unsuccessful response");

      const { data, mime } = result.body.data as { data?: string; mime?: string };
      if (!data || !mime) throw new Error("missing data or mime");

      log.debug(
        TAG,
        `fetched thumbnail for ${blobId.slice(0, 8)}... from peer ${peerAddr.slice(0, 16)}...`
      );
      return `data:${mime};base64,${data}`;
    };

    for (let i = 0; i < peerIds.length; i += 2) {
      const batch = peerIds.slice(i, i + 2);
      try {
        return await Promise.any(batch.map((addr) => fetchFromPeer(addr)));
      } catch {
        continue;
      }
    }
  } catch (err) {
    log.debug(TAG, "peer thumbnail fetch setup failed:", err);
  }

  return null;
}

// ---------------------------------------------------------------------------
// generateThumbnailDataUrl
// ---------------------------------------------------------------------------

/**
 * generate a 200px WebP thumbnail data URL from a Blob. delegates to the
 * blob worker so image decode + resize + WebP encode + base64 happen off
 * the main thread. returns null for non-image blobs or on failure.
 */
export async function generateThumbnailDataUrl(blob: Blob, maxSize = 200): Promise<string | null> {
  if (!blob.type.startsWith("image/")) return null;
  try {
    return await generateThumbnailDataUrlWorker(blob, maxSize);
  } catch (err) {
    log.warn(TAG, "thumbnail generation failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// formatFileSize
// ---------------------------------------------------------------------------

/**
 * format a file size in bytes to a human-readable string.
 * e.g. 1024 -> "1.0 KB", 1048576 -> "1.0 MB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  // show decimals only for KB and above
  if (unitIndex === 0) {
    return `${value} ${units[unitIndex]}`;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

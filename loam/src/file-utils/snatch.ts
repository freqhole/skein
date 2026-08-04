/**
 * snatch: download a full blob from a canvas peer via iroh-blobs verified
 * transfer, then ingest it into the local grimoire (creating a media_blobz
 * entry, domain entity, and thumbnail job). also covers snatch-to-disk
 * (browser only, skips OPFS/IndexedDB entirely) and batch snatch (probe
 * once, download many). depends on file-shared.ts, blob-locality.ts
 * (shared locality cache), thumbnail-utils.ts (shared thumbnail cache),
 * and transfer-queue.ts (download slot gating).
 */

import { log } from "@freqhole/reliquary/utils";
import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import { getMiddenNode } from "../p2p/identity";
import { storeBlob } from "../storage/blob-store";
import {
  discardPausedDownload as transferDiscardPausedDownload,
  pauseSnatchDownload as transferPauseSnatchDownload,
  pauseSnatchDownloadByBlake3 as transferPauseSnatchDownloadByBlake3,
  snatchBlob as transferSnatchBlob,
  snatchBlobToDisk as transferSnatchBlobToDisk,
  type BlobCapableNode,
  type SnatchInfo as TransferSnatchInfo,
  type SnatchOptions as TransferSnatchOptions,
} from "@freqhole/reliquary/transfer";
import { ensureBlobOverAlpn } from "@freqhole/reliquary/ensure";
import { isFriend } from "../p2p/friendz-bridge";
import {
  coerceStr,
  withPeerTimeout,
  getPeerNodeIds,
  sniffVideoMimeFromBytes,
  type SnatchBlobInfo,
  type SnatchOptions,
  type FileUploadResult,
  type PeersMap,
} from "./file-shared";
import { localityCache, checkBlobLocality } from "./blob-locality";
import { thumbnailCache, cacheKey } from "./thumbnail-utils";
import { acquireDownloadSlot, releaseDownloadSlot } from "./transfer-queue";
import { formatFileSize } from "../widgets/format";

const TAG = "widgets.snatch";

// ---------------------------------------------------------------------------
// download pause/cancel control
// ---------------------------------------------------------------------------

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
 * browser mode pauses by downloadId when given (delegating to the
 * transport package's own `pauseSnatchDownload`), else falls back to
 * `pauseSnatchDownloadByBlake3` when only a blake3 is known — needed by
 * callers with no downloadId of their own, e.g. cleaning up after a
 * widget that's already been torn down. tauri mode always pauses by
 * blake3 (the native download registry's key) regardless of downloadId —
 * that path has no equivalent in the package (its contract is
 * browser-only) and stays exactly as skein's own tauri IPC call. returns
 * true when an in-flight download was actually flagged.
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
  const node = (await getMiddenNode()) as unknown as BlobCapableNode;
  if (opts.downloadId) {
    return transferPauseSnatchDownload(node, opts.downloadId);
  }
  if (opts.blake3) {
    return transferPauseSnatchDownloadByBlake3(node, opts.blake3);
  }
  return false;
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
  // wrap the caller's signal (if any) in our own controller so this
  // download stays cancellable via cancelPendingTransfer(id) even when
  // the caller never passed a signal of its own — see transfer-queue.ts's
  // controller registry (used by the filez widget's cancel button).
  const controller = new AbortController();
  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      const callerSignal = options.signal;
      callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), {
        once: true,
      });
    }
  }
  const effectiveOptions: SnatchOptions = { ...(options ?? {}), signal: controller.signal };

  // every snatch path (single snatchBlob(), and each item of a
  // snatchBlobBatch()) funnels through here — gating it is enough to cap
  // download concurrency app-wide without touching every call site.
  const slotId = await acquireDownloadSlot(controller.signal, {
    blobId: info.blobId,
    filename: info.filename,
    controller,
  });
  try {
    return await snatchFromBrowserPeerUnqueued(info, peerAddrs, effectiveOptions);
  } finally {
    releaseDownloadSlot(slotId);
  }
}

async function snatchFromBrowserPeerUnqueued(
  info: SnatchBlobInfo,
  peerAddrs: string[],
  options?: SnatchOptions
): Promise<FileUploadResult> {
  if (isTauriMode() && info.blake3) {
    const peerAddr = peerAddrs[0]!;
    const node = (await getMiddenNode()) as any;
    if (typeof node.download_to_native_store === "function") {
      // wire real cancellation: `download_to_native_store` itself has no
      // abort parameter, but rust already exposes `blob_iroh_download_cancel`
      // (via `cancel_native_download`, the same IPC pauseSnatchDownload()
      // uses) — flag it the moment the merged signal aborts instead of
      // waiting for the native call to resolve on its own. mirrors
      // upload.ts's onAbort/blob_insert_cancel wiring.
      let onAbort: (() => void) | null = null;
      if (options?.signal && typeof node.cancel_native_download === "function") {
        const blake3 = info.blake3;
        onAbort = () => {
          log.debug(TAG, `snatch cancel requested for ${blake3.slice(0, 16)}..., flagging native download`);
          void node.cancel_native_download(blake3).catch((err: unknown) => {
            log.debug(TAG, "cancel_native_download dispatch failed (non-fatal):", err);
          });
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      let meta: { size: number; mime: string | null };
      try {
        meta = await withPeerTimeout(
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
      } finally {
        if (onAbort && options?.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      }
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

  // no usable mime from either the widget doc or the sender (common for a
  // file that had no extension to begin with — see sniffVideoMimeFromBytes's
  // doc comment) — sniff the actual bytes so the blob we're about to store
  // locally gets a real mime, and every downstream playback path (OPFS blob
  // URL, tauri asset URL, base64 fallback) just works without needing its
  // own sniffing logic.
  if (!info.mime || info.mime === "application/octet-stream") {
    const sniffed = sniffVideoMimeFromBytes(downloaded.bytes);
    if (sniffed) {
      info = { ...info, mime: sniffed };
    }
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

/**
 * a pausable gate for batch downloads — unlike an `AbortSignal`, pausing
 * doesn't cancel anything; it just blocks the batch loop from starting its
 * *next* blob until resumed (the in-flight download, if any, keeps going).
 * `signal`, if given, unblocks a paused wait with an `AbortError` so a
 * caller can still cancel outright while paused.
 */
export interface PauseGate {
  isPaused(): boolean;
  pause(): void;
  resume(): void;
  waitIfPaused(signal?: AbortSignal): Promise<void>;
}

export function createPauseGate(): PauseGate {
  let paused = false;
  let waiters: Array<() => void> = [];
  return {
    isPaused() {
      return paused;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      const toRelease = waiters;
      waiters = [];
      for (const release of toRelease) release();
    },
    async waitIfPaused(signal?: AbortSignal) {
      if (!paused) return;
      await new Promise<void>((resolve, reject) => {
        const onResume = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          waiters = waiters.filter((w) => w !== onResume);
          reject(new DOMException("cancelled", "AbortError"));
        };
        waiters.push(onResume);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

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
  /** pauses the loop between blobs (see `PauseGate`'s doc comment) — not
   *  passed by callers that don't need pausable batches. */
  pauseGate?: PauseGate;
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
    await options?.pauseGate?.waitIfPaused(options?.signal);

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
      await options?.pauseGate?.waitIfPaused(options?.signal);

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

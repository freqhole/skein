/**
 * thumbnail fetching + generation, with a session-scoped in-memory cache.
 * thumbnails have a P2P fallback: when the blob isn't available locally
 * (e.g. a peer uploaded it), we proxy the thumbnail request through
 * connected canvas peers via the node's proxy_request method (a skein/1
 * stream exchange, real for a tauri node - see tauri-transport.ts - and
 * via `p2p/skein-proxy-client.ts`'s `open_bi`-based sender for a browser
 * node). depends only on file-shared.ts among the new widget files.
 */

import { log } from "@freqhole/reliquary/utils";
import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import { getMiddenNode } from "../p2p/identity";
import { sendSkeinProxyRequest, type SkeinProxyNode } from "../p2p/skein-proxy-client";
import { resolveBlob, getBlobData } from "../storage/blob-store";
import {
  generateThumbnailDataUrl as generateThumbnailDataUrlWorker,
  resizeImageToWebpDataUrl,
} from "@freqhole/reliquary/worker";
import { getPeerNodeIds, withPeerTimeout, type ThumbnailOptions } from "./file-shared";

const TAG = "widgets.thumbnail-utils";

// ---------------------------------------------------------------------------
// thumbnail cache
// ---------------------------------------------------------------------------

/**
 * in-memory cache of fetched thumbnails. keyed by "blobId:size".
 * survives for the session — cleared on page reload.
 * avoids redundant local + P2P fetches when widgets re-render.
 */
export const thumbnailCache = new Map<string, string>();

export function cacheKey(blobId: string, size: number, square?: boolean): string {
  return `${blobId}:${size}:${square ? "sq" : "nat"}`;
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
  const square = opts.square ?? false;
  const mimeOverride = opts.mimeOverride;

  // 1. check in-memory cache
  const key = cacheKey(blobId, size, square);
  const cached = thumbnailCache.get(key);
  if (cached) {
    return cached;
  }

  // 2. try local grimoire (blob exists on this machine)
  const localResult = await fetchThumbnailLocal(blobId, size, square, mimeOverride);
  if (localResult) {
    thumbnailCache.set(key, localResult);
    return localResult;
  }

  // 3. try P2P fallback — proxy the request through connected canvas peers
  const peers = opts.peers;
  if (peers) {
    const peerResult = await fetchThumbnailFromPeers(blobId, size, peers, mimeOverride);
    if (peerResult) {
      thumbnailCache.set(key, peerResult);
      return peerResult;
    }
  }

  return null;
}

/** minimal doc-access interface for `ensureThumbnailPersisted` — satisfied by
 *  a `{ current: () => ctx.doc.current, change: (fn) => ctx.doc.change(fn) }`
 *  wrapper around a mounted `WidgetDoc`, or the same shape around a detached
 *  `DocHandle` (see peedeeeff/render-client.ts's `RenderableDoc` for the
 *  precedent this mirrors). */
export interface ThumbnailPersistDoc {
  current(): { thumbnailDataUrl: string };
  change(fn: (draft: { thumbnailDataUrl: string }) => void): void;
}

/**
 * best-effort: fetch and persist a thumbnail if the doc doesn't already have
 * one. swallows failures (logs only) — this is the "try to fetch a
 * thumbnail, catch, log" pattern that used to be copy-pasted at every
 * upload/snatch/auto-bin call site in file.ts; callers that need to know
 * whether it actually succeeded (e.g. `runDomainIngest`, which treats a
 * missing thumbnail as a real failure) should call `getThumbnailDataUrl`
 * directly instead.
 */
export async function ensureThumbnailPersisted(
  doc: ThumbnailPersistDoc,
  blobId: string,
  opts?: ThumbnailOptions
): Promise<void> {
  if (doc.current().thumbnailDataUrl) return;
  try {
    const dataUrl = await getThumbnailDataUrl(blobId, opts);
    if (dataUrl) {
      doc.change((draft) => {
        draft.thumbnailDataUrl = dataUrl;
      });
    }
  } catch {
    log.debug(TAG, "ensureThumbnailPersisted: thumbnail generation failed for", blobId.slice(0, 12));
  }
}

/**
 * try fetching thumbnail data from the local grimoire instance.
 * returns a data URL on success, null on failure.
 */
async function fetchThumbnailLocal(
  blobId: string,
  size: number,
  square = false,
  mimeOverride?: string
): Promise<string | null> {
  if (!isTauriMode()) {
    // browser mode: try generating thumbnail from OPFS data.
    // use resolveBlob to handle the case where the automerge doc's blobId
    // was overwritten by a Tauri peer with a server UUID that doesn't match
    // the browser's sha256-based primary key.
    try {
      const record = await resolveBlob(blobId);
      if (!record) return null;

      // only generate thumbnails for images — video/audio need ffmpeg (Tauri
      // only), so a mimeOverride can't unlock anything here, only images.
      const mime = mimeOverride ?? record.mime;
      if (!mime.startsWith("image/")) return null;

      const data = await getBlobData(record.blob_id);
      if (!data) return null;

      const blob = new Blob([data], { type: record.mime });
      if (square) {
        // fit (not crop) — document/page thumbnails shouldn't lose content
        // off the edges the way avatar/profile-picture cropping can.
        return await resizeImageToWebpDataUrl(blob, {
          maxWidth: size,
          maxHeight: size,
          quality: 0.75,
          fitSquare: true,
        });
      }
      return await generateThumbnailDataUrl(blob, size);
    } catch (err) {
      log.warn(TAG, `fetchThumbnailLocal (browser) failed for ${blobId.slice(0, 12)}...:`, err);
      return null;
    }
  }

  try {
    const response = (await dispatch("blob_thumbnail", {
      blake3: blobId,
      size,
      fit: square,
      mime_override: mimeOverride,
    })) as { data: string | null; mime?: string } | null;

    if (!response?.data || !response.mime) {
      log.warn(
        TAG,
        `fetchThumbnailLocal (tauri) got an empty response for ${blobId.slice(0, 12)}...`
      );
      return null;
    }

    return `data:${response.mime};base64,${response.data}`;
  } catch (err) {
    // most commonly means the blob isn't available locally, but log it —
    // this used to be swallowed entirely, making "thumbnail never shows up"
    // reports (bin widgets, peedeeeff regenerate button) impossible to
    // diagnose from the console.
    log.warn(TAG, `fetchThumbnailLocal (tauri) failed for ${blobId.slice(0, 12)}...:`, err);
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
  peers: Record<string, { nodeId: string }>,
  mimeOverride?: string
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
          mime_override: mimeOverride,
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

/**
 * platform-aware media URL resolution for audio and video playback.
 *
 * handles the platform differences that affect <audio> and <video> elements:
 *
 * - **browser mode**: creates blob: URLs from OPFS data via skein-blob-store.
 *   works everywhere because blob: is a standard web API.
 *
 * - **macOS Tauri**: uses asset:// protocol URLs via convertFileSrc().
 *   supports range requests for efficient streaming of large files.
 *
 * - **Linux Tauri (WebKitGTK)**: asset:// URLs don't work in <audio>/<video>
 *   elements on WebKitGTK. workaround: fetch the file via asset:// protocol,
 *   then create a blob: object URL from the response. this matches the
 *   pattern used in CharnelLocalTransport.ts for the spume/charnel app.
 *
 * blob URL lifecycle: only one media blob URL is kept at a time per category
 * (audio vs video) to avoid memory bloat. previous URLs are revoked when a
 * new one is created.
 */

import { dispatch as tauriDispatch, isTauriMode } from "../p2p/tauri-transport";
import { log } from "../utils/log";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveBlob, getBlobData } from "../storage/skein-blob-store";
import { getFullBlobDataUrl } from "../widgets/file-utils";

const TAG = "media-urls";

// ---------------------------------------------------------------------------
// platform detection
// ---------------------------------------------------------------------------

/**
 * detect Linux WebKitGTK — the Tauri webview engine on Linux.
 * asset:// URLs don't work for <audio>/<video> elements on this platform.
 * cached at module level since the user agent doesn't change at runtime.
 */
const isLinuxWebKit = typeof navigator !== "undefined" && navigator.userAgent.includes("Linux");

// ---------------------------------------------------------------------------
// blob URL lifecycle management
// ---------------------------------------------------------------------------

/**
 * tracked media blob URLs, one per category.
 * we revoke the previous URL when creating a new one to avoid memory leaks.
 * separate slots for audio and video so playing audio doesn't revoke video.
 */
const mediaBlobSlots: Record<string, { blobId: string; url: string } | null> = {
  audio: null,
  video: null,
};

/**
 * general-purpose media blob URL cache for blob: URLs that should persist
 * for the page session (e.g. browser-mode OPFS blobs). these are NOT
 * revoked on replacement — they're revoked on page unload.
 */
const sessionBlobCache = new Map<string, string>();
let beforeUnloadRegistered = false;

function ensureBeforeUnloadCleanup(): void {
  if (beforeUnloadRegistered) return;
  if (typeof window === "undefined") return;
  window.addEventListener("beforeunload", () => {
    // revoke all session-cached blob URLs
    for (const url of sessionBlobCache.values()) {
      URL.revokeObjectURL(url);
    }
    sessionBlobCache.clear();

    // revoke tracked media slot URLs
    for (const key of Object.keys(mediaBlobSlots)) {
      const slot = mediaBlobSlots[key];
      if (slot) {
        URL.revokeObjectURL(slot.url);
        mediaBlobSlots[key] = null;
      }
    }
  });
  beforeUnloadRegistered = true;
}

// ---------------------------------------------------------------------------
// tauri helpers (lazily imported to avoid bundling in browser builds)
// ---------------------------------------------------------------------------

type PeersMap = Record<string, { nodeId: string }>;

// ---------------------------------------------------------------------------
// internal: resolve blob to a local filesystem path (tauri only)
// ---------------------------------------------------------------------------

interface BlobPathInfo {
  path: string;
  mime?: string;
}

async function getBlobLocalPath(blobId: string): Promise<BlobPathInfo | null> {
  if (!isTauriMode()) return null;

  try {
    const response = (await tauriDispatch("blob_get_path", { blake3: blobId })) as {
      path?: string;
      mime?: string | null;
    } | null;

    if (!response?.path) return null;

    return { path: response.path, mime: response.mime ?? undefined };
  } catch (err) {
    log.debug(TAG, "getBlobLocalPath failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// internal: create a blob: URL by fetching via asset:// protocol
// ---------------------------------------------------------------------------

/**
 * fetch a file via the tauri asset:// protocol and return a blob: object URL.
 * used on Linux WebKitGTK where asset:// can't be used directly in media elements.
 *
 * the `category` parameter controls which slot is used for lifecycle management:
 * creating a new blob URL in a slot revokes the previous one in that slot.
 */
async function createMediaBlobUrl(
  blobId: string,
  localPath: string,
  mime: string | undefined,
  category: "audio" | "video"
): Promise<string> {
  // revoke previous URL in this category to free memory
  const prev = mediaBlobSlots[category];
  if (prev) {
    URL.revokeObjectURL(prev.url);
    mediaBlobSlots[category] = null;
  }

  const assetUrl = convertFileSrc(localPath);
  const resp = await fetch(assetUrl);
  const arrayBuffer = await resp.arrayBuffer();

  // use the known mime type, fall back to response content-type, then a sensible default
  const blobMime =
    mime ?? resp.headers.get("content-type") ?? (category === "audio" ? "audio/mpeg" : "video/mp4");

  const blob = new Blob([arrayBuffer], { type: blobMime });
  const objectUrl = URL.createObjectURL(blob);

  mediaBlobSlots[category] = { blobId, url: objectUrl };
  return objectUrl;
}

// ---------------------------------------------------------------------------
// internal: get blob URL from OPFS (browser mode)
// ---------------------------------------------------------------------------

async function getBlobUrlFromOpfs(blobId: string, blake3?: string): Promise<string | null> {
  // check session cache first
  const cached = sessionBlobCache.get(blobId);
  if (cached) return cached;

  try {
    // use resolveBlob (which tries blob_id, sha256, and blake3 indexes)
    // instead of getBlobObjectURL (which only passes blobId, missing blake3)
    const record = await resolveBlob(blobId, blake3);
    if (!record) {
      log.debug(TAG, "getBlobUrlFromOpfs: resolveBlob found nothing for", blobId);
      return null;
    }

    const data = await getBlobData(record.blob_id);
    if (!data) {
      log.debug(TAG, "getBlobUrlFromOpfs: OPFS file missing for", record.blob_id);
      return null;
    }

    const mime = record.mime ?? "application/octet-stream";
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);

    ensureBeforeUnloadCleanup();
    sessionBlobCache.set(blobId, url);
    return url;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// internal: get blob as data URL from tauri (base64 fallback)
// ---------------------------------------------------------------------------

async function getBlobDataUrl(blobId: string): Promise<string | null> {
  if (!isTauriMode()) return null;

  try {
    const response = (await tauriDispatch("blob_get", { blake3: blobId })) as {
      meta?: { mime?: string | null };
      data?: string;
    } | null;

    if (!response?.data) return null;
    const mime = response.meta?.mime ?? "application/octet-stream";
    return `data:${mime};base64,${response.data}`;
  } catch (err) {
    log.debug(TAG, "getBlobDataUrl failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export interface MediaUrlOptions {
  /** hint for the media category — controls blob URL slot management */
  category?: "audio" | "video";
  /** connected canvas peers for P2P fallback */
  peers?: PeersMap;
  /** known MIME type (avoids guessing) */
  mime?: string;
  /** blake3 content hash — used for OPFS fallback resolution in browser mode
   *  when the blobId is a server UUID that doesn't match the browser's
   *  sha256-based primary key */
  blake3?: string;
}

/**
 * get a playable URL for a media blob.
 *
 * tries sources in priority order:
 * 1. tauri asset:// URL (macOS) or blob: from asset:// fetch (Linux WebKitGTK)
 * 2. OPFS blob: URL (browser mode)
 * 3. base64 data: URL from tauri IPC (tauri fallback)
 * 4. P2P fetch from canvas peers (either mode)
 *
 * returns null if the blob can't be resolved from any source.
 */
export async function getMediaPlaybackUrl(
  blobId: string,
  options: MediaUrlOptions = {}
): Promise<string | null> {
  const { category = "audio", mime, blake3 } = options;

  log.debug(
    TAG,
    "getMediaPlaybackUrl:",
    blobId,
    "category:",
    category,
    "isTauri:",
    isTauriMode()
  );

  ensureBeforeUnloadCleanup();

  // ---- tauri mode: prefer local filesystem path ----

  if (isTauriMode()) {
    // on skein-tauri, blob ids ARE blake3 hashes — no separate lookup needed.
    // try `blob_get_path` first (gives us a real filesystem path we can hand
    // to asset:// for native streaming with range requests). if the blobId
    // isn't a known blake3 (e.g. it's a browser-peer SHA256 from a remote
    // canvas), `blob_get_path` returns null and we fall through to the
    // base64 IPC fallback (which also won't find it, leaving P2P below).
    const lookupId = blake3 || blobId;
    log.debug(TAG, "getMediaPlaybackUrl: trying blob_get_path for", lookupId);
    const pathInfo = await getBlobLocalPath(lookupId);
    log.debug(TAG, "getMediaPlaybackUrl: blob_get_path returned:", pathInfo);

    if (pathInfo) {
      // on Linux WebKitGTK, asset:// doesn't work for media elements —
      // fetch the file via asset:// and create a blob: URL instead
      if (isLinuxWebKit) {
        try {
          log.debug(TAG, "getMediaPlaybackUrl: linux — creating blob URL from asset...");
          const url = await createMediaBlobUrl(
            blobId,
            pathInfo.path,
            mime ?? pathInfo.mime,
            category
          );
          log.debug(TAG, "getMediaPlaybackUrl: linux blob URL created:", url.slice(0, 60));
          return url;
        } catch (err) {
          log.warn(TAG, "linux blob URL fallback failed:", err);
          // fall through to other approaches
        }
      } else {
        // macOS / Windows: asset:// URLs work natively
        try {
          const assetUrl = convertFileSrc(pathInfo.path);
          log.debug(TAG, "getMediaPlaybackUrl: asset URL:", assetUrl.slice(0, 80));
          return assetUrl;
        } catch (err) {
          log.warn(TAG, "convertFileSrc failed:", err);
          // fall through
        }
      }
    }

    // tauri fallback: base64 data URL from IPC
    log.debug(TAG, "getMediaPlaybackUrl: trying base64 data URL fallback for", lookupId);
    const dataUrl = await getBlobDataUrl(lookupId);
    log.debug(
      TAG,
      "getMediaPlaybackUrl: getBlobDataUrl returned:",
      dataUrl ? "data URL" : null
    );
    if (dataUrl) return dataUrl;
  }

  // ---- browser mode: OPFS blob URL ----

  if (!isTauriMode()) {
    log.debug(
      TAG,
      "getMediaPlaybackUrl: browser — trying OPFS...",
      "blake3:",
      blake3?.slice(0, 12)
    );
    const opfsUrl = await getBlobUrlFromOpfs(blobId, blake3);
    log.debug(
      TAG,
      "getMediaPlaybackUrl: OPFS returned:",
      opfsUrl ? opfsUrl.slice(0, 60) : null
    );
    if (opfsUrl) return opfsUrl;
  }

  // ---- P2P fallback: fetch from canvas peers ----

  if (options.peers) {
    try {
      log.debug(TAG, "getMediaPlaybackUrl: trying P2P fallback...");
      const peerUrl = await getFullBlobDataUrl(blobId, options.peers);
      log.debug(TAG, "getMediaPlaybackUrl: P2P returned:", peerUrl ? "got URL" : null);
      if (peerUrl) return peerUrl;
    } catch (err) {
      log.warn(TAG, "P2P fallback failed:", err);
    }
  }

  log.debug(TAG, "getMediaPlaybackUrl: all paths failed for", blobId);
  return null;
}

/**
 * revoke a previously created media blob URL and clear its slot.
 * safe to call even if no URL exists for the given category.
 */
export function revokeMediaUrl(category: "audio" | "video"): void {
  const slot = mediaBlobSlots[category];
  if (slot) {
    URL.revokeObjectURL(slot.url);
    mediaBlobSlots[category] = null;
  }
}

/**
 * revoke all tracked media blob URLs (both audio and video slots).
 * does NOT clear the session cache — those are cleaned up on page unload.
 */
export function revokeAllMediaUrls(): void {
  revokeMediaUrl("audio");
  revokeMediaUrl("video");
}

/**
 * check whether we're on Linux WebKitGTK (where asset:// media is broken).
 * exposed for testing and conditional UI logic.
 */
export function isLinuxWebKitGTK(): boolean {
  return isLinuxWebKit;
}

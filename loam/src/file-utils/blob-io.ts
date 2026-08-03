/**
 * blob i/o for full data (previews, disk save/reveal, asset:// URLs).
 * depends on file-shared.ts (getPeerNodeIds, withPeerTimeout, PeersMap)
 * among the new widget files.
 */

import { log } from "@freqhole/reliquary/utils";
import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import { getMiddenNode } from "../p2p/identity";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getBlobObjectURL, resolveBlob, getBlobData } from "../storage/blob-store";
import { getPeerNodeIds, withPeerTimeout, type PeersMap } from "./file-shared";

const TAG = "widgets.blob-io";

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
  // download paths (see snatch.ts's download_to_native_store branch), not
  // this preview-data-URL path.
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
 * convert a local filesystem path to a Tauri asset:// URL.
 * used for streaming video/audio from local storage without loading
 * the entire file into memory.
 */
export async function convertToAssetUrl(localPath: string): Promise<string> {
  return convertFileSrc(localPath);
}

/**
 * blob locality checks — whether a blob exists in the local grimoire
 * database (used to decide "snatch" vs "save to disk" UI), plus freeing a
 * local copy back up. depends on file-shared.ts (types) and
 * thumbnail-utils.ts (shared thumbnail cache, needed by freeUpLocalBlobCopy).
 */

import { log } from "@freqhole/reliquary/utils";
import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import { hasBlobBytes, getBlobFile, resolveBlob, deleteBlob } from "../storage/blob-store";
import type { BlobLocalityInfo } from "./file-shared";
import { thumbnailCache, cacheKey } from "./thumbnail-utils";

const TAG = "widgets.blob-locality";

/** session-scoped locality cache — avoids repeated IDB lookups for blobs we already know are local */
export const localityCache = new Map<string, BlobLocalityInfo>();

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

/**
 * get a blob's actual on-disk byte size — not the doc's `size` field (the
 * originally-uploaded size, which stays whatever it was even if the local
 * copy is later corrupted/truncated) and not the locality metadata's
 * `size` (browser: the db row's recorded size; can drift from the real
 * file the same way). used to flag a 0-byte local copy left behind by an
 * interrupted snatch — `checkBlobLocality`'s bytes-presence check only
 * catches bytes that are entirely MISSING, not a file that exists but is
 * empty. returns null when there's no local copy at all.
 */
export async function getLocalBlobByteSize(
  blobId: string,
  blake3?: string | null
): Promise<number | null> {
  if (isTauriMode()) {
    try {
      const meta = (await dispatch("blob_get_path", {
        blake3: blake3 || blobId,
      })) as { path?: string; size?: number | null } | null;
      if (!meta?.path) return null;
      return meta.size ?? null;
    } catch {
      return null;
    }
  }
  try {
    const record = await resolveBlob(blobId, blake3 ?? undefined);
    if (!record) return null;
    const file = await getBlobFile(record.blob_id);
    return file ? file.size : null;
  } catch {
    return null;
  }
}

/**
 * delete the LOCAL copy of a blob (browser: OPFS bytes + IndexedDB record +
 * session caches; tauri: managed blobz file + row via `blob_purge_local`) to
 * reclaim disk space, without touching the widget doc — the file widget
 * stays on the canvas and the blob becomes snatchable again from whoever
 * still has it (e.g. a hub peer). also useful in tauri to purge a
 * corrupt/truncated local copy (e.g. a 0-byte file from an interrupted
 * snatch) and retry from scratch.
 *
 * records can be keyed by either the blake3 or a legacy sha256 blob id, so
 * both ids are cleaned when known (browser mode only — tauri's blobz store
 * is keyed purely by blake3).
 */
export async function freeUpLocalBlobCopy(
  blobId: string,
  blake3?: string | null
): Promise<void> {
  if (isTauriMode()) {
    const hash = blake3 || blobId;
    await dispatch("blob_purge_local", { blake3: hash });
    log.debug(TAG, `freed local copy of blob ${hash.slice(0, 12)}...`);
    return;
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

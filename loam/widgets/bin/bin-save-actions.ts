// shared "save to disk" / "reveal in finder" blob action — used by both
// the hover-only action button (bin-card-builders.ts) and the media
// control bar's own save button (bin-media.ts). split into its own module
// to avoid a circular import between those two files.

import { log } from "@freqhole/reliquary/utils";
import { checkBlobLocality } from "../../src/file-utils/blob-locality";
import { revealBlobInFinder, saveBlobToDisk } from "../../src/file-utils/blob-io";
import { snatchBlob } from "../../src/file-utils/snatch";
import { isTauriMode } from "../../src/p2p/tauri-transport";

/** info needed to save/reveal a blob */
export interface ActionButtonInfo {
  blobId?: string | null;
  filename?: string | null;
  mime?: string | null;
  blake3?: string | null;
  size?: number | null;
  domain?: string | null;
  snatchedBy?: string[] | null;
}

/**
 * save (browser) or reveal-in-finder (tauri) a blob, snatching it from a
 * peer first if it isn't local yet.
 */
export async function performSaveOrReveal(
  info: ActionButtonInfo,
  getPeers: (() => Record<string, { nodeId: string }> | undefined) | null
): Promise<void> {
  const blobId = String(info.blobId ?? "");
  if (!blobId) return;
  const filename = String(info.filename ?? "file");

  try {
    // ensure the blob is local before saving/revealing
    const localityInfo = await checkBlobLocality(blobId, info.blake3 ?? undefined);
    if (localityInfo.locality !== "local") {
      const peers = getPeers?.() ?? {};
      await snatchBlob(
        {
          blobId,
          filename,
          mime: String(info.mime ?? ""),
          size: info.size ?? 0,
          blake3: String(info.blake3 ?? ""),
          domain: String(info.domain ?? ""),
        },
        peers as any
      );
    }

    if (isTauriMode()) {
      await revealBlobInFinder(blobId);
    } else {
      await saveBlobToDisk(blobId, filename);
    }
  } catch (err) {
    log.warn("bin", "save/reveal failed:", err);
  }
}

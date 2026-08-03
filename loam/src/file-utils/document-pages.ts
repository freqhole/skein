/**
 * document pages — fetch the list of rendered page image blobs for a
 * document (PDF etc). in tauri mode, renders locally via the
 * `pdf_render_pages` dispatch. in browser mode, delegates rendering to a
 * connected canvas peer over the skein/1 proxy protocol.
 */

import { log } from "@freqhole/reliquary/utils";
import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import { getMiddenNode } from "../p2p/identity";
import {
  requestDocumentPagesFromPeers,
  type SkeinProxyNode,
} from "../p2p/skein-proxy-client";

const TAG = "widgets.document-pages";

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

/** session cache — document rendering is expensive, and the peedeeeff
 *  widget polls getDocumentPages repeatedly. keyed by source blake3. */
const pdfPagesCache = new Map<string, DocumentPageInfo[]>();

export async function getDocumentPages(
  blobId: string,
  peerNodeIds: string[] = []
): Promise<DocumentPageInfo[]> {
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

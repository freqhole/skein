// ---------------------------------------------------------------------------
// peedeeeff/render-client.ts — shared "ask a peer to render this document's
// pages" logic, usable both from the mounted widget (index.ts) AND from
// code paths that create a peedeeeff doc WITHOUT ever mounting the widget
// (e.g. multi-file auto-bin creation in file.ts / bin/index.ts — bins only
// ever call a child factory's `getCompactInfo()`, they never mount the
// full widget lifecycle, so nothing else will kick off rendering for a
// peedeeeff child unless we do it explicitly at creation time).
//
// operates on a minimal doc-access interface (`current`/`change`) rather
// than the mounted widget's `WidgetDoc`, so it works equally well against
// `ctx.doc` (mounted widget) and a raw `DocHandle` (detached child doc).
// ---------------------------------------------------------------------------

import { log } from "@freqhole/reliquary/utils";
import type { CanvasStore } from "../../src/canvas/canvas-store";
import { getDocumentPages } from "../../src/file-utils/document-pages";
import { getThumbnailDataUrl } from "../../src/file-utils/thumbnail-utils";
import { PROCESSING_CLAIM_STALE_MS, type PeedeeeffState } from "./types";

const TAG = "peedeeeff.render-client";

/** minimal doc-access interface — satisfied by both `WidgetDoc<S>`
 *  (mounted widget) and a plain automerge `DocHandle` wrapped as
 *  `{ current: () => handle.doc(), change: (fn) => handle.change(fn) }`. */
export interface RenderableDoc {
  current(): PeedeeeffState;
  change(fn: (draft: PeedeeeffDraft) => void): void;
}

/** the subset of `PeedeeeffState` fields this module ever writes. */
export interface PeedeeeffDraft {
  pageBlobIds: string[];
  pageBlake3s: string[];
  pageCount: number;
  currentPage: number;
  thumbnailDataUrl: string;
  processingClaimedBy: string;
  processingClaimedAt: number;
}

/** candidate peers to ask for rendering, hub nodes first. */
export function getRenderPeerNodeIds(canvasStore: CanvasStore | undefined): string[] {
  if (!canvasStore) return [];
  const localId = canvasStore.localNodeId;
  const ids = Object.keys(canvasStore.peers()).filter((id) => id !== localId);
  ids.sort((a, b) => Number(canvasStore.isHubNode(b)) - Number(canvasStore.isHubNode(a)));
  return ids;
}

/** re-derive the square thumbnail from the doc's already-rendered first
 *  page. used by peedeeeff's own "regenerate thumbnail" button and by
 *  bins that gain a peedeeeff child with no thumbnail yet (e.g. one
 *  dragged in from the canvas rather than created fresh in the bin).
 *  pass `canvasStore` so the first page's bytes can be fetched from a
 *  connected peer when they're not already resident on this device (e.g.
 *  a different peer rendered the pages and this one never fetched them) —
 *  without it, this can only ever succeed on the peer that did the
 *  rendering. */
export async function regenerateThumbnail(
  doc: RenderableDoc,
  canvasStore?: CanvasStore
): Promise<boolean> {
  const firstPageBlobId = doc.current().pageBlobIds[0];
  if (!firstPageBlobId) {
    log.warn(TAG, "regenerateThumbnail: doc has no pageBlobIds yet, nothing to derive from");
    return false;
  }
  const dataUrl = await getThumbnailDataUrl(firstPageBlobId, {
    size: 200,
    square: true,
    peers: canvasStore?.peers(),
  });
  if (!dataUrl) {
    log.warn(
      TAG,
      `regenerateThumbnail: getThumbnailDataUrl returned nothing for page blob ${firstPageBlobId.slice(0, 12)}...`
    );
    return false;
  }
  doc.change((draft) => {
    draft.thumbnailDataUrl = dataUrl;
  });
  return true;
}

/** claim the processing job for this peer, unless someone else already
 *  holds a fresh (non-stale) claim. */
export function tryClaimProcessing(doc: RenderableDoc, canvasStore: CanvasStore | undefined): boolean {
  const state = doc.current();
  const localId = canvasStore?.localNodeId ?? "";
  const now = Date.now();
  const claimedBy = state.processingClaimedBy;
  const claimAge = now - (state.processingClaimedAt || 0);

  if (claimedBy && claimedBy !== localId && claimAge < PROCESSING_CLAIM_STALE_MS) {
    return false;
  }

  doc.change((draft) => {
    draft.processingClaimedBy = localId;
    draft.processingClaimedAt = now;
  });
  return true;
}

/** clear the claim so another peer can retry immediately instead of
 *  waiting out the staleness timeout. */
export function releaseProcessingClaim(doc: RenderableDoc, canvasStore: CanvasStore | undefined): void {
  const localId = canvasStore?.localNodeId ?? "";
  if (doc.current().processingClaimedBy !== localId) return;
  doc.change((draft) => {
    draft.processingClaimedBy = "";
    draft.processingClaimedAt = 0;
  });
}

/**
 * poll (tauri: local render dispatch; browser: hub/peer proxy request)
 * until pages are ready, populating the doc as soon as they are.
 * returns true on success, false on timeout/no-peer-available.
 */
export async function renderAndPopulatePages(
  doc: RenderableDoc,
  blobId: string,
  canvasStore: CanvasStore | undefined,
  options: { isDestroyed?: () => boolean; onTick?: (attempt: number) => void } = {}
): Promise<boolean> {
  const peerNodeIds = getRenderPeerNodeIds(canvasStore);
  const maxAttempts = 60;
  const pollIntervalMs = 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.isDestroyed?.()) return false;
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const pages = await getDocumentPages(blobId, peerNodeIds);
    if (pages.length > 0) {
      const blobIds = pages.map((p) => p.page_blob_id);
      const blake3s = pages.map((p) => p.blake3 || "");
      const totalPagesCount = pages[0]?.total_pages ?? pages.length;

      // backfill a bin-visible thumbnail from the first rendered page if one
      // isn't already set. callers may have already tried to generate one
      // from the raw (unrendered) source blob before calling this function,
      // but that only ever succeeds for image mimes (browser mode has no
      // pdf rasterizer) - the rendered page is always an image, so this is
      // the one path guaranteed to work for every source format, in both
      // browser and tauri mode, regardless of who created this doc. bins
      // never mount a child's full widget lifecycle, so this is the only
      // chance to persist one for bins to display later.
      let thumbnailDataUrl: string | undefined;
      if (!doc.current().thumbnailDataUrl) {
        try {
          thumbnailDataUrl =
            (await getThumbnailDataUrl(blobIds[0], {
              size: 200,
              square: true,
              peers: canvasStore?.peers(),
            })) ?? undefined;
        } catch {
          // best-effort only
        }
      }

      doc.change((draft) => {
        draft.pageBlobIds = blobIds;
        draft.pageBlake3s = blake3s;
        draft.pageCount = totalPagesCount;
        draft.currentPage = 0;
        if (thumbnailDataUrl) {
          draft.thumbnailDataUrl = thumbnailDataUrl;
        }
      });
      return true;
    }

    options.onTick?.(attempt);
  }

  return false;
}

/**
 * fire-and-forget: claim + render + release, for callers that don't have
 * (and don't need) a mounted widget UI to update — e.g. a peedeeeff child
 * created as part of a multi-file auto-bin. safe to call even if another
 * peer already claimed the job (it just no-ops in that case, relying on
 * automerge sync to eventually deliver the claimant's result).
 */
export async function kickOffDocumentProcessing(
  doc: RenderableDoc,
  blobId: string,
  canvasStore: CanvasStore | undefined
): Promise<void> {
  if (!tryClaimProcessing(doc, canvasStore)) return;

  try {
    const ok = await renderAndPopulatePages(doc, blobId, canvasStore);
    if (!ok) {
      log.debug(TAG, `kickOffDocumentProcessing: no peer rendered ${blobId.slice(0, 12)}... in time`);
    }
  } catch (err) {
    log.warn(TAG, "kickOffDocumentProcessing failed:", err);
  } finally {
    releaseProcessingClaim(doc, canvasStore);
  }
}

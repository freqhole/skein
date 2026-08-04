/**
 * blob <-> canvas reference index — tracks which canvas documents currently
 * have a widget referencing a given blob, so a widget-delete cleanup can
 * cheaply tell whether purging a blob's local bytes would break another
 * widget still using it, without iterating every canvas. keyed by blake3
 * (the canonical id in both storage backends - browser records are keyed
 * `blob_id = blake3`, see reliquary/ts's `store.ts`; the sqlite side's
 * `blobz_canvas_refs` table is keyed by `blake3` directly). falls back to
 * `blobId` when no blake3 is known yet (e.g. mid-upload), matching
 * `checkBlobLocality`'s own resolution order.
 */

import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import {
  addCanvasRef,
  removeCanvasRef,
  getCanvasRefs,
  removeAllCanvasRefsForCanvas,
} from "../storage/blob-store";

/** record that `canvasDocId` has a widget referencing this blob. */
export async function addBlobCanvasRef(
  blobId: string,
  blake3: string | null | undefined,
  canvasDocId: string
): Promise<void> {
  const hash = blake3 || blobId;
  if (!hash || !canvasDocId) return;
  if (isTauriMode()) {
    await dispatch("blob_add_canvas_ref", { blake3: hash, canvas_doc_id: canvasDocId });
    return;
  }
  await addCanvasRef(hash, canvasDocId);
}

/** remove a single blob/canvas reference (widget deleted or reassigned). */
export async function removeBlobCanvasRef(
  blobId: string,
  blake3: string | null | undefined,
  canvasDocId: string
): Promise<void> {
  const hash = blake3 || blobId;
  if (!hash || !canvasDocId) return;
  if (isTauriMode()) {
    await dispatch("blob_remove_canvas_ref", { blake3: hash, canvas_doc_id: canvasDocId });
    return;
  }
  await removeCanvasRef(hash, canvasDocId);
}

/** every canvas doc id currently referencing this blob. */
export async function getBlobCanvasRefs(
  blobId: string,
  blake3: string | null | undefined
): Promise<string[]> {
  const hash = blake3 || blobId;
  if (!hash) return [];
  if (isTauriMode()) {
    const result = (await dispatch("blob_canvas_refs", { blake3: hash })) as {
      canvasDocIds?: string[];
    };
    return result?.canvasDocIds ?? [];
  }
  return getCanvasRefs(hash);
}

/** remove every ref row for a canvas (the whole canvas was deleted). */
export async function removeAllBlobCanvasRefs(canvasDocId: string): Promise<void> {
  if (!canvasDocId) return;
  if (isTauriMode()) {
    await dispatch("blob_remove_all_canvas_refs", { canvas_doc_id: canvasDocId });
    return;
  }
  await removeAllCanvasRefsForCanvas(canvasDocId);
}

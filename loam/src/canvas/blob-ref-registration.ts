/**
 * best-effort blob<->canvas reference registration for a widget's cloned
 * state — shared by `widget-clipboard.ts` (paste) and `canvas-duplicate.ts`
 * (deep canvas duplication), which both need the exact same "does this
 * widget's state carry a blob ref, and if so record it against the NEW
 * canvas it just landed on" step. split into its own module rather than
 * having one of those two import it from the other, since both already
 * need to import EACH OTHER for their own reasons (widget-clipboard's
 * canvas-card paste special-case needs `duplicateCanvasDeep`) — a plain
 * two-module cycle for one small shared helper isn't worth the risk.
 */

import { log } from "@freqhole/reliquary/utils";
import { addBlobCanvasRef } from "../file-utils/blob-canvas-refs";

const TAG = "canvas.blob-ref-registration";

/** known blob-id/blake3 field-name pairs across widget schemas — best
 *  effort, not exhaustive (e.g. `image`'s `url`-embedded blob refs aren't
 *  covered) — see `registerBlobRefs()`. */
export const BLOB_FIELD_PAIRS: Array<[string, string]> = [
  ["blobId", "blake3"],
  ["videoBlobId", "videoBlake3"],
];

/** best-effort blob-canvas-ref registration for a pasted/duplicated
 *  widget's state — see `BLOB_FIELD_PAIRS`'s doc comment for coverage
 *  caveats. */
export function registerBlobRefs(state: Record<string, unknown> | null, canvasDocId: string): void {
  if (!state) return;
  for (const [blobKey, blake3Key] of BLOB_FIELD_PAIRS) {
    const blobId = state[blobKey];
    if (typeof blobId !== "string" || !blobId) continue;
    const blake3 = typeof state[blake3Key] === "string" ? (state[blake3Key] as string) : "";
    addBlobCanvasRef(blobId, blake3, canvasDocId).catch((err) => {
      log.debug(TAG, `addBlobCanvasRef failed (non-fatal) for ${blobId.slice(0, 12)}...:`, err);
    });
  }
}

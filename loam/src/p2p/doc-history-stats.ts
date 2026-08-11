// ---------------------------------------------------------------------------
// one-shot diagnostic logging of an automerge doc's op-log size — used to
// spot a doc quietly accumulating unbounded history the way social/messagez
// did before they surfaced as a real boot-stall/memory-bloat bug (see
// docs/lingering-fixes-2026-08-plan.md). purely observational: logs and
// returns, never mutates or acts on the numbers itself.
// ---------------------------------------------------------------------------

import type { DocHandle } from "@automerge/automerge-repo";
import { next as A } from "@automerge/automerge/slim";
import { log } from "@freqhole/reliquary/utils";

const TAG = "doc-history-stats";

/** logs `label`'s numChanges/numOps (and byte size of a full save) if the
 *  handle is ready and has content — a no-op otherwise.
 *
 *  also logs the single largest individual change's op count — a doc with
 *  an unusually high numOps/numChanges ratio (like narthex — see
 *  docs/narthex-doc-history-plan.md) usually has a small number of huge
 *  outlier changes rather than uniformly large ones, and this pinpoints
 *  them without a separate one-off script. */
export function logDocHistoryStats(label: string, handle: DocHandle<any> | null | undefined): void {
  if (!handle?.isReady()) return;
  try {
    const doc = handle.doc();
    if (!doc) return;
    const stats = A.stats(doc);
    const bytes = A.save(doc).byteLength;
    let maxChangeOps = 0;
    try {
      for (const change of A.getAllChanges(doc)) {
        const ops = A.decodeChange(change).ops.length;
        if (ops > maxChangeOps) maxChangeOps = ops;
      }
    } catch {
      // best-effort — not worth failing the whole stats log over
    }
    log.debug(
      TAG,
      `${label} (${handle.documentId}) — numChanges: ${stats.numChanges}, numOps: ${stats.numOps}, ` +
        `maxChangeOps: ${maxChangeOps}, savedBytes: ${bytes}`
    );
  } catch (err) {
    log.warn(TAG, `failed to compute stats for ${label}:`, err);
  }
}

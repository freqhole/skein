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
 *  handle is ready and has content — a no-op otherwise. */
export function logDocHistoryStats(label: string, handle: DocHandle<any> | null | undefined): void {
  if (!handle?.isReady()) return;
  try {
    const doc = handle.doc();
    if (!doc) return;
    const stats = A.stats(doc);
    const bytes = A.save(doc).byteLength;
    log.debug(
      TAG,
      `${label} (${handle.documentId}) — numChanges: ${stats.numChanges}, numOps: ${stats.numOps}, savedBytes: ${bytes}`
    );
  } catch (err) {
    log.warn(TAG, `failed to compute stats for ${label}:`, err);
  }
}

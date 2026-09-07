/**
 * one-shot console diagnostic for "which doc on this canvas has the bloated
 * automerge history" — meant to be run ad hoc from browser devtools against
 * the currently open canvas, bundled into `window.__skeinDiagnose()` (see
 * `standalone/boot.ts`, right alongside `diagnoseAnimaniacDrops()`).
 *
 * computes the same numChanges/numOps/maxChangeOps/savedBytes stats
 * `doc-history-stats.ts`'s `logDocHistoryStats()` already logs once at boot
 * for the canvas doc itself, but for EVERY widget's own doc too, sorted by
 * numOps descending — so a single call pinpoints the worst offender doc on
 * a canvas suspected of having runaway op-log growth (e.g. from a widget
 * repeatedly rewriting a whole array instead of mutating in place) without
 * needing to guess which widget's docId to check by hand.
 */

import type { DocumentId } from "@automerge/automerge-repo";
import type { CanvasStore } from "../canvas/canvas-store";
import { resolveDocReadyCached } from "../p2p/doc-ready";
import { computeDocHistoryStats } from "../p2p/doc-history-stats";

export interface DocHistoryReportEntry {
  label: string;
  widgetId: string | null;
  docId: string;
  numChanges: number;
  numOps: number;
  /** `null` for anything below the bloat threshold below \u2014 see this
   *  function's own doc comment for why the expensive numbers aren't
   *  computed for every doc unconditionally. */
  maxChangeOps: number | null;
  savedBytes: number | null;
}

/** docs above this numOps get a second, expensive pass (A.save()/decode
 *  loop for maxChangeOps/savedBytes) \u2014 matches widget-manager.ts's own
 *  mount-time bloat threshold. keeps this scan fast for the common case
 *  (most widgets on a canvas are small) while still surfacing the deep
 *  numbers for whichever doc(s) actually need investigating, without
 *  paying the expensive decode loop for all of them unconditionally \u2014
 *  confirmed via a real freeze capture to cost 5+ SECONDS for a single
 *  already-bloated doc, with no upper bound for a worse one; running that
 *  for every widget on a canvas in one synchronous scan would make this
 *  diagnostic itself freeze the tab, exactly the failure mode it exists
 *  to investigate. */
const EXPENSIVE_STATS_THRESHOLD_OPS = 20_000;

/** the canvas doc itself, plus every widget's own doc on it (best-effort —
 *  a widget doc that can't be reached this session is just skipped), sorted
 *  worst-numOps-first. */
export async function diagnoseDocHistory(store: CanvasStore): Promise<DocHistoryReportEntry[]> {
  const entries: DocHistoryReportEntry[] = [];

  const canvasStats = computeDocHistoryStats(store.handle);
  if (canvasStats) entries.push({ label: "canvas", widgetId: null, docId: store.handle.documentId, ...canvasStats });

  for (const widget of store.allWidgets()) {
    if (!widget.docId) continue;
    const handle = await resolveDocReadyCached(store.repo, widget.docId as DocumentId, { context: "diagnose-doc-history" });
    const stats = computeDocHistoryStats(handle);
    if (stats) entries.push({ label: widget.type, widgetId: widget.id, docId: widget.docId, ...stats });
  }

  // second, expensive pass — only for whatever already looks bloated from
  // the cheap numbers above.
  for (const entry of entries) {
    if (entry.numOps <= EXPENSIVE_STATS_THRESHOLD_OPS) continue;
    const handle =
      entry.widgetId === null
        ? store.handle
        : await resolveDocReadyCached(store.repo, entry.docId as DocumentId, { context: "diagnose-doc-history" });
    const deep = computeDocHistoryStats(handle, { includeExpensive: true });
    if (deep) {
      entry.maxChangeOps = deep.maxChangeOps;
      entry.savedBytes = deep.savedBytes;
    }
  }

  entries.sort((a, b) => b.numOps - a.numOps);
  return entries;
}


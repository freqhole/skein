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

export interface DocHistoryStats {
  numChanges: number;
  numOps: number;
  /** the single largest individual change's op count — see this module's
   *  own doc comment for why that's the more telling number. `null` unless
   *  `includeExpensive` was passed to `computeDocHistoryStats()` — computing
   *  this decodes EVERY change in the doc, which is itself a multi-second-
   *  plus main-thread block for a sufficiently bloated doc (confirmed while
   *  investigating the animaniac canvas-freeze bug — this diagnostic was
   *  briefly a bigger stall than the thing it was measuring), so it must
   *  never run as part of an automatic/every-mount check. */
  maxChangeOps: number | null;
  /** `null` unless `includeExpensive` was passed — `A.save()` is a full
   *  doc re-serialize, cheap for a small doc but not free for a bloated
   *  one, so it's opt-in for the same reason as `maxChangeOps`. */
  savedBytes: number | null;
}

/** below this many changes, the doc doesn't have enough ACCUMULATED EDIT
 *  HISTORY for compaction to meaningfully help — the "compact this doc"
 *  property-tray button is only offered once a doc crosses this, so users
 *  aren't tempted to compact docs that won't actually shrink.
 *
 *  deliberately based on `numChanges`, NOT `numOps` (an earlier version of
 *  this gate used a raw op-count threshold) — confirmed live that a doc
 *  can sit at `numChanges: 1` (already fresh, zero compactable history)
 *  while still showing a huge `numOps` purely from genuinely large CURRENT
 *  content (e.g. a detailed doodle's stroke/point array) — compacting that
 *  doc again produces an identical op count, since there was never any
 *  history to remove. `numChanges` is what actually drives how much
 *  history compaction can strip, so it's the correct signal for "is this
 *  worth compacting", independent of how much real data the doc holds.
 *
 *  exported so the gate itself is unit-testable independent of the pixi
 *  button UI (which can't be constructed in a vitest/node env). */
export const COMPACT_CHANGES_THRESHOLD = 50;

/** pure predicate — `stats` from `computeDocHistoryStats()`. */
export function shouldOfferCompaction(stats: DocHistoryStats): boolean {
  return stats.numChanges > COMPACT_CHANGES_THRESHOLD;
}

/** pure stats computation, no logging — `null` if the handle isn't ready
 *  or has no content. shared by `logDocHistoryStats()` below and by
 *  callers (widget-manager.ts's mount-time bloat check, diagnose-doc-
 *  history.ts's devtools dump) that want the raw numbers instead of a
 *  fixed log line.
 *
 *  `includeExpensive` (default false) gates `A.save()` (savedBytes) and
 *  the `getAllChanges`+`decodeChange` loop (maxChangeOps) — both are
 *  full-history walks, O(total ops) in the doc, and MUST stay opt-in for
 *  any automatic/every-mount call site (see `maxChangeOps`'s own doc
 *  comment above). only pass `true` from a manual, on-demand devtools
 *  call (e.g. `diagnose-doc-history.ts`) where the caller has explicitly
 *  asked for the deep numbers and can tolerate the cost.
 *
 *  logs an unconditional `console.warn` (not gated behind
 *  `localStorage.logLevel`) if the whole call takes more than 50ms, broken
 *  down by phase — still applies even to the cheap (`A.stats()`-only)
 *  path, as a tripwire in case even that ever turns out not to be as
 *  cheap as expected for some pathological doc. */
export function computeDocHistoryStats(
  handle: DocHandle<any> | null | undefined,
  options?: { includeExpensive?: boolean }
): DocHistoryStats | null {
  if (!handle?.isReady()) return null;
  const doc = handle.doc();
  if (!doc) return null;

  const statsStart = performance.now();
  const stats = A.stats(doc);
  const statsMs = performance.now() - statsStart;

  let savedBytes: number | null = null;
  let maxChangeOps: number | null = null;
  let saveMs = 0;
  let decodeMs = 0;
  let changesDecoded = 0;

  if (options?.includeExpensive) {
    const saveStart = performance.now();
    savedBytes = A.save(doc).byteLength;
    saveMs = performance.now() - saveStart;

    const decodeStart = performance.now();
    maxChangeOps = 0;
    try {
      for (const change of A.getAllChanges(doc)) {
        const ops = A.decodeChange(change).ops.length;
        changesDecoded++;
        if (ops > maxChangeOps) maxChangeOps = ops;
      }
    } catch {
      // best-effort — not worth failing the whole stats computation over
    }
    decodeMs = performance.now() - decodeStart;
  }

  const totalMs = statsMs + saveMs + decodeMs;
  if (totalMs > 50) {
    console.warn(
      `[doc-history-stats] computeDocHistoryStats for ${handle.documentId} took ${totalMs.toFixed(1)}ms total — ` +
        `A.stats=${statsMs.toFixed(1)}ms, A.save=${saveMs.toFixed(1)}ms, ` +
        `decodeLoop=${decodeMs.toFixed(1)}ms (${changesDecoded} changes decoded)`
    );
  }

  return { numChanges: stats.numChanges, numOps: stats.numOps, maxChangeOps, savedBytes };
}

/** logs `label`'s numChanges/numOps (and byte size of a full save) if the
 *  handle is ready and has content — a no-op otherwise.
 *
 *  also logs the single largest individual change's op count — a doc with
 *  an unusually high numOps/numChanges ratio (like narthex — see
 *  docs/narthex-doc-history-plan.md) usually has a small number of huge
 *  outlier changes rather than uniformly large ones, and this pinpoints
 *  them without a separate one-off script. */
export function logDocHistoryStats(label: string, handle: DocHandle<any> | null | undefined): void {
  try {
    const stats = computeDocHistoryStats(handle);
    if (!stats) return;
    log.debug(
      TAG,
      `${label} (${handle!.documentId}) — numChanges: ${stats.numChanges}, numOps: ${stats.numOps}, ` +
        `maxChangeOps: ${stats.maxChangeOps ?? "n/a (cheap check)"}, savedBytes: ${stats.savedBytes ?? "n/a (cheap check)"}`
    );
  } catch (err) {
    log.warn(TAG, `failed to compute stats for ${label}:`, err);
  }
}


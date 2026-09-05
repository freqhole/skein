/**
 * one-shot migration: permanently rewrites any widget doc the tumulus hub
 * has ever written into directly (e.g. stamping `snatchedBy` after a p2p
 * snatch) so its string fields are stored as normal js strings, not
 * `ImmutableString` instances — see `automerge-values.ts`'s own doc
 * comment for the underlying cross-language interop gap.
 *
 * every read site that matters (`widget-doc.ts`'s facade, `drop-
 * controller.ts`'s cross-widget reads) already normalizes at READ time
 * via `deepUnwrapAmStrings()`, so this migration isn't required for
 * correctness going forward — but it's cheap, permanent, and removes the
 * risk of some future/third-party read site forgetting that
 * normalization step (which is exactly how animaniac drops broke: a read
 * site that predated the fix). safe to re-run — a doc with no
 * `ImmutableString` anywhere is left untouched (see
 * `containsImmutableString()`).
 *
 * intentionally not wired into any UI button — meant to be run once, ad
 * hoc, from the browser devtools console against the currently open
 * canvas, bundled into `window.__skeinBackfillFileDurations()` (see
 * `standalone/boot.ts`) alongside the duration backfill.
 */

import type { DocumentId } from "@automerge/automerge-repo";
import type { CanvasStore } from "../canvas/canvas-store";
import { containsImmutableString, deepUnwrapAmStrings } from "../canvas/automerge-values";
import { resolveDocReadyCached } from "../p2p/doc-ready";

export interface FixImmutableStringsResult {
  /** widgets with a docId whose doc could be opened at all. */
  checked: number;
  /** widgets whose doc had at least one `ImmutableString` field, now
   *  rewritten as plain strings. */
  fixed: number;
  /** widgets whose doc never became reachable — left untouched, safe to
   *  re-run later. */
  unreachable: number;
}

/** rewrites every field of `rawDoc` (a whole widget doc snapshot) that
 *  `deepUnwrapAmStrings()` would otherwise only fix at read time, so the
 *  fix is permanent. reassigns EVERY top-level key (not just the tainted
 *  ones) to `deepUnwrapAmStrings()`'s freshly-rebuilt value — safe even
 *  for array/object fields (e.g. animaniac's own `clips`), since
 *  `deepUnwrapAmStrings()` always constructs brand-new plain objects/
 *  arrays at every level rather than reusing the original doc-owned
 *  references (the thing that would otherwise risk automerge's own
 *  "Cannot create a reference to an existing document object" error). */
function rewriteNormalized(d: Record<string, unknown>, normalized: Record<string, unknown>): void {
  for (const key of Object.keys(normalized)) {
    const next = normalized[key];
    if (next === undefined) continue; // automerge drafts don't want an explicit undefined property
    d[key] = next;
  }
}

export async function fixImmutableStringFields(store: CanvasStore): Promise<FixImmutableStringsResult> {
  const result: FixImmutableStringsResult = { checked: 0, fixed: 0, unreachable: 0 };

  for (const entry of store.allWidgets()) {
    if (!entry.docId) continue;

    const handle = await resolveDocReadyCached<Record<string, unknown>>(store.repo, entry.docId as DocumentId, {
      context: "fix-immutable-strings",
    });
    if (!handle) {
      result.unreachable++;
      continue;
    }
    const rawDoc = handle.doc();
    if (!rawDoc) {
      result.unreachable++;
      continue;
    }
    result.checked++;

    if (!containsImmutableString(rawDoc)) continue;

    const normalized = deepUnwrapAmStrings(rawDoc) as Record<string, unknown>;
    handle.change((d) => rewriteNormalized(d, normalized));
    result.fixed++;
  }

  return result;
}

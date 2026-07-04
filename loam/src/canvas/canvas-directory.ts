// ---------------------------------------------------------------------------
// best-effort canvas directory lookup — the candidate pool for the "link to
// an existing canvas" picker (widgets/canvas-link-picker.ts). mirrors
// friend-directory.ts's own shape: a pure filter/map function (fully
// unit-testable, no automerge/pixi/DOM) plus a thin async wrapper that
// resolves the local peer's own narthex doc id and reads its canvas-card
// widgets.
//
// candidate source: every `canvas-card` widget currently on the LOCAL
// peer's own narthex — i.e. every canvas this peer has bookmarked, created,
// or joined. unlike friend-directory.ts's friend list (browser-mode only,
// since tauri's social doc lives in a separate sqlite backend), this works
// in BOTH modes — the narthex and every canvas doc are always reached
// through the shared automerge `Repo`, regardless of which social-doc
// backend is active.
// ---------------------------------------------------------------------------

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import type { WidgetEntry } from "./canvas-doc";
import { CanvasStore } from "./canvas-store";
import { getMetaValue } from "../storage/meta-db";
import { canvasCardSchema } from "../../widgets/narthex/canvas-card";

/** meta-db key for the narthex document id — mirrors
 *  `src/standalone/boot.ts`'s (unexported) `NARTHEX_DOC_KEY` constant
 *  exactly (kept as a literal here rather than importing boot.ts itself,
 *  same reasoning `friend-directory.ts` already documents for its own
 *  `SOCIAL_DOC_KEY` literal — avoids pulling the whole `SkeinRouter`
 *  module into every widget that just needs the narthex doc id). */
const NARTHEX_DOC_KEY = "skein-narthex-doc-id";

/** one candidate canvas for the "link to canvas" picker. */
export interface CanvasPickerCandidate {
  canvasDocId: string;
  title: string;
  description: string;
  previewUrl: string;
  color: number;
}

/**
 * pure filter/map step: turn a narthex's raw widget entries into picker
 * candidates. excludes non-`canvas-card` widgets, soft-deleted cards, cards
 * with no target doc id, and (when given) `excludeCanvasDocId` — a canvas
 * must never be offered as a link target for itself. fully unit-testable
 * without automerge/pixi/DOM.
 */
export function filterCanvasCardCandidates(
  widgets: WidgetEntry[],
  excludeCanvasDocId?: string
): CanvasPickerCandidate[] {
  const candidates: CanvasPickerCandidate[] = [];
  for (const widget of widgets) {
    if (widget.type !== "canvas-card") continue;
    const parsed = canvasCardSchema.safeParse(widget.props);
    if (!parsed.success) continue;
    const card = parsed.data;
    if (card.isDeleted) continue;
    if (!card.canvasDocId) continue;
    if (excludeCanvasDocId && card.canvasDocId === excludeCanvasDocId) continue;
    candidates.push({
      canvasDocId: card.canvasDocId,
      title: card.title,
      description: card.description,
      previewUrl: card.previewUrl,
      color: card.color,
    });
  }
  return candidates;
}

/**
 * best-effort candidate list for the "link to canvas" picker — resolves
 * the local peer's own narthex doc id, opens it, and filters its
 * canvas-card widgets via `filterCanvasCardCandidates()`. returns `[]` on
 * any failure (no narthex yet, doc unreachable) rather than throwing —
 * same convention as `friend-directory.ts`'s `getFriendsForPicker()`.
 */
export async function getCanvasesForPicker(
  repo: Repo,
  excludeCanvasDocId?: string
): Promise<CanvasPickerCandidate[]> {
  try {
    const narthexDocId = await getMetaValue(NARTHEX_DOC_KEY);
    if (!narthexDocId) return [];
    const store = await CanvasStore.open(repo, narthexDocId as DocumentId);
    return filterCanvasCardCandidates(store.allWidgets(), excludeCanvasDocId);
  } catch {
    return [];
  }
}

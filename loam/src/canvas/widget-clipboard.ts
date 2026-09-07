/**
 * cross-canvas widget copy/paste. Cmd/Ctrl+C copies the current selection
 * (recursively including a `bin` widget's own nested children), Cmd/Ctrl+V
 * recreates fresh copies — new widget ids, new per-widget automerge docs —
 * on whichever canvas is open at paste time. see input-router.ts's keydown
 * handling and widget-manager.ts's `start()` for where this is wired up.
 *
 * **a pasted `canvas-card` gets its own, fully independent target canvas
 * too** (via `canvas-duplicate.ts`'s `duplicateCanvasDeep()`, in `pasteOne`
 * below) — a shallow copy of just the card's own field values would leave
 * BOTH the original and the pasted card's `canvasDocId` pointing at the
 * exact same canvas, so "editing the copy" would silently edit the
 * original's real widgets. every other widget type already gets a real
 * independent doc from a plain `repo.create()`; canvas-card needs the
 * extra recursive step specifically because its own state doesn't contain
 * the thing being duplicated, just a pointer to it.
 *
 * every open canvas shares ONE `Repo` instance (boot.ts's `this.repo`), so
 * "cross-canvas" doesn't need any cross-repo bridging — paste just creates
 * a new doc via the same repo and adds an entry to whichever `CanvasStore`
 * happens to be open. the clipboard itself is a plain module-level
 * singleton rather than living on `InputRouter`/`WidgetManager` (both
 * torn down and recreated on every canvas switch, see init.ts) so it
 * survives navigating from the copied-from canvas to the pasted-into one.
 */

import type { DocumentId } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import type { CanvasStore } from "./canvas-store";
import type { WidgetEntry } from "./canvas-doc";
import type { WidgetRegistry } from "../widgets/widget-registry";
import { resolveDocReadyCached } from "../p2p/doc-ready";
import { deepUnwrapAmStrings } from "./automerge-values";
import { registerBlobRefs } from "./blob-ref-registration";
import { duplicateCanvasDeep } from "./canvas-duplicate";
import { createTestRegistry } from "../../widgets/index";

const TAG = "canvas.widget-clipboard";

/** how far (in canvas units) a pasted copy is offset from the original —
 *  applied to the original coordinates regardless of which canvas paste
 *  lands on, since there's no "pointer position on the destination canvas"
 *  signal available at paste time (matches the classic paste-offset UX so
 *  a same-canvas paste never lands exactly on top of what was copied). */
const PASTE_OFFSET = 32;

interface ClipboardWidget {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
  title?: string;
  /** whether the ORIGINAL widget was stateful (had a per-widget doc) — a
   *  paste refuses to create a doc-less copy of a stateful widget whose
   *  state we failed to read (`state === null` but `hadDocId === true`),
   *  rather than silently pasting an empty shell. */
  hadDocId: boolean;
  state: Record<string, unknown> | null;
  /** nested children — currently only populated for `bin` widgets, since
   *  that's the only widget type that references other top-level widgets
   *  (see bin-schema.ts's `items` array). */
  children: Array<{ slot: { col: number; row: number }; widget: ClipboardWidget }>;
}

let clipboard: ClipboardWidget[] | null = null;
let changeListeners: Array<(count: number) => void> = [];

/** true if a previous copy left something to paste. */
export function hasClipboardContent(): boolean {
  return !!clipboard && clipboard.length > 0;
}

/** number of TOP-LEVEL widgets currently on the clipboard (nested bin
 *  children don't count separately) — used by clipboard-cursor.ts to pick
 *  how many "cards" to draw. */
export function clipboardCount(): number {
  return clipboard?.length ?? 0;
}

/** subscribe to clipboard content changes (copy, clear, or a paste that
 *  clears afterward). called immediately with the current count, then
 *  again on every change. returns an unsubscribe function. */
export function onClipboardChange(listener: (count: number) => void): () => void {
  changeListeners.push(listener);
  listener(clipboardCount());
  return () => {
    changeListeners = changeListeners.filter((l) => l !== listener);
  };
}

function notifyClipboardChange(): void {
  const count = clipboardCount();
  for (const listener of changeListeners) listener(count);
}

/** explicitly empty the clipboard (e.g. after a context-menu "paste here",
 *  which is meant to be a one-shot precise placement rather than the
 *  repeatable Cmd+V). */
export function clearClipboard(): void {
  if (!clipboard) return;
  clipboard = null;
  notifyClipboardChange();
}

/** true unless the widget type's factory metadata explicitly opts out
 *  (see `WidgetMetadata.copyable`'s own doc comment — e.g. canvas-info). */
export function isCopyable(registry: WidgetRegistry, type: string): boolean {
  return registry.get(type)?.metadata.copyable !== false;
}

/** read one widget's current state through its registry schema — the same
 *  normalize-then-parse path every other cross-widget reader in this app
 *  uses (see automerge-values.ts's own doc comment on why the normalize
 *  step is needed). returns `entry.props` directly for a stateless widget
 *  (no `docId`), or `null` if the doc can't be reached/parsed. */
async function readWidgetState(
  store: CanvasStore,
  registry: WidgetRegistry,
  entry: WidgetEntry
): Promise<Record<string, unknown> | null> {
  if (!entry.docId) return entry.props ?? {};
  const factory = registry.get(entry.type);
  if (!factory?.schema) return null;
  const handle = await resolveDocReadyCached<Record<string, unknown>>(store.repo, entry.docId as DocumentId, {
    context: "widget-clipboard.copy",
  });
  const rawDoc = handle?.doc();
  if (!rawDoc) return null;
  try {
    return factory.schema.parse(deepUnwrapAmStrings(rawDoc)) as Record<string, unknown>;
  } catch (err) {
    log.debug(TAG, `schema.parse failed for ${entry.id} (${entry.type}), skipping:`, err);
    return null;
  }
}

/** recursively build a copyable bundle for one widget entry — for a `bin`,
 *  also copies every child, so "copy a bin" really means "copy the bin and
 *  everything filed inside it". */
async function buildClipboardWidget(
  store: CanvasStore,
  registry: WidgetRegistry,
  entry: WidgetEntry
): Promise<ClipboardWidget> {  const state = await readWidgetState(store, registry, entry);
  const bundle: ClipboardWidget = {
    type: entry.type,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    collapsed: entry.collapsed,
    title: entry.title,
    hadDocId: entry.docId !== null,
    state,
    children: [],
  };

  if (entry.type === "bin" && state) {
    const items = Array.isArray(state.items)
      ? (state.items as Array<{ widgetId: string; slot: { col: number; row: number } }>)
      : [];
    for (const item of items) {
      const childEntry = store.getWidget(item.widgetId);
      if (!childEntry || !isCopyable(registry, childEntry.type)) continue;
      bundle.children.push({ slot: item.slot, widget: await buildClipboardWidget(store, registry, childEntry) });
    }
  }

  return bundle;
}

/**
 * copy the given widget ids to the clipboard, replacing any previous
 * content. an id that's itself a child of another id already in the set is
 * skipped as its own top-level entry — it's captured recursively via its
 * parent bin instead (see `buildClipboardWidget()`).
 */
export async function copySelectionToClipboard(
  store: CanvasStore,
  registry: WidgetRegistry,
  selectedIds: ReadonlySet<string>
): Promise<void> {
  const ids = [...selectedIds];
  const bundles: ClipboardWidget[] = [];
  for (const id of ids) {
    const entry = store.getWidget(id);
    if (!entry || !isCopyable(registry, entry.type)) continue;
    if (entry.parentId && ids.includes(entry.parentId)) continue;
    bundles.push(await buildClipboardWidget(store, registry, entry));
  }
  clipboard = bundles.length > 0 ? bundles : null;
  log.debug(TAG, `copied ${bundles.length} widget(s) to clipboard`);
  notifyClipboardChange();
}

export interface PasteResult {
  /** ids of the newly created TOP-LEVEL widgets (not nested bin children) —
   *  used to re-select the pasted widgets after paste completes. */
  pasted: string[];
  /** widgets whose state couldn't be read at copy time (doc unreachable or
   *  failed to parse) and were therefore skipped rather than pasted empty. */
  skipped: number;
}

/** recreate one clipboard bundle (and, for a bin, its children) on `store`,
 *  returning the new widget's id, or null if it had to be skipped. */
async function pasteOne(
  store: CanvasStore,
  bundle: ClipboardWidget,
  parentId: string | null,
  canvasDocId: string,
  dx: number,
  dy: number,
  onSkip: () => void
): Promise<string | null> {
  if (bundle.hadDocId && bundle.state === null) {
    onSkip();
    return null;
  }

  let docId: string | null = null;
  if (bundle.hadDocId) {
    let state = bundle.state;
    // a canvas-card is just a pointer (its `canvasDocId` field) — pasting
    // one without this special case would leave BOTH the original and the
    // pasted card pointing at the exact SAME target canvas, so "editing
    // the copy" would silently edit the original's real widgets. give the
    // pasted card its own, fully independent target canvas instead (see
    // `canvas-duplicate.ts`'s own doc comment for why a shallow field copy
    // isn't good enough here). uses the full, regular-canvas widget
    // registry (`createTestRegistry()`), NOT whatever registry `store`'s
    // own canvas happens to use — a canvas-card is routinely pasted while
    // ON narthex (whose own registry is deliberately a narrow subset, see
    // `createNarthexRegistry()`), but the canvas it POINTS TO is a regular
    // canvas that can contain ANY widget type, so narthex's own registry
    // would silently fail to recognize most of them (confirmed live: this
    // exact mismatch caused a duplicated canvas to come back blank, every
    // non-narthex widget type silently skipped as "couldn't read its doc"
    // when really it was just "couldn't find its schema in the wrong,
    // narrower registry"). best-effort: if the target canvas can't be
    // reached/duplicated (e.g. offline peer), fall back to the shallow
    // copy rather than failing the whole paste — same as every other
    // best-effort resolve in this app.
    if (bundle.type === "canvas-card" && state && typeof state.canvasDocId === "string" && state.canvasDocId) {
      try {
        const dup = await duplicateCanvasDeep(store.repo, createTestRegistry(), state.canvasDocId, store.localNodeId);
        // `dup.title` is already suffixed with " (copy)" (see
        // `canvas-duplicate.ts`) — use it as-is, don't append again here.
        state = { ...state, canvasDocId: dup.newCanvasDocId, title: dup.title };
      } catch (err) {
        log.debug(TAG, `duplicateCanvasDeep failed for pasted canvas-card (falling back to a shared reference):`, err);
      }
    }
    const handle = store.repo.create(state ?? {});
    docId = handle.documentId;
    registerBlobRefs(state, canvasDocId);
  }

  const widgetId = crypto.randomUUID();
  const zIndex = 1 + Math.max(0, ...store.allWidgets().map((w) => w.zIndex || 0));
  store.addWidget({
    id: widgetId,
    type: bundle.type,
    x: bundle.x + dx,
    y: bundle.y + dy,
    width: bundle.width,
    height: bundle.height,
    zIndex,
    props: bundle.hadDocId ? {} : (bundle.state ?? {}),
    collapsed: bundle.collapsed,
    title: bundle.title,
    docId,
    parentId,
  });

  if (bundle.children.length > 0 && docId) {
    const items: Array<{ widgetId: string; slot: { col: number; row: number } }> = [];
    for (const child of bundle.children) {
      const childId = await pasteOne(store, child.widget, widgetId, canvasDocId, dx, dy, onSkip);
      if (childId) items.push({ widgetId: childId, slot: child.slot });
    }
    const binHandle = await resolveDocReadyCached<{ items: unknown }>(store.repo, docId as DocumentId, {
      context: "widget-clipboard.paste-bin-items",
    });
    binHandle?.change((d) => {
      d.items = items;
    });
  }

  return widgetId;
}

export interface PasteOptions {
  /** paste anchored so the copied selection's top-left bounding-box corner
   *  lands exactly at this world position (context-menu "paste here") —
   *  when omitted, uses the fixed `PASTE_OFFSET` from the original
   *  coordinates instead (Cmd/Ctrl+V's repeatable-paste behavior). */
  at?: { x: number; y: number };
  /** empty the clipboard (and its cursor) once paste completes — a
   *  one-shot placement rather than a repeatable paste. */
  clearAfter?: boolean;
}

/** paste the current clipboard content onto `store`. a no-op (empty
 *  result) if the clipboard is empty or the local peer is a viewer. */
export async function pasteClipboardIntoStore(store: CanvasStore, options?: PasteOptions): Promise<PasteResult> {
  if (!clipboard || clipboard.length === 0 || store.isLocalViewer()) {
    return { pasted: [], skipped: 0 };
  }

  let dx = PASTE_OFFSET;
  let dy = PASTE_OFFSET;
  if (options?.at) {
    const minX = Math.min(...clipboard.map((b) => b.x));
    const minY = Math.min(...clipboard.map((b) => b.y));
    dx = options.at.x - minX;
    dy = options.at.y - minY;
  }

  const canvasDocId = store.handle.documentId;
  let skipped = 0;
  const pastedIds: string[] = [];
  for (const bundle of clipboard) {
    const id = await pasteOne(store, bundle, null, canvasDocId, dx, dy, () => skipped++);
    if (id) pastedIds.push(id);
  }

  log.debug(TAG, `pasted ${pastedIds.length} widget(s), skipped ${skipped}`);
  if (options?.clearAfter) clearClipboard();
  return { pasted: pastedIds, skipped };
}

/**
 * cross-canvas widget copy/paste. Cmd/Ctrl+C copies the current selection
 * (recursively including a `bin` widget's own nested children), Cmd/Ctrl+V
 * recreates fresh copies — new widget ids, new per-widget automerge docs —
 * on whichever canvas is open at paste time. see input-router.ts's keydown
 * handling and widget-manager.ts's `start()` for where this is wired up.
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
import { addBlobCanvasRef } from "../file-utils/blob-canvas-refs";

const TAG = "canvas.widget-clipboard";

/** how far (in canvas units) a pasted copy is offset from the original —
 *  applied to the original coordinates regardless of which canvas paste
 *  lands on, since there's no "pointer position on the destination canvas"
 *  signal available at paste time (matches the classic paste-offset UX so
 *  a same-canvas paste never lands exactly on top of what was copied). */
const PASTE_OFFSET = 32;

/** known blob-id/blake3 field-name pairs across widget schemas — best
 *  effort, not exhaustive (e.g. `image`'s `url`-embedded blob refs aren't
 *  covered) — see `registerBlobRefs()`. */
const BLOB_FIELD_PAIRS: Array<[string, string]> = [
  ["blobId", "blake3"],
  ["videoBlobId", "videoBlake3"],
];

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

/** true if a previous copy left something to paste. */
export function hasClipboardContent(): boolean {
  return !!clipboard && clipboard.length > 0;
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
): Promise<ClipboardWidget> {
  const state = await readWidgetState(store, registry, entry);
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
      if (!childEntry) continue;
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
    if (!entry) continue;
    if (entry.parentId && ids.includes(entry.parentId)) continue;
    bundles.push(await buildClipboardWidget(store, registry, entry));
  }
  clipboard = bundles.length > 0 ? bundles : null;
  log.debug(TAG, `copied ${bundles.length} widget(s) to clipboard`);
}

/** best-effort blob-canvas-ref registration for a pasted widget's state —
 *  see `BLOB_FIELD_PAIRS`'s doc comment for coverage caveats. */
function registerBlobRefs(state: Record<string, unknown> | null, canvasDocId: string): void {
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
  onSkip: () => void
): Promise<string | null> {
  if (bundle.hadDocId && bundle.state === null) {
    onSkip();
    return null;
  }

  let docId: string | null = null;
  if (bundle.hadDocId) {
    const handle = store.repo.create(bundle.state ?? {});
    docId = handle.documentId;
    registerBlobRefs(bundle.state, canvasDocId);
  }

  const widgetId = crypto.randomUUID();
  const zIndex = 1 + Math.max(0, ...store.allWidgets().map((w) => w.zIndex || 0));
  store.addWidget({
    id: widgetId,
    type: bundle.type,
    x: bundle.x + PASTE_OFFSET,
    y: bundle.y + PASTE_OFFSET,
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
      const childId = await pasteOne(store, child.widget, widgetId, canvasDocId, onSkip);
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

/** paste the current clipboard content onto `store`. a no-op (empty
 *  result) if the clipboard is empty or the local peer is a viewer. */
export async function pasteClipboardIntoStore(store: CanvasStore): Promise<PasteResult> {
  if (!clipboard || clipboard.length === 0 || store.isLocalViewer()) {
    return { pasted: [], skipped: 0 };
  }

  const canvasDocId = store.handle.documentId;
  let skipped = 0;
  const pastedIds: string[] = [];
  for (const bundle of clipboard) {
    const id = await pasteOne(store, bundle, null, canvasDocId, () => skipped++);
    if (id) pastedIds.push(id);
  }

  log.debug(TAG, `pasted ${pastedIds.length} widget(s), skipped ${skipped}`);
  return { pasted: pastedIds, skipped };
}

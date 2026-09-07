/**
 * deep, fully-independent canvas duplication — unlike `widget-clipboard.ts`'s
 * copy/paste (which only clones the individual widgets you select, and for a
 * `canvas-card` that means cloning just the CARD/pointer, leaving its
 * `canvasDocId` field pointing at the exact same original target canvas),
 * this walks an entire canvas doc's widget list and gives EVERY stateful
 * widget a brand new automerge doc, seeded from a snapshot of its current
 * content — including recursively duplicating any nested `canvas-card`
 * widget's own linked canvas, so the whole reachable tree ends up as an
 * independent copy sharing no doc identity with the original.
 *
 * built specifically so a destructive/experimental operation (e.g. testing
 * `compact-doc.ts`'s compaction on a real, valuable canvas) can be tried on
 * a throwaway copy first without any risk to the original — see
 * `docs/animaniac-doc-compaction-plan.md`.
 */

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import { CanvasStore } from "./canvas-store";
import type { WidgetEntry } from "./canvas-doc";
import type { WidgetRegistry } from "../widgets/widget-registry";
import { resolveDocReadyCached } from "../p2p/doc-ready";
import { deepUnwrapAmStrings } from "./automerge-values";
import { registerBlobRefs } from "./blob-ref-registration";

const TAG = "canvas.canvas-duplicate";

export interface DuplicateCanvasResult {
  newCanvasDocId: string;
  /** the new canvas's own title — already suffixed with " (copy)" (this is
   *  the actual canvas title, not just a card's own title field, so it
   *  survives `canvas-watchers.ts`'s metadata sync instead of being
   *  silently overwritten by it). callers building a pointer card for this
   *  new canvas should use this value as-is, not append "(copy)" again. */
  title: string;
  /** total widgets whose own doc couldn't be read/parsed and were
   *  therefore left out of the duplicate entirely (matches
   *  `widget-clipboard.ts`'s own "never paste an empty shell for a
   *  stateful widget we couldn't read" philosophy) — summed across every
   *  canvas duplicated as part of this call, including nested ones. */
  skipped: number;
}

/** deep-clones `sourceCanvasDocId` (and, recursively, any canvas a nested
 *  `canvas-card` widget on it points to) into brand new, zero-shared-history
 *  automerge docs.
 *
 * `localNodeId`, if given, is stamped as admin on every newly created
 * canvas (matches `boot.ts`'s `createCanvasFromNarthex()` — a freshly
 * created canvas needs SOME admin or nothing could ever invite/share it
 * later) — pass `""`/omit for a headless/test context with no real peer
 * identity yet.
 *
 * **deliberately does NOT copy the original's `acl`/`peers`/pending
 * invites or knocks** — every duplicate starts as a fresh, private,
 * `localNodeId`-only canvas, never silently inheriting the original's
 * collaborator list. this is a safety property, not an oversight.
 *
 * `seenCanvasIds` (old canvas docId -> new canvas docId) is threaded
 * through recursive calls so a cycle (two canvases whose cards point at
 * each other, directly or indirectly) or a shared reference (two cards on
 * the same canvas pointing at the SAME target) resolves to one single new
 * copy, not an infinite loop or redundant duplicates — pass a fresh `Map`
 * (the default) for a top-level call; only recursive calls need to pass
 * theirs through explicitly.
 */
export async function duplicateCanvasDeep(
  repo: Repo,
  registry: WidgetRegistry,
  sourceCanvasDocId: string,
  localNodeId = "",
  seenCanvasIds: Map<string, string> = new Map()
): Promise<DuplicateCanvasResult> {
  const already = seenCanvasIds.get(sourceCanvasDocId);
  if (already) {
    const store = await CanvasStore.open(repo, already as DocumentId);
    return { newCanvasDocId: already, title: store.metadata().title, skipped: 0 };
  }

  const sourceStore = await CanvasStore.open(repo, sourceCanvasDocId as DocumentId);
  const newStore = CanvasStore.create(repo);
  const newCanvasDocId = newStore.handle.documentId;
  seenCanvasIds.set(sourceCanvasDocId, newCanvasDocId);

  const meta = sourceStore.metadata();
  // the "(copy)" suffix must live on the CANVAS's own title, not just the
  // pointer card's — `canvas-watchers.ts`'s metadata sync (one-shot AND
  // live) always overwrites a card's title from its linked canvas's real
  // title, so a suffix applied only to the card was silently erased the
  // next time that sync ran (confirmed live: restarting the app re-runs
  // the one-shot sync, wiping "(copy)" back to the plain original title).
  const newTitle = `${meta.title} (copy)`;
  newStore.setTitle(newTitle);
  if (meta.description) newStore.setDescription(meta.description);
  newStore.setCreatedAt(new Date().toISOString());
  if (meta.color) newStore.setColor(meta.color);
  if (meta.previewUrl) newStore.setPreviewUrl(meta.previewUrl);
  if (localNodeId) newStore.stampAdmin(localNodeId);

  const entries = sourceStore.allWidgets();
  // built up front so parentId/bin-items remapping (below) can reference
  // ANY entry's new id regardless of which order entries are processed in.
  const idMap = new Map<string, string>();
  for (const entry of entries) idMap.set(entry.id, crypto.randomUUID());

  let skipped = 0;
  for (const entry of entries) {
    const newId = idMap.get(entry.id)!;
    let newDocId: string | null = null;
    let newProps: Record<string, unknown> = entry.props;

    if (entry.docId) {
      const factory = registry.get(entry.type);
      const schema = factory?.schema;
      let clonedState: Record<string, unknown> | null = null;
      if (schema) {
        const handle = await resolveDocReadyCached<Record<string, unknown>>(repo, entry.docId as DocumentId, {
          context: "canvas-duplicate",
        });
        const rawDoc = handle?.doc();
        if (rawDoc) {
          try {
            clonedState = schema.parse(deepUnwrapAmStrings(rawDoc)) as Record<string, unknown>;
          } catch (err) {
            log.debug(TAG, `schema.parse failed for ${entry.id} (${entry.type}), skipping:`, err);
          }
        }
      }
      if (!clonedState) {
        // a stateful widget whose content we couldn't read/parse — skip it
        // entirely rather than paste an empty shell (same philosophy as
        // widget-clipboard.ts's pasteOne()).
        skipped++;
        continue;
      }
      if (entry.type === "canvas-card" && typeof clonedState.canvasDocId === "string" && clonedState.canvasDocId) {
        const nested = await duplicateCanvasDeep(repo, registry, clonedState.canvasDocId, localNodeId, seenCanvasIds);
        clonedState.canvasDocId = nested.newCanvasDocId;
        skipped += nested.skipped;
      }
      const newHandle = repo.create(clonedState);
      newDocId = newHandle.documentId;
      registerBlobRefs(clonedState, newCanvasDocId);
      newProps = {};
    }

    const newEntry: WidgetEntry = {
      id: newId,
      type: entry.type,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      zIndex: entry.zIndex,
      props: newProps,
      collapsed: entry.collapsed,
      title: entry.title,
      docId: newDocId,
      parentId: entry.parentId ? (idMap.get(entry.parentId) ?? null) : null,
    };
    newStore.addWidget(newEntry);
  }

  // second pass: a `bin` widget's own doc carries an `items` array of
  // `{widgetId, slot}` referencing sibling widgets by the OLD id — now
  // that every sibling has been given a new id (idMap, built up front),
  // patch each bin's own cloned doc to point at the new ids instead.
  // mutates each item's `widgetId` field IN PLACE rather than reassigning
  // the whole array (`d.items = d.items.map(...)`), which automerge
  // rejects with "Cannot create a reference to an existing document
  // object" once the array is non-empty — see repo memory
  // automerge-gotchas.md.
  for (const entry of entries) {
    if (entry.type !== "bin") continue;
    const newId = idMap.get(entry.id)!;
    const newEntry = newStore.getWidget(newId);
    if (!newEntry?.docId) continue;
    const handle = await resolveDocReadyCached<{ items?: Array<{ widgetId: string }> }>(repo, newEntry.docId as DocumentId, {
      context: "canvas-duplicate-bin-items",
    });
    handle?.change((d) => {
      if (!Array.isArray(d.items)) return;
      for (const item of d.items) {
        const mapped = idMap.get(item.widgetId);
        if (mapped) item.widgetId = mapped;
      }
    });
  }

  return { newCanvasDocId, title: newTitle, skipped };
}
// ---------------------------------------------------------------------------
// canvas-bin document — schema + store.
//
// see docs/hub-and-profile-plan.md section 10.2. this is the *organizational*
// layer behind the real narthex "canvas bin" widget (widgets/narthex/social/
// canvas-bin.ts): a recursive tree of folders that lets a peer file their own
// `ProfileCanvasEntry`s (profile-doc.ts, NOT modified by this file) into
// nested groups, the same way the existing `widgets/bin/index.ts` widget
// lets you nest same-canvas widgets into grid/shelf/crate/drawer bins.
//
// this is a deliberately separate, brand-new automerge doc — not a new field
// on `ProfileDocument` — for two reasons:
//
// - the task building this widget was explicitly told not to modify
//   profile-doc.ts's API/schema (it's already-shipped, depended-on code).
// - `ProfileDocument.canvases` is the curated, *shared-with-friends* index
//   (title/description/color/preview) — the folder structure organizing
//   those entries for display is purely a local viewing preference, never
//   synced to anyone else, so it doesn't belong in a doc that friends hold
//   read-only copies of.
//
// **data model note (searchability, per the plan doc's explicit ask)**: a
// canvas node stores only `canvasDocId` — never a copy of its title/
// description. those stay in exactly one place (`ProfileStore.canvases()`,
// already a flat, directly-searchable list of plain strings) so a future
// search feature has one authoritative source to query, with no risk of a
// stale duplicate drifting out of sync. this doc only tracks *where* each
// canvas is filed (which folder), not *what it's called*. folder titles are
// plain strings too — no indirection.
//
// mirrors profile-doc.ts's "typed automerge doc + a Store class wrapping
// DocHandle" pattern.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import { getMetaValue, setMetaValue } from "../storage/meta-db";
import type { ProfileCanvasEntry } from "./profile-doc";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/** layout mode — same four options `widgets/bin/index.ts` supports. */
export const canvasBinModeSchema = z.enum(["grid", "shelf", "crate", "drawer"]);
export type CanvasBinMode = z.infer<typeof canvasBinModeSchema>;

/** slot size preset — same options `widgets/bin/bin-constants.ts` defines. */
export const canvasBinSlotScaleSchema = z.enum(["s", "m", "l", "xl"]);
export type CanvasBinSlotScale = z.infer<typeof canvasBinSlotScaleSchema>;

export interface CanvasBinFolderNode {
  kind: "folder";
  id: string;
  title: string;
  children: CanvasBinNode[];
}

export interface CanvasBinCanvasNode {
  kind: "canvas";
  id: string;
  /** references a `ProfileCanvasEntry.canvasDocId` — the entry's own
   *  title/description/color/preview are read live from `ProfileStore`,
   *  never copied here (see module doc comment). */
  canvasDocId: string;
}

export type CanvasBinNode = CanvasBinFolderNode | CanvasBinCanvasNode;

export const canvasBinNodeSchema: z.ZodType<CanvasBinNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("canvas"),
      id: z.string(),
      canvasDocId: z.string(),
    }),
    z.object({
      kind: z.literal("folder"),
      id: z.string(),
      title: z.string(),
      children: z.array(canvasBinNodeSchema),
    }),
  ])
);

export const canvasBinDocumentSchema = z.object({
  mode: canvasBinModeSchema.default("grid"),
  slotScale: canvasBinSlotScaleSchema.default("m"),
  /** root-level nodes. order is significant — rendered in array order,
   *  same convention `bin`'s own item list uses. */
  nodes: z.array(canvasBinNodeSchema).default([]),
});
export type CanvasBinDocument = z.infer<typeof canvasBinDocumentSchema>;

/** create an empty canvas-bin document with default values. */
export function emptyCanvasBinDoc(): CanvasBinDocument {
  return {
    mode: "grid",
    slotScale: "m",
    nodes: [],
  };
}

// ---------------------------------------------------------------------------
// pure tree helpers — schema-agnostic recursive walks.
//
// these operate identically whether `nodes` is a plain snapshot array (read
// paths) or an automerge draft array (inside `handle.change()`, per the
// same convention `ProfileStore` uses for its own `.canvases` list) — they
// never rely on anything beyond `.length`/index access/recursion.
// ---------------------------------------------------------------------------

/** find a node by id anywhere in the tree (depth-first). */
function findNodeIn(nodes: CanvasBinNode[], id: string): CanvasBinNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === "folder") {
      const found = findNodeIn(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** find the array that directly contains a node with the given id, plus its
 *  index within that array. returns null if not found anywhere. */
function findContainingArray(
  nodes: CanvasBinNode[],
  id: string
): { arr: CanvasBinNode[]; index: number } | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { arr: nodes, index: i };
    const n = nodes[i];
    if (n.kind === "folder") {
      const found = findContainingArray(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** find a folder's `children` array by the folder's id. returns null if the
 *  id doesn't exist or isn't a folder. */
function findFolderChildren(nodes: CanvasBinNode[], folderId: string): CanvasBinNode[] | null {
  const found = findNodeIn(nodes, folderId);
  return found?.kind === "folder" ? found.children : null;
}

/** recursively collect every `canvasDocId` referenced anywhere in the tree. */
function collectCanvasDocIds(nodes: CanvasBinNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: CanvasBinNode[]) => {
    for (const n of list) {
      if (n.kind === "canvas") ids.add(n.canvasDocId);
      else walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

/** true if `candidateId` is `ancestorId` itself or anywhere within its
 *  subtree — used to block a move that would create a cycle. */
function isSameOrDescendant(nodes: CanvasBinNode[], ancestorId: string, candidateId: string): boolean {
  if (ancestorId === candidateId) return true;
  const ancestor = findNodeIn(nodes, ancestorId);
  if (ancestor?.kind !== "folder") return false;
  return findNodeIn(ancestor.children, candidateId) !== null;
}

/** recursively remove every canvas-kind node whose `canvasDocId` isn't in
 *  `validIds`. folders are never removed by this (even if left empty) —
 *  only `CanvasBinStore.removeNode()`, an explicit user action, deletes a
 *  folder. mutates `nodes` in place (call within `handle.change()`). */
function pruneCanvasNodesNotIn(nodes: CanvasBinNode[], validIds: Set<string>): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind === "canvas") {
      if (!validIds.has(n.canvasDocId)) nodes.splice(i, 1);
    } else {
      pruneCanvasNodesNotIn(n.children, validIds);
    }
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/**
 * wraps the canvas-bin automerge document with typed accessor/mutation
 * methods — mirrors `ProfileStore`/`CanvasStore`'s constructor/create/open
 * shape. no ACL/sharing concerns here (unlike `ProfileStore`) — this doc is
 * never shared with anyone, it only follows the local peer's own identity
 * across their own devices via ordinary automerge-repo sync.
 */
export class CanvasBinStore {
  readonly handle: DocHandle<CanvasBinDocument>;
  readonly repo: Repo;

  private constructor(repo: Repo, handle: DocHandle<CanvasBinDocument>) {
    this.repo = repo;
    this.handle = handle;
  }

  static create(repo: Repo): CanvasBinStore {
    const handle = repo.create<CanvasBinDocument>(emptyCanvasBinDoc());
    return new CanvasBinStore(repo, handle);
  }

  static async open(repo: Repo, docId: DocumentId): Promise<CanvasBinStore> {
    const handle = await repo.find<CanvasBinDocument>(docId);
    return new CanvasBinStore(repo, handle);
  }

  doc(): CanvasBinDocument {
    return this.handle.doc() ?? emptyCanvasBinDoc();
  }

  // -- layout mode / scale --------------------------------------------------

  mode(): CanvasBinMode {
    return this.doc().mode;
  }

  setMode(mode: CanvasBinMode): void {
    this.handle.change((doc) => {
      doc.mode = mode;
    });
  }

  slotScale(): CanvasBinSlotScale {
    return this.doc().slotScale;
  }

  setSlotScale(scale: CanvasBinSlotScale): void {
    this.handle.change((doc) => {
      doc.slotScale = scale;
    });
  }

  // -- tree reads -------------------------------------------------------------

  /** root-level nodes. */
  nodes(): CanvasBinNode[] {
    return this.doc().nodes ?? [];
  }

  /** children of the folder with the given id, or root nodes when
   *  `parentId` is null. returns an empty array if the folder doesn't
   *  exist (e.g. it was deleted concurrently). */
  getChildren(parentId: string | null): CanvasBinNode[] {
    if (parentId === null) return this.nodes();
    return findFolderChildren(this.nodes(), parentId) ?? [];
  }

  /** find a node anywhere in the tree by id, or null if not present. */
  findNode(id: string): CanvasBinNode | null {
    return findNodeIn(this.nodes(), id);
  }

  // -- mutations --------------------------------------------------------------

  /** create a new, empty folder under `parentId` (or at root when null).
   *  returns the new folder's id. no-op (returns "") if `parentId` doesn't
   *  resolve to an existing folder. */
  addFolder(title: string, parentId: string | null): string {
    const id = crypto.randomUUID();
    let created = false;
    this.handle.change((doc) => {
      const destArr = parentId === null ? doc.nodes : findFolderChildren(doc.nodes, parentId);
      if (!destArr) return;
      destArr.push({ kind: "folder", id, title, children: [] });
      created = true;
    });
    return created ? id : "";
  }

  /** rename an existing folder. no-op if the id doesn't exist or isn't a
   *  folder. */
  renameFolder(id: string, title: string): void {
    this.handle.change((doc) => {
      const node = findNodeIn(doc.nodes, id);
      if (node?.kind === "folder") {
        node.title = title;
      }
    });
  }

  /** remove a node by id. a folder can only be removed while empty — move
   *  or remove its contents first. returns whether the node was actually
   *  removed. */
  removeNode(id: string): boolean {
    let removed = false;
    this.handle.change((doc) => {
      const found = findContainingArray(doc.nodes, id);
      if (!found) return;
      const node = found.arr[found.index];
      if (node.kind === "folder" && node.children.length > 0) return;
      found.arr.splice(found.index, 1);
      removed = true;
    });
    return removed;
  }

  /** move a node (folder or canvas reference) to a new parent folder (or to
   *  root when `newParentId` is null). refuses (returns false, no-op) a
   *  move that would: no-op onto itself, move a folder into itself or one
   *  of its own descendants (cycle), or target a parent that doesn't exist
   *  / isn't a folder. */
  moveNode(id: string, newParentId: string | null): boolean {
    if (newParentId !== null) {
      if (isSameOrDescendant(this.nodes(), id, newParentId)) return false;
    }
    let moved = false;
    this.handle.change((doc) => {
      const found = findContainingArray(doc.nodes, id);
      if (!found) return;
      const destArr = newParentId === null ? doc.nodes : findFolderChildren(doc.nodes, newParentId);
      if (!destArr) return;
      // automerge won't let a removed proxy object be re-inserted elsewhere
      // in the same document ("cannot create a reference to an existing
      // document object") — snapshot a plain-JSON copy before splicing the
      // original out, then push the copy. safe here since nodes only ever
      // contain plain strings/arrays/objects, never automerge Text/Counter
      // values.
      const nodeCopy: CanvasBinNode = JSON.parse(JSON.stringify(found.arr[found.index]));
      found.arr.splice(found.index, 1);
      destArr.push(nodeCopy);
      moved = true;
    });
    return moved;
  }

  /** every `canvasDocId` currently referenced anywhere in the tree. */
  collectCanvasDocIds(): Set<string> {
    return collectCanvasDocIds(this.nodes());
  }

  /**
   * keep this tree in sync with the local peer's own curated profile canvas
   * list: any `ProfileCanvasEntry` not yet represented anywhere in the tree
   * gets added at root; any canvas-kind node whose `canvasDocId` is no
   * longer on the profile gets removed (wherever it's filed, including
   * inside nested folders). folders themselves are never touched by this —
   * only the leaf canvas references. call this whenever the profile doc
   * changes (e.g. on `ProfileStore.onChange()`).
   */
  reconcileWithProfile(entries: ProfileCanvasEntry[]): void {
    const validIds = new Set(entries.map((e) => e.canvasDocId));
    this.handle.change((doc) => {
      pruneCanvasNodesNotIn(doc.nodes, validIds);
      const present = collectCanvasDocIds(doc.nodes);
      for (const entry of entries) {
        if (!present.has(entry.canvasDocId)) {
          doc.nodes.push({ kind: "canvas", id: crypto.randomUUID(), canvasDocId: entry.canvasDocId });
          present.add(entry.canvasDocId);
        }
      }
    });
  }

  // -- change subscription --------------------------------------------------

  /** subscribe to document changes. returns an unsubscribe function. */
  onChange(handler: (doc: CanvasBinDocument) => void): () => void {
    const listener = () => {
      handler(this.doc());
    };
    this.handle.on("change", listener);
    return () => {
      this.handle.off("change", listener);
    };
  }
}

// ---------------------------------------------------------------------------
// "my own" canvas-bin doc — creation/discovery
// ---------------------------------------------------------------------------

/** meta-db key under which the local peer's own canvas-bin doc id is
 *  persisted — same singleton-doc-id-by-name pattern `profile-doc.ts`'s
 *  `PROFILE_DOC_KEY` (and boot.ts's narthex/social/messagez doc ids) use. */
const CANVAS_BIN_DOC_KEY = "skein-canvas-bin-doc-id";

/** read the local peer's own canvas-bin doc id, if one has already been
 *  created on this device. returns `null` if `ensureMyCanvasBinDoc()` has
 *  never been called here before. */
export async function getMyCanvasBinDocId(): Promise<DocumentId | null> {
  const id = await getMetaValue(CANVAS_BIN_DOC_KEY);
  return (id as DocumentId | null) ?? null;
}

/** get (creating if necessary) the local peer's own canvas-bin doc — same
 *  create-once-persist-the-id design as `ensureMyProfileDoc()` (see that
 *  function's doc comment in profile-doc.ts for the full reasoning: automerge-
 *  repo's `Repo.create()` always mints its own random id, so there's no way
 *  to derive one deterministically; a stored reference is the established
 *  pattern for every singleton doc in this app). */
export async function ensureMyCanvasBinDoc(repo: Repo): Promise<CanvasBinStore> {
  const existingId = await getMyCanvasBinDocId();
  if (existingId) {
    return CanvasBinStore.open(repo, existingId);
  }
  const store = CanvasBinStore.create(repo);
  await setMetaValue(CANVAS_BIN_DOC_KEY, store.handle.documentId);
  return store;
}

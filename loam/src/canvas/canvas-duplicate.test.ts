import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { WidgetRegistry } from "../widgets/widget-registry";
import type { WidgetFactory } from "../widgets/widget-types";
import { CanvasStore } from "./canvas-store";
import { duplicateCanvasDeep } from "./canvas-duplicate";

const noteSchema = z.object({ text: z.string().default("") });
const canvasCardSchema = z.object({ canvasDocId: z.string().default("") });
const binSchema = z.object({
  items: z.array(z.object({ widgetId: z.string(), slot: z.object({ col: z.number(), row: z.number() }) })).default([]),
});

function stubFactory<S extends z.ZodType>(type: string, schema: S): WidgetFactory<S> {
  return {
    type,
    schema,
    metadata: { name: type, version: "0.0.0" },
    create: () => {
      throw new Error("not needed for these tests");
    },
  };
}

function makeRegistry(): WidgetRegistry {
  const registry = new WidgetRegistry();
  registry.register(stubFactory("note", noteSchema));
  registry.register(stubFactory("canvas-card", canvasCardSchema));
  registry.register(stubFactory("bin", binSchema));
  return registry;
}

describe("duplicateCanvasDeep", () => {
  it("gives every stateful widget a brand new doc with the same content", async () => {
    const repo = createTestRepo();
    const registry = makeRegistry();

    const source = CanvasStore.create(repo);
    source.setTitle("my canvas");
    source.setDescription("a description");
    const noteHandle = repo.create({ text: "hello" });
    source.addWidget({
      id: "note-1",
      type: "note",
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: noteHandle.documentId,
      parentId: null,
    });

    const result = await duplicateCanvasDeep(repo, registry, source.handle.documentId, "peer-1");
    expect(result.newCanvasDocId).not.toBe(source.handle.documentId);
    expect(result.title).toBe("my canvas (copy)");
    expect(result.skipped).toBe(0);

    const dup = await CanvasStore.open(repo, result.newCanvasDocId as any);
    expect(dup.metadata().title).toBe("my canvas (copy)");
    expect(dup.metadata().description).toBe("a description");
    expect(dup.isAdmin("peer-1")).toBe(true);

    const widgets = dup.allWidgets();
    expect(widgets).toHaveLength(1);
    expect(widgets[0].id).not.toBe("note-1");
    expect(widgets[0].docId).not.toBe(noteHandle.documentId);
    const dupNoteDoc = await repo.find(widgets[0].docId as any);
    expect(dupNoteDoc.doc()).toEqual({ text: "hello" });
  });

  it("does not copy the original's acl/collaborators", async () => {
    const repo = createTestRepo();
    const registry = makeRegistry();
    const source = CanvasStore.create(repo);
    source.stampAdmin("original-owner");
    source.setRole("some-friend", "member");

    const result = await duplicateCanvasDeep(repo, registry, source.handle.documentId, "peer-1");
    const dup = await CanvasStore.open(repo, result.newCanvasDocId as any);
    expect(dup.isAdmin("peer-1")).toBe(true);
    expect(dup.isAdmin("original-owner")).toBe(false);
    expect(dup.getRole("some-friend")).toBe("viewer");
  });

  it("remaps bin items to the new sibling widget ids", async () => {
    const repo = createTestRepo();
    const registry = makeRegistry();
    const source = CanvasStore.create(repo);

    const childHandle = repo.create({ text: "in the bin" });
    source.addWidget({
      id: "child-1",
      type: "note",
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: childHandle.documentId,
      parentId: "bin-1",
    });
    const binHandle = repo.create({ items: [{ widgetId: "child-1", slot: { col: 0, row: 0 } }] });
    source.addWidget({
      id: "bin-1",
      type: "bin",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      zIndex: 2,
      props: {},
      collapsed: false,
      docId: binHandle.documentId,
      parentId: null,
    });

    const result = await duplicateCanvasDeep(repo, registry, source.handle.documentId, "peer-1");
    const dup = await CanvasStore.open(repo, result.newCanvasDocId as any);
    const dupBin = dup.allWidgets().find((w) => w.type === "bin")!;
    const dupChild = dup.allWidgets().find((w) => w.type === "note")!;
    expect(dupChild.parentId).toBe(dupBin.id);

    const binDocHandle = await repo.find(dupBin.docId as any);
    const binDoc = binDocHandle.doc() as { items: Array<{ widgetId: string }> };
    expect(binDoc.items).toHaveLength(1);
    expect(binDoc.items[0].widgetId).toBe(dupChild.id);
  });

  it("recursively duplicates a nested canvas-card's own target canvas", async () => {
    const repo = createTestRepo();
    const registry = makeRegistry();

    const nestedSource = CanvasStore.create(repo);
    nestedSource.setTitle("nested canvas");

    const source = CanvasStore.create(repo);
    source.setTitle("outer canvas");
    const cardHandle = repo.create({ canvasDocId: nestedSource.handle.documentId });
    source.addWidget({
      id: "card-1",
      type: "canvas-card",
      x: 0,
      y: 0,
      width: 280,
      height: 200,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: cardHandle.documentId,
      parentId: null,
    });

    const result = await duplicateCanvasDeep(repo, registry, source.handle.documentId, "peer-1");
    const dup = await CanvasStore.open(repo, result.newCanvasDocId as any);
    const dupCard = dup.allWidgets()[0];
    const dupCardDocHandle = await repo.find(dupCard.docId as any);
    const dupCardState = dupCardDocHandle.doc() as { canvasDocId: string };

    expect(dupCardState.canvasDocId).not.toBe(nestedSource.handle.documentId);
    const dupNested = await CanvasStore.open(repo, dupCardState.canvasDocId as any);
    expect(dupNested.metadata().title).toBe("nested canvas (copy)");
  });

  it("resolves a cycle (two canvases whose cards point at each other) to one shared duplicate instead of looping forever", async () => {
    const repo = createTestRepo();
    const registry = makeRegistry();

    const a = CanvasStore.create(repo);
    a.setTitle("canvas a");
    const b = CanvasStore.create(repo);
    b.setTitle("canvas b");

    const cardToBHandle = repo.create({ canvasDocId: b.handle.documentId });
    a.addWidget({
      id: "card-to-b",
      type: "canvas-card",
      x: 0,
      y: 0,
      width: 280,
      height: 200,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: cardToBHandle.documentId,
      parentId: null,
    });
    const cardToAHandle = repo.create({ canvasDocId: a.handle.documentId });
    b.addWidget({
      id: "card-to-a",
      type: "canvas-card",
      x: 0,
      y: 0,
      width: 280,
      height: 200,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: cardToAHandle.documentId,
      parentId: null,
    });

    const result = await duplicateCanvasDeep(repo, registry, a.handle.documentId, "peer-1");
    expect(result.newCanvasDocId).toBeTruthy();

    const dupA = await CanvasStore.open(repo, result.newCanvasDocId as any);
    const dupCardToB = dupA.allWidgets()[0];
    const dupCardToBHandle = await repo.find(dupCardToB.docId as any);
    const dupCardToBState = dupCardToBHandle.doc() as { canvasDocId: string };
    const dupB = await CanvasStore.open(repo, dupCardToBState.canvasDocId as any);
    expect(dupB.metadata().title).toBe("canvas b (copy)");

    const dupCardToA = dupB.allWidgets()[0];
    const dupCardToAHandle = await repo.find(dupCardToA.docId as any);
    const dupCardToAState = dupCardToAHandle.doc() as { canvasDocId: string };
    // the cycle resolves back to the SAME already-duplicated canvas a, not
    // a third, independent copy.
    expect(dupCardToAState.canvasDocId).toBe(result.newCanvasDocId);
  });

  it("skips a widget whose own doc can't be read/parsed rather than pasting an empty shell", async () => {
    const repo = createTestRepo();
    const registry = makeRegistry();
    const source = CanvasStore.create(repo);
    source.addWidget({
      id: "unreadable",
      type: "unknown-type-not-in-registry",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: "doesnt-matter-no-schema" as any,
      parentId: null,
    });

    const result = await duplicateCanvasDeep(repo, registry, source.handle.documentId, "peer-1");
    expect(result.skipped).toBe(1);
    const dup = await CanvasStore.open(repo, result.newCanvasDocId as any);
    expect(dup.allWidgets()).toHaveLength(0);
  });
});

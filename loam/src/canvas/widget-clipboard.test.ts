import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { WidgetRegistry } from "../widgets/widget-registry";
import type { WidgetFactory } from "../widgets/widget-types";
import { CanvasStore } from "./canvas-store";
import { copySelectionToClipboard, pasteClipboardIntoStore } from "./widget-clipboard";

const noteSchema = z.object({ text: z.string().default("") });
const canvasCardSchema = z.object({ canvasDocId: z.string().default(""), title: z.string().default("") });

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
  return registry;
}

describe("widget-clipboard copy/paste", () => {
  it("pastes an ordinary stateful widget as a fresh, independent doc", async () => {
    const repo = createTestRepo();
    const registry = makeRegistry();
    const store = CanvasStore.create(repo);
    store.setLocalNodeId("me");
    store.stampAdmin("me");
    const noteHandle = repo.create({ text: "hello" });
    store.addWidget({
      id: "note-1",
      type: "note",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: noteHandle.documentId,
      parentId: null,
    });

    await copySelectionToClipboard(store, registry, new Set(["note-1"]));
    const result = await pasteClipboardIntoStore(store);
    expect(result.pasted).toHaveLength(1);

    const pastedEntry = store.getWidget(result.pasted[0])!;
    expect(pastedEntry.docId).not.toBe(noteHandle.documentId);
    const pastedHandle = await repo.find(pastedEntry.docId as any);
    expect(pastedHandle.doc()).toEqual({ text: "hello" });
  });

  it("gives a pasted canvas-card its OWN independent target canvas, not a shared reference to the original", async () => {
    const repo = createTestRepo();
    const registry = makeRegistry();

    const target = CanvasStore.create(repo);
    target.setTitle("real canvas");
    target.stampAdmin("original-owner");
    target.setRole("some-friend", "member");

    const narthex = CanvasStore.create(repo);
    const cardHandle = repo.create({ canvasDocId: target.handle.documentId, title: "real canvas" });
    narthex.addWidget({
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

    await copySelectionToClipboard(narthex, registry, new Set(["card-1"]));
    narthex.setLocalNodeId("me");
    narthex.stampAdmin("me");
    const result = await pasteClipboardIntoStore(narthex);
    expect(result.pasted).toHaveLength(1);

    const pastedCardEntry = narthex.getWidget(result.pasted[0])!;
    const pastedCardHandle = await repo.find(pastedCardEntry.docId as any);
    const pastedCardState = pastedCardHandle.doc() as { canvasDocId: string; title: string };

    // the pasted card must point at a DIFFERENT canvas doc than the
    // original — this is the exact bug being guarded against: editing
    // "the copy" must never touch the original canvas's real widgets.
    expect(pastedCardState.canvasDocId).not.toBe(target.handle.documentId);
    expect(pastedCardState.title).toBe("real canvas (copy)");

    const duplicatedCanvas = await CanvasStore.open(repo, pastedCardState.canvasDocId as any);
    expect(duplicatedCanvas.metadata().title).toBe("real canvas (copy)");
    // acl must NOT be copied over — a fresh, private duplicate, never
    // silently inheriting the original's collaborator list.
    expect(duplicatedCanvas.isAdmin("original-owner")).toBe(false);
    expect(duplicatedCanvas.getRole("some-friend")).toBe("viewer");

    // and the ORIGINAL canvas must be completely untouched by any of this.
    expect(target.metadata().title).toBe("real canvas");
    expect(target.isAdmin("original-owner")).toBe(true);
  });

  it("preserves a regular-canvas-only widget type (not present in narthex's own narrower registry) when duplicating via paste", async () => {
    // regression test for a real, live bug: pasteOne()'s canvas-card
    // special case used to receive whatever registry the CURRENT canvas
    // happens to use — for a card copy/pasted while sitting on narthex,
    // that's `createNarthexRegistry()`, a deliberately narrow subset (see
    // its own doc comment) that doesn't know about "canvas-info" (or
    // animaniac/doodle/image/etc) at all. every widget of a type missing
    // from whatever registry was used got silently skipped, so a
    // duplicated real-content canvas came back blank. it must now ALWAYS
    // use the full, regular-canvas registry (`createTestRegistry()`)
    // internally, regardless of which canvas the triggering card lives on.
    const repo = createTestRepo();
    const registry = makeRegistry();

    const target = CanvasStore.create(repo);
    target.setTitle("real canvas");
    const infoHandle = repo.create({});
    target.addWidget({
      id: "info-1",
      type: "canvas-info",
      x: 0,
      y: 0,
      width: 280,
      height: 340,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: infoHandle.documentId,
      parentId: null,
    });

    const narthex = CanvasStore.create(repo);
    narthex.setLocalNodeId("me");
    narthex.stampAdmin("me");
    const cardHandle = repo.create({ canvasDocId: target.handle.documentId, title: "real canvas" });
    narthex.addWidget({
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

    await copySelectionToClipboard(narthex, registry, new Set(["card-1"]));
    const result = await pasteClipboardIntoStore(narthex);
    const pastedCardEntry = narthex.getWidget(result.pasted[0])!;
    const pastedCardState = (await repo.find(pastedCardEntry.docId as any)).doc() as { canvasDocId: string };

    const duplicatedCanvas = await CanvasStore.open(repo, pastedCardState.canvasDocId as any);
    const duplicatedWidgets = duplicatedCanvas.allWidgets();
    expect(duplicatedWidgets).toHaveLength(1);
    expect(duplicatedWidgets[0].type).toBe("canvas-info");
    expect(duplicatedWidgets[0].docId).not.toBe(infoHandle.documentId);
  });
});

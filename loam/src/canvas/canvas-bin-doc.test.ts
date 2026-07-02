import { beforeEach, describe, expect, it } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { CanvasBinStore, emptyCanvasBinDoc } from "./canvas-bin-doc";

describe("emptyCanvasBinDoc", () => {
  it("returns grid mode, medium scale, and no nodes", () => {
    const doc = emptyCanvasBinDoc();
    expect(doc.mode).toBe("grid");
    expect(doc.slotScale).toBe("m");
    expect(doc.nodes).toEqual([]);
  });

  it("returns a new object each time", () => {
    const a = emptyCanvasBinDoc();
    const b = emptyCanvasBinDoc();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("CanvasBinStore", () => {
  let store: CanvasBinStore;

  beforeEach(() => {
    const repo = createTestRepo();
    store = CanvasBinStore.create(repo);
  });

  describe("create", () => {
    it("starts with an empty tree", () => {
      expect(store.mode()).toBe("grid");
      expect(store.slotScale()).toBe("m");
      expect(store.nodes()).toEqual([]);
    });
  });

  describe("mode / slotScale", () => {
    it("setMode updates the document", () => {
      store.setMode("shelf");
      expect(store.mode()).toBe("shelf");
    });

    it("setSlotScale updates the document", () => {
      store.setSlotScale("l");
      expect(store.slotScale()).toBe("l");
    });
  });

  describe("addFolder", () => {
    it("adds a root folder and returns its id", () => {
      const id = store.addFolder("music", null);
      expect(id).not.toBe("");
      const nodes = store.nodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({ kind: "folder", title: "music", children: [] });
      expect(nodes[0].id).toBe(id);
    });

    it("adds a nested folder inside an existing folder", () => {
      const parentId = store.addFolder("music", null);
      const childId = store.addFolder("rock", parentId);
      expect(childId).not.toBe("");

      const children = store.getChildren(parentId);
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ kind: "folder", title: "rock" });
      expect(children[0].id).toBe(childId);
    });

    it("supports arbitrarily deep nesting", () => {
      const a = store.addFolder("a", null);
      const b = store.addFolder("b", a);
      const c = store.addFolder("c", b);
      const d = store.addFolder("d", c);

      expect(store.getChildren(c)).toHaveLength(1);
      expect(store.getChildren(c)[0].id).toBe(d);
      expect(store.findNode(d)).toMatchObject({ kind: "folder", title: "d" });
    });

    it("no-ops and returns empty string when the parent doesn't exist", () => {
      const id = store.addFolder("orphan", "nonexistent-id");
      expect(id).toBe("");
      expect(store.nodes()).toEqual([]);
    });

    it("no-ops when the parent id resolves to a canvas node, not a folder", () => {
      store.reconcileWithProfile([
        { canvasDocId: "c1", title: "canvas one", addedAt: new Date().toISOString() },
      ]);
      const canvasNodeId = store.nodes()[0].id;
      const id = store.addFolder("nope", canvasNodeId);
      expect(id).toBe("");
    });
  });

  describe("renameFolder", () => {
    it("renames an existing folder", () => {
      const id = store.addFolder("old name", null);
      store.renameFolder(id, "new name");
      expect(store.findNode(id)).toMatchObject({ title: "new name" });
    });

    it("no-ops for a nonexistent id", () => {
      store.renameFolder("nope", "new name");
      expect(store.nodes()).toEqual([]);
    });
  });

  describe("removeNode", () => {
    it("removes an empty folder", () => {
      const id = store.addFolder("empty", null);
      const removed = store.removeNode(id);
      expect(removed).toBe(true);
      expect(store.nodes()).toEqual([]);
    });

    it("refuses to remove a non-empty folder", () => {
      const parentId = store.addFolder("parent", null);
      store.addFolder("child", parentId);
      const removed = store.removeNode(parentId);
      expect(removed).toBe(false);
      expect(store.findNode(parentId)).not.toBeNull();
    });

    it("removes a canvas node", () => {
      store.reconcileWithProfile([
        { canvasDocId: "c1", title: "canvas one", addedAt: new Date().toISOString() },
      ]);
      const nodeId = store.nodes()[0].id;
      const removed = store.removeNode(nodeId);
      expect(removed).toBe(true);
      expect(store.nodes()).toEqual([]);
    });

    it("removes a deeply nested node", () => {
      const a = store.addFolder("a", null);
      const b = store.addFolder("b", a);
      const removed = store.removeNode(b);
      expect(removed).toBe(true);
      expect(store.getChildren(a)).toEqual([]);
    });

    it("returns false for a nonexistent id", () => {
      expect(store.removeNode("nope")).toBe(false);
    });
  });

  describe("moveNode", () => {
    it("moves a canvas node from root into a folder", () => {
      const folderId = store.addFolder("music", null);
      store.reconcileWithProfile([
        { canvasDocId: "c1", title: "canvas one", addedAt: new Date().toISOString() },
      ]);
      const canvasNodeId = store.nodes().find((n) => n.kind === "canvas")!.id;

      const moved = store.moveNode(canvasNodeId, folderId);
      expect(moved).toBe(true);

      expect(store.getChildren(folderId)).toHaveLength(1);
      expect(store.getChildren(folderId)[0].id).toBe(canvasNodeId);
      // no longer at root
      expect(store.nodes().some((n) => n.id === canvasNodeId)).toBe(false);
    });

    it("moves a node back out to root", () => {
      const folderId = store.addFolder("music", null);
      const childId = store.addFolder("rock", folderId);

      const moved = store.moveNode(childId, null);
      expect(moved).toBe(true);
      expect(store.getChildren(folderId)).toEqual([]);
      expect(store.nodes().some((n) => n.id === childId)).toBe(true);
    });

    it("moves a folder (with its contents) into another folder", () => {
      const a = store.addFolder("a", null);
      const b = store.addFolder("b", null);
      const nested = store.addFolder("nested", a);

      const moved = store.moveNode(a, b);
      expect(moved).toBe(true);
      expect(store.getChildren(b)).toHaveLength(1);
      expect(store.getChildren(b)[0].id).toBe(a);
      // the folder's own contents travel with it
      expect(store.getChildren(a)).toHaveLength(1);
      expect(store.getChildren(a)[0].id).toBe(nested);
    });

    it("refuses to move a folder into itself", () => {
      const a = store.addFolder("a", null);
      const moved = store.moveNode(a, a);
      expect(moved).toBe(false);
    });

    it("refuses to move a folder into its own descendant (cycle prevention)", () => {
      const a = store.addFolder("a", null);
      const b = store.addFolder("b", a);
      const c = store.addFolder("c", b);

      const moved = store.moveNode(a, c);
      expect(moved).toBe(false);
      // tree unchanged
      expect(store.nodes().some((n) => n.id === a)).toBe(true);
      expect(store.getChildren(a)[0].id).toBe(b);
    });

    it("no-ops when the target parent doesn't exist", () => {
      const a = store.addFolder("a", null);
      const moved = store.moveNode(a, "nonexistent");
      expect(moved).toBe(false);
    });

    it("returns false for a nonexistent node id", () => {
      const folderId = store.addFolder("music", null);
      expect(store.moveNode("nope", folderId)).toBe(false);
    });
  });

  describe("collectCanvasDocIds", () => {
    it("collects canvas doc ids from every nesting level", () => {
      const folderId = store.addFolder("music", null);
      store.reconcileWithProfile([
        { canvasDocId: "c1", title: "one", addedAt: new Date().toISOString() },
        { canvasDocId: "c2", title: "two", addedAt: new Date().toISOString() },
      ]);
      const c2Node = store.nodes().find((n) => n.kind === "canvas" && n.canvasDocId === "c2")!;
      store.moveNode(c2Node.id, folderId);

      expect(store.collectCanvasDocIds()).toEqual(new Set(["c1", "c2"]));
    });
  });

  describe("reconcileWithProfile", () => {
    it("adds a root entry for each profile canvas not yet in the tree", () => {
      store.reconcileWithProfile([
        { canvasDocId: "c1", title: "one", addedAt: new Date().toISOString() },
        { canvasDocId: "c2", title: "two", addedAt: new Date().toISOString() },
      ]);
      const nodes = store.nodes();
      expect(nodes).toHaveLength(2);
      expect(nodes.map((n) => (n.kind === "canvas" ? n.canvasDocId : null)).sort()).toEqual([
        "c1",
        "c2",
      ]);
    });

    it("is idempotent — running it again with the same entries adds nothing new", () => {
      const entries = [{ canvasDocId: "c1", title: "one", addedAt: new Date().toISOString() }];
      store.reconcileWithProfile(entries);
      store.reconcileWithProfile(entries);
      expect(store.nodes()).toHaveLength(1);
    });

    it("does not duplicate or move an entry that was already filed into a folder", () => {
      const folderId = store.addFolder("music", null);
      store.reconcileWithProfile([
        { canvasDocId: "c1", title: "one", addedAt: new Date().toISOString() },
      ]);
      const nodeId = store.nodes().find((n) => n.kind === "canvas")!.id;
      store.moveNode(nodeId, folderId);

      // re-run reconcile with the same entry still present
      store.reconcileWithProfile([
        { canvasDocId: "c1", title: "one", addedAt: new Date().toISOString() },
      ]);

      // still filed in the folder, not duplicated at root
      expect(store.nodes().filter((n) => n.kind === "canvas")).toHaveLength(0);
      expect(store.getChildren(folderId)).toHaveLength(1);
    });

    it("removes a canvas node (wherever filed) when it's no longer on the profile", () => {
      const folderId = store.addFolder("music", null);
      store.reconcileWithProfile([
        { canvasDocId: "c1", title: "one", addedAt: new Date().toISOString() },
        { canvasDocId: "c2", title: "two", addedAt: new Date().toISOString() },
      ]);
      const c1Node = store.nodes().find((n) => n.kind === "canvas" && n.canvasDocId === "c1")!;
      store.moveNode(c1Node.id, folderId);

      // c1 removed from the profile entirely
      store.reconcileWithProfile([
        { canvasDocId: "c2", title: "two", addedAt: new Date().toISOString() },
      ]);

      expect(store.collectCanvasDocIds()).toEqual(new Set(["c2"]));
      // the folder itself survives, now empty
      expect(store.findNode(folderId)).not.toBeNull();
      expect(store.getChildren(folderId)).toEqual([]);
    });

    it("leaves folders in place even when they end up empty", () => {
      const folderId = store.addFolder("keep me", null);
      store.reconcileWithProfile([]);
      expect(store.findNode(folderId)).not.toBeNull();
    });
  });

  describe("onChange", () => {
    it("notifies subscribers on mutation", () => {
      let calls = 0;
      const unsub = store.onChange(() => {
        calls++;
      });
      store.addFolder("music", null);
      expect(calls).toBeGreaterThan(0);
      unsub();
    });

    it("stops notifying after unsubscribe", () => {
      let calls = 0;
      const unsub = store.onChange(() => {
        calls++;
      });
      unsub();
      const before = calls;
      store.addFolder("music", null);
      expect(calls).toBe(before);
    });
  });
});

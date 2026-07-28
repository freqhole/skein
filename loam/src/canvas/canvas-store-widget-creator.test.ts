import { beforeEach, describe, expect, it } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { resetEntryCounter, widgetEntry } from "../test-helpers/canvas-fixtures";
import { CanvasStore } from "./canvas-store";

describe("CanvasStore widget creator tracking", () => {
  let store: CanvasStore;

  beforeEach(() => {
    resetEntryCounter();
    const repo = createTestRepo();
    store = CanvasStore.create(repo);
  });

  it("stamps createdBy from the local node id on addWidget", () => {
    store.setLocalNodeId("node-a");
    store.addWidget(widgetEntry({ id: "w1" }));
    expect(store.getWidget("w1")!.createdBy).toBe("node-a");
  });

  it("does not overwrite an explicitly provided createdBy", () => {
    store.setLocalNodeId("node-a");
    store.addWidget(widgetEntry({ id: "w1", createdBy: "node-b" }));
    expect(store.getWidget("w1")!.createdBy).toBe("node-b");
  });

  it("leaves createdBy unset when no local node id has been set", () => {
    store.addWidget(widgetEntry({ id: "w1" }));
    expect(store.getWidget("w1")!.createdBy).toBeUndefined();
  });

  describe("isLocalWidgetCreator", () => {
    it("returns true for the peer who created the widget", () => {
      store.setLocalNodeId("node-a");
      store.addWidget(widgetEntry({ id: "w1" }));
      expect(store.isLocalWidgetCreator("w1")).toBe(true);
    });

    it("returns false for a different peer", () => {
      store.setLocalNodeId("node-a");
      store.addWidget(widgetEntry({ id: "w1" }));
      store.setLocalNodeId("node-b");
      expect(store.isLocalWidgetCreator("w1")).toBe(false);
    });

    it("returns true (unrestricted) for a widget with no createdBy stamped", () => {
      store.addWidget(widgetEntry({ id: "w1" }));
      store.setLocalNodeId("node-b");
      expect(store.isLocalWidgetCreator("w1")).toBe(true);
    });

    it("returns true (unrestricted) for a nonexistent widget", () => {
      store.setLocalNodeId("node-a");
      expect(store.isLocalWidgetCreator("nonexistent")).toBe(true);
    });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { emptyProfileDoc, ProfileStore } from "./profile-doc";

describe("emptyProfileDoc", () => {
  it("returns empty strings and an empty canvas list", () => {
    const doc = emptyProfileDoc();
    expect(doc.username).toBe("");
    expect(doc.bio).toBe("");
    expect(doc.avatarDataUrl).toBe("");
    expect(doc.canvases).toEqual([]);
  });

  it("returns a new object each time", () => {
    const a = emptyProfileDoc();
    const b = emptyProfileDoc();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("ProfileStore", () => {
  let store: ProfileStore;

  beforeEach(() => {
    const repo = createTestRepo();
    store = ProfileStore.create(repo);
  });

  describe("create", () => {
    it("starts with an empty document", () => {
      expect(store.username()).toBe("");
      expect(store.bio()).toBe("");
      expect(store.avatarDataUrl()).toBe("");
      expect(store.canvases()).toEqual([]);
    });
  });

  describe("username / bio / avatarDataUrl", () => {
    it("setUsername updates the document", () => {
      store.setUsername("alice");
      expect(store.username()).toBe("alice");
    });

    it("setBio updates the document", () => {
      store.setBio("hi, i'm alice");
      expect(store.bio()).toBe("hi, i'm alice");
    });

    it("setAvatarDataUrl updates the document", () => {
      store.setAvatarDataUrl("data:image/png;base64,abc123");
      expect(store.avatarDataUrl()).toBe("data:image/png;base64,abc123");
    });
  });

  describe("addCanvasToProfile / removeCanvasFromProfile", () => {
    it("adds a new canvas entry with addedAt set", () => {
      store.addCanvasToProfile({ canvasDocId: "canvas-1", title: "my canvas" });
      const entries = store.canvases();
      expect(entries).toHaveLength(1);
      expect(entries[0].canvasDocId).toBe("canvas-1");
      expect(entries[0].title).toBe("my canvas");
      expect(entries[0].addedAt).toBeTruthy();
    });

    it("is idempotent by canvasDocId — adding twice updates in place, not a duplicate", () => {
      store.addCanvasToProfile({ canvasDocId: "canvas-1", title: "first title" });
      const firstAddedAt = store.canvases()[0].addedAt;

      store.addCanvasToProfile({
        canvasDocId: "canvas-1",
        title: "updated title",
        description: "new description",
        color: 0x06b6d4,
        previewUrl: "data:image/png;base64,xyz",
      });

      const entries = store.canvases();
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe("updated title");
      expect(entries[0].description).toBe("new description");
      expect(entries[0].color).toBe(0x06b6d4);
      expect(entries[0].previewUrl).toBe("data:image/png;base64,xyz");
      // addedAt is preserved from the first add, not reset on update
      expect(entries[0].addedAt).toBe(firstAddedAt);
    });

    it("supports multiple distinct canvas entries", () => {
      store.addCanvasToProfile({ canvasDocId: "canvas-1", title: "one" });
      store.addCanvasToProfile({ canvasDocId: "canvas-2", title: "two" });
      expect(store.canvases().map((c) => c.canvasDocId).sort()).toEqual(["canvas-1", "canvas-2"]);
    });

    it("removeCanvasFromProfile removes the entry", () => {
      store.addCanvasToProfile({ canvasDocId: "canvas-1", title: "one" });
      store.addCanvasToProfile({ canvasDocId: "canvas-2", title: "two" });
      store.removeCanvasFromProfile("canvas-1");
      expect(store.canvases().map((c) => c.canvasDocId)).toEqual(["canvas-2"]);
    });

    it("removeCanvasFromProfile is a no-op for a nonexistent entry", () => {
      store.addCanvasToProfile({ canvasDocId: "canvas-1", title: "one" });
      store.removeCanvasFromProfile("nonexistent");
      expect(store.canvases()).toHaveLength(1);
    });

    it("removeCanvasFromProfile on an empty list does not throw", () => {
      expect(() => store.removeCanvasFromProfile("canvas-1")).not.toThrow();
    });
  });

  describe("canvases — defensive read against malformed synced data", () => {
    it("drops entries missing required fields, keeping the well-formed ones", () => {
      store.addCanvasToProfile({ canvasDocId: "canvas-1", title: "good entry" });
      store.handle.change((doc) => {
        // simulate a malformed entry that could arrive from a stale/buggy
        // peer once this doc is synced — missing the required `title` field.
        (doc.canvases as any[]).push({ canvasDocId: "canvas-2" });
      });

      const entries = store.canvases();
      expect(entries).toHaveLength(1);
      expect(entries[0].canvasDocId).toBe("canvas-1");
    });

    it("drops entries with wrong field types", () => {
      store.addCanvasToProfile({ canvasDocId: "canvas-1", title: "good entry" });
      store.handle.change((doc) => {
        (doc.canvases as any[]).push({ canvasDocId: "canvas-2", title: 12345, addedAt: "" });
      });

      const entries = store.canvases();
      expect(entries).toHaveLength(1);
      expect(entries[0].canvasDocId).toBe("canvas-1");
    });

    it("returns an empty list rather than throwing when all entries are malformed", () => {
      store.handle.change((doc) => {
        (doc.canvases as any[]).push({ nonsense: true });
      });
      expect(() => store.canvases()).not.toThrow();
      expect(store.canvases()).toEqual([]);
    });
  });

  describe("access control", () => {
    it("getRole defaults to viewer for a node id with no acl entry", () => {
      expect(store.getRole("z".repeat(64))).toBe("viewer");
    });

    it("grantViewerRole writes an explicit viewer entry", () => {
      const nodeId = "a".repeat(64);
      store.grantViewerRole(nodeId);
      expect(store.getRole(nodeId)).toBe("viewer");
      expect(store.doc().acl?.[nodeId]?.role).toBe("viewer");
    });

    it("revokeRole removes the acl entry, falling back to the default", () => {
      const nodeId = "a".repeat(64);
      store.grantViewerRole(nodeId);
      store.revokeRole(nodeId);
      expect(store.doc().acl?.[nodeId]).toBeUndefined();
      expect(store.getRole(nodeId)).toBe("viewer");
    });

    it("revokeRole is a no-op for a node id with no entry", () => {
      expect(() => store.revokeRole("nonexistent")).not.toThrow();
    });

    it("getRole falls back to viewer for an unrecognized role value (defensive read)", () => {
      const nodeId = "a".repeat(64);
      store.handle.change((doc) => {
        if (!doc.acl) doc.acl = {};
        (doc.acl as any)[nodeId] = { role: "owner" }; // pre-rename/garbage value
      });
      expect(store.getRole(nodeId)).toBe("viewer");
    });
  });

  describe("onChange", () => {
    it("fires the handler on a document change", () => {
      let fired = 0;
      const unsubscribe = store.onChange(() => {
        fired++;
      });
      store.setUsername("bob");
      expect(fired).toBeGreaterThan(0);
      unsubscribe();
    });

    it("stops firing after unsubscribe", () => {
      let fired = 0;
      const unsubscribe = store.onChange(() => {
        fired++;
      });
      unsubscribe();
      store.setUsername("carol");
      expect(fired).toBe(0);
    });
  });

  describe("open", () => {
    it("re-opens an existing profile doc by id with the same content", async () => {
      const repo = createTestRepo();
      const original = ProfileStore.create(repo);
      original.setUsername("dave");
      original.addCanvasToProfile({ canvasDocId: "canvas-1", title: "dave's canvas" });

      const reopened = await ProfileStore.open(repo, original.handle.documentId);
      expect(reopened.username()).toBe("dave");
      expect(reopened.canvases()).toHaveLength(1);
    });
  });
});

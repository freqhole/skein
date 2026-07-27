import { Repo } from "@automerge/automerge-repo";
import { describe, expect, it } from "vitest";
import { createWidgetDoc } from "../../src/widgets/widget-doc";
import { canvasCardSchema, canvasCardWidget } from "./canvas-card";

describe("canvasCardSchema", () => {
  it("parses empty object with defaults", () => {
    const result = canvasCardSchema.parse({});
    expect(result).toEqual({
      canvasDocId: "",
      title: "untitled canvas",
      description: "",
      previewUrl: "",
      createdAt: "",
      modifiedAt: "",
      authorName: "",
      color: 0xd946ef,
      isRemote: false,
      ownerNodeId: "",
      ownerUsername: "",
      ownerAvatarDataUrl: "",
      role: "admin",
      accessRevoked: false,
      accessPending: false,
      accessRequestedAt: "",
      accessDeclined: false,
      hubNodeIds: [],
      hubConnectRequestedAt: "",
      lastVisitedAt: "",
      hasUpdates: false,
      lastKnownModifiedAt: "",
      lastModifiedBy: "",
      isDeleted: false,
      deletedAt: "",
      deletedBy: "",
      deleteMode: "",
    });
  });

  it("accepts valid overrides", () => {
    const result = canvasCardSchema.parse({
      canvasDocId: "doc-abc123",
      title: "my cool canvas",
      authorName: "bob",
      color: 0x06b6d4,
    });
    expect(result.canvasDocId).toBe("doc-abc123");
    expect(result.title).toBe("my cool canvas");
    expect(result.authorName).toBe("bob");
    expect(result.color).toBe(0x06b6d4);
    // defaults for the rest
    expect(result.description).toBe("");
    expect(result.previewUrl).toBe("");
    expect(result.createdAt).toBe("");
    expect(result.modifiedAt).toBe("");
  });

  it("fills in missing fields with defaults", () => {
    const result = canvasCardSchema.parse({ title: "test" });
    expect(result.title).toBe("test");
    expect(result.canvasDocId).toBe("");
    expect(result.description).toBe("");
    expect(result.previewUrl).toBe("");
    expect(result.createdAt).toBe("");
    expect(result.modifiedAt).toBe("");
    expect(result.authorName).toBe("");
    expect(result.color).toBe(0xd946ef);
  });

  it("rejects non-string canvasDocId", () => {
    expect(() => canvasCardSchema.parse({ canvasDocId: 42 })).toThrow();
  });

  it("rejects non-number color", () => {
    expect(() => canvasCardSchema.parse({ color: "red" })).toThrow();
  });

  it("accepts hasUpdates and lastKnownModifiedAt fields", () => {
    const result = canvasCardSchema.parse({
      hasUpdates: true,
      lastKnownModifiedAt: "2025-01-15T12:00:00Z",
    });
    expect(result.hasUpdates).toBe(true);
    expect(result.lastKnownModifiedAt).toBe("2025-01-15T12:00:00Z");
  });
});

describe("canvasCardSchema props seeding", () => {
  it("seeds correctly from router-style props", () => {
    const props = {
      canvasDocId: "test-doc-abc123",
      title: "my canvas",
      description: "a test canvas",
      authorName: "alice",
      color: 0x06b6d4,
      createdAt: "2025-01-15",
      modifiedAt: "2025-01-15",
    };
    const result = canvasCardSchema.parse(props);
    expect(result.canvasDocId).toBe("test-doc-abc123");
    expect(result.title).toBe("my canvas");
    expect(result.description).toBe("a test canvas");
    expect(result.authorName).toBe("alice");
    expect(result.color).toBe(0x06b6d4);
    expect(result.createdAt).toBe("2025-01-15");
  });

  it("seeds correctly from empty props", () => {
    const result = canvasCardSchema.parse({});
    expect(result.canvasDocId).toBe("");
    expect(result.title).toBe("untitled canvas");
    expect(result.description).toBe("");
    expect(result.previewUrl).toBe("");
    expect(result.createdAt).toBe("");
    expect(result.modifiedAt).toBe("");
    expect(result.authorName).toBe("");
    expect(result.color).toBe(0xd946ef);
  });

  it("seeds correctly from partial props", () => {
    const result = canvasCardSchema.parse({ title: "partial" });
    expect(result.title).toBe("partial");
    expect(result.canvasDocId).toBe("");
    expect(result.description).toBe("");
    expect(result.previewUrl).toBe("");
    expect(result.createdAt).toBe("");
    expect(result.modifiedAt).toBe("");
    expect(result.authorName).toBe("");
    expect(result.color).toBe(0xd946ef);
  });

  it("seeds correctly from null/undefined props", () => {
    const fromUndefined = canvasCardSchema.parse(undefined ?? {});
    expect(fromUndefined.canvasDocId).toBe("");
    expect(fromUndefined.title).toBe("untitled canvas");
    expect(fromUndefined.color).toBe(0xd946ef);

    const fromNull = canvasCardSchema.parse(null ?? {});
    expect(fromNull.canvasDocId).toBe("");
    expect(fromNull.title).toBe("untitled canvas");
    expect(fromNull.color).toBe(0xd946ef);
  });
});

describe("remote canvas card schema", () => {
  it("parses remote card with all new fields", () => {
    const result = canvasCardSchema.parse({
      canvasDocId: "remote-doc-123",
      title: "shared canvas",
      isRemote: true,
      ownerNodeId: "node-abc123def456",
      ownerUsername: "alice",
      role: "member",
      accessRevoked: false,
      lastVisitedAt: "2025-06-01T12:00:00Z",
    });
    expect(result.isRemote).toBe(true);
    expect(result.ownerNodeId).toBe("node-abc123def456");
    expect(result.ownerUsername).toBe("alice");
    expect(result.role).toBe("member");
    expect(result.accessRevoked).toBe(false);
    expect(result.lastVisitedAt).toBe("2025-06-01T12:00:00Z");
  });

  it("defaults for new fields when omitted", () => {
    const result = canvasCardSchema.parse({ title: "test" });
    expect(result.isRemote).toBe(false);
    expect(result.ownerNodeId).toBe("");
    expect(result.ownerUsername).toBe("");
    expect(result.role).toBe("admin");
    expect(result.accessRevoked).toBe(false);
    expect(result.lastVisitedAt).toBe("");
  });

  it("rejects invalid role values", () => {
    expect(() => canvasCardSchema.parse({ role: "owner" })).toThrow();
    expect(() => canvasCardSchema.parse({ role: 42 })).toThrow();
  });

  it("migrates pre-rename role names on an existing doc instead of blanking it", () => {
    // "owner"/"editor" were the pre-rename role names (replaced by
    // admin/member/viewer) - canvas-card docs written before the rename can
    // still carry one of these, and automerge docs are never migrated in
    // place on their own. without a repair pass, widget-doc.ts would discard
    // the entire cached state (not just role) the moment this field fails
    // to parse - canvasCardWidget.migrate fixes the raw doc directly instead.
    const repo = new Repo({});
    const handle = repo.create<Record<string, unknown>>({
      canvasDocId: "legacy-doc-123",
      title: "legacy canvas",
      isRemote: true,
      role: "owner",
    });

    const widgetDoc = createWidgetDoc(canvasCardSchema, handle, canvasCardWidget.migrate);

    expect(widgetDoc.current.canvasDocId).toBe("legacy-doc-123");
    expect(widgetDoc.current.title).toBe("legacy canvas");
    expect(widgetDoc.current.role).toBe("admin");
    // the underlying doc itself was repaired, not just the parsed view.
    expect((handle.doc() as { role: string }).role).toBe("admin");
  });

  it("parses hub node ids carried over from a share link", () => {
    const result = canvasCardSchema.parse({
      canvasDocId: "remote-doc-with-hub",
      isRemote: true,
      accessPending: true,
      hubNodeIds: ["hub-node-abc"],
    });
    expect(result.hubNodeIds).toEqual(["hub-node-abc"]);
    expect(result.hubConnectRequestedAt).toBe("");
  });

  it("defaults hubNodeIds to an empty array when omitted", () => {
    const result = canvasCardSchema.parse({ title: "test" });
    expect(result.hubNodeIds).toEqual([]);
    expect(result.hubConnectRequestedAt).toBe("");
  });

  it("backwards compatibility — old-style object gets correct defaults", () => {
    const oldStyleProps = {
      canvasDocId: "doc-old-123",
      title: "legacy canvas",
      description: "created before P2P",
      previewUrl: "",
      createdAt: "2024-01-01",
      modifiedAt: "2024-06-15",
      authorName: "bob",
      color: 0x06b6d4,
    };
    const result = canvasCardSchema.parse(oldStyleProps);
    // old fields preserved
    expect(result.canvasDocId).toBe("doc-old-123");
    expect(result.title).toBe("legacy canvas");
    expect(result.authorName).toBe("bob");
    expect(result.color).toBe(0x06b6d4);
    // new fields get defaults
    expect(result.isRemote).toBe(false);
    expect(result.ownerNodeId).toBe("");
    expect(result.ownerUsername).toBe("");
    expect(result.role).toBe("admin");
    expect(result.accessRevoked).toBe(false);
    expect(result.lastVisitedAt).toBe("");
  });
});

describe("canvasCardWidget", () => {
  it("has correct type", () => {
    expect(canvasCardWidget.type).toBe("canvas-card");
  });

  it("is hidden from palette", () => {
    expect(canvasCardWidget.metadata.hidden).toBe(true);
  });

  it("has editableProps", () => {
    expect(canvasCardWidget.editableProps).toHaveLength(3);
    const keys = canvasCardWidget.editableProps.map((p) => p.key);
    expect(keys).toEqual(["description", "color", "previewUrl"]);
  });

  it("previewUrl prop is an image type", () => {
    const previewProp = canvasCardWidget.editableProps!.find((p) => p.key === "previewUrl");
    expect(previewProp).toBeDefined();
    expect(previewProp!.type).toBe("image");
    expect(previewProp!.imageMaxWidth).toBe(320);
    expect(previewProp!.imageMaxHeight).toBe(200);
  });

  it("has a schema", () => {
    expect(canvasCardWidget.schema).toBe(canvasCardSchema);
  });
});

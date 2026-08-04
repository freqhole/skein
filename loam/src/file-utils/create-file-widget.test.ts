// ---------------------------------------------------------------------------
// unit tests for createFileWidgetFromBlob — mocks getLocalNodeId,
// getThumbnailDataUrl, and addBlobCanvasRef (the upstream data sources),
// but uses a real in-memory automerge repo + real CanvasStore so the
// widget-entry shape and the new widget doc's fields are exercised for
// real, mirroring unregister-blob.test.ts's approach.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { CanvasStore } from "../canvas/canvas-store";

const mockGetLocalNodeId = vi.fn<() => Promise<string | null>>(async () => "node-a");
vi.mock("./file-shared", () => ({
  getLocalNodeId: (...args: any[]) => mockGetLocalNodeId(...args),
}));

const mockGetThumbnailDataUrl = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock("./thumbnail-utils", () => ({
  getThumbnailDataUrl: (...args: any[]) => mockGetThumbnailDataUrl(...args),
}));

const mockAddBlobCanvasRef = vi.fn<() => Promise<void>>(async () => {});
vi.mock("./blob-canvas-refs", () => ({
  addBlobCanvasRef: (...args: any[]) => mockAddBlobCanvasRef(...args),
}));

import { createFileWidgetFromBlob } from "./create-file-widget";

describe("createFileWidgetFromBlob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocalNodeId.mockResolvedValue("node-a");
    mockGetThumbnailDataUrl.mockResolvedValue(null);
    mockAddBlobCanvasRef.mockResolvedValue(undefined);
  });

  it("creates a file widget doc with the blob's metadata, classified domain, and local node id in snatchedBy", async () => {
    const repo = createTestRepo();
    const store = CanvasStore.create(repo);

    const widgetId = await createFileWidgetFromBlob(repo, store, {
      blobId: "blob-1",
      blake3: "blake3-1",
      filename: "song.mp3",
      mime: "audio/mpeg",
      size: 12345,
      x: 42,
      y: 84,
    });

    const entry = store.getWidget(widgetId);
    expect(entry).toMatchObject({
      id: widgetId,
      type: "file",
      x: 42,
      y: 84,
      width: 280,
      height: 200,
      docId: expect.any(String),
      parentId: null,
    });

    const widgetHandle = await repo.find(entry!.docId as any);
    await widgetHandle.whenReady();
    expect(widgetHandle.doc()).toMatchObject({
      blobId: "blob-1",
      blake3: "blake3-1",
      filename: "song.mp3",
      mime: "audio/mpeg",
      size: 12345,
      domain: "audio",
      snatchedBy: ["node-a"],
    });
  });

  it("registers a blob-canvas ref for the new canvas", async () => {
    const repo = createTestRepo();
    const store = CanvasStore.create(repo);

    await createFileWidgetFromBlob(repo, store, {
      blobId: "blob-1",
      blake3: "blake3-1",
      mime: "text/plain",
    });

    expect(mockAddBlobCanvasRef).toHaveBeenCalledWith(
      "blob-1",
      "blake3-1",
      store.handle.documentId
    );
  });

  it("places the new widget above every existing widget's zIndex", async () => {
    const repo = createTestRepo();
    const store = CanvasStore.create(repo);
    store.addWidget({
      id: "existing",
      type: "file",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 7,
      props: {},
      collapsed: false,
      docId: null,
    });

    const widgetId = await createFileWidgetFromBlob(repo, store, {
      blobId: "blob-1",
      mime: "text/plain",
    });

    expect(store.getWidget(widgetId)!.zIndex).toBe(8);
  });

  it("leaves snatchedBy empty when there's no local node id yet", async () => {
    mockGetLocalNodeId.mockResolvedValue(null);
    const repo = createTestRepo();
    const store = CanvasStore.create(repo);

    const widgetId = await createFileWidgetFromBlob(repo, store, {
      blobId: "blob-1",
      mime: "text/plain",
    });

    const entry = store.getWidget(widgetId)!;
    const widgetHandle = await repo.find(entry.docId as any);
    await widgetHandle.whenReady();
    expect((widgetHandle.doc() as any).snatchedBy).toEqual([]);
  });

  it("doesn't fail the whole creation when the thumbnail fetch rejects", async () => {
    mockGetThumbnailDataUrl.mockRejectedValue(new Error("network down"));
    const repo = createTestRepo();
    const store = CanvasStore.create(repo);

    await expect(
      createFileWidgetFromBlob(repo, store, { blobId: "blob-1", mime: "text/plain" })
    ).resolves.toEqual(expect.any(String));
  });
});

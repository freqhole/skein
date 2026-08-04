// ---------------------------------------------------------------------------
// unit tests for unregisterBlobFromAllCanvases's cross-canvas snatchedBy
// splice. mocks getLocalNodeId + getBlobCanvasRefs (the two upstream data
// sources), but otherwise uses a real in-memory automerge repo + real
// CanvasStore/widget docs so the widget-tree traversal and the actual
// automerge mutation are exercised for real, mirroring doc-ready.test.ts's
// preference for a real repo over mocking automerge-repo itself.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentId } from "@automerge/automerge-repo";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { CanvasStore } from "../canvas/canvas-store";

const mockGetLocalNodeId = vi.fn<() => Promise<string | null>>(async () => "node-a");
vi.mock("./file-shared", () => ({
  getLocalNodeId: (...args: any[]) => mockGetLocalNodeId(...args),
}));

const mockGetBlobCanvasRefs = vi.fn<(blobId: string, blake3?: string | null) => Promise<string[]>>(
  async () => []
);
vi.mock("./blob-canvas-refs", () => ({
  getBlobCanvasRefs: (...args: any[]) => mockGetBlobCanvasRefs(...args),
}));

import { unregisterBlobFromAllCanvases } from "./unregister-blob";

function addFileWidget(
  store: CanvasStore,
  repo: ReturnType<typeof createTestRepo>,
  id: string,
  doc: { blobId?: string; blake3?: string; snatchedBy?: string[] },
  type = "file"
): DocumentId {
  const handle = repo.create(doc);
  store.addWidget({
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 0,
    props: {},
    collapsed: false,
    docId: handle.documentId,
  });
  return handle.documentId;
}

describe("unregisterBlobFromAllCanvases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLocalNodeId.mockResolvedValue("node-a");
    mockGetBlobCanvasRefs.mockResolvedValue([]);
  });

  it("does nothing when there's no local node id yet", async () => {
    mockGetLocalNodeId.mockResolvedValue(null);
    mockGetBlobCanvasRefs.mockResolvedValue(["some-canvas"]);
    const repo = createTestRepo();

    await unregisterBlobFromAllCanvases(repo, "blob-1", "blake3-1");

    expect(mockGetBlobCanvasRefs).not.toHaveBeenCalled();
  });

  it("does nothing when the blob has no referencing canvases", async () => {
    mockGetBlobCanvasRefs.mockResolvedValue([]);
    const repo = createTestRepo();

    await expect(
      unregisterBlobFromAllCanvases(repo, "blob-1", "blake3-1")
    ).resolves.toBeUndefined();
  });

  it("splices the local node id out of every matching widget across every referencing canvas", async () => {
    const repo = createTestRepo();

    const canvasA = CanvasStore.create(repo);
    const matchingDocId = addFileWidget(canvasA, repo, "w-match", {
      blobId: "blob-1",
      blake3: "blake3-1",
      snatchedBy: ["node-a", "node-b"],
    });

    const canvasB = CanvasStore.create(repo);
    const audioMatchDocId = addFileWidget(
      canvasB,
      repo,
      "w-audio-match",
      { blobId: "blob-1", blake3: "blake3-1", snatchedBy: ["node-a"] },
      "audio-recording"
    );
    // unrelated widget on the same canvas — must be left untouched.
    const otherDocId = addFileWidget(canvasB, repo, "w-other", {
      blobId: "blob-2",
      blake3: "blake3-2",
      snatchedBy: ["node-a"],
    });

    mockGetBlobCanvasRefs.mockResolvedValue([
      canvasA.handle.documentId,
      canvasB.handle.documentId,
    ]);

    await unregisterBlobFromAllCanvases(repo, "blob-1", "blake3-1");

    expect(repo.handles[matchingDocId].doc()).toEqual({
      blobId: "blob-1",
      blake3: "blake3-1",
      snatchedBy: ["node-b"],
    });
    expect(repo.handles[audioMatchDocId].doc()).toEqual({
      blobId: "blob-1",
      blake3: "blake3-1",
      snatchedBy: [],
    });
    expect(repo.handles[otherDocId].doc()).toEqual({
      blobId: "blob-2",
      blake3: "blake3-2",
      snatchedBy: ["node-a"],
    });
  });

  it("skips a bin widget entirely (no snatchedBy semantics there) and a widget with a null docId", async () => {
    const repo = createTestRepo();
    const canvas = CanvasStore.create(repo);
    canvas.addWidget({
      id: "w-bin",
      type: "bin",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 0,
      props: {},
      collapsed: false,
      docId: null,
    });

    mockGetBlobCanvasRefs.mockResolvedValue([canvas.handle.documentId]);

    await expect(
      unregisterBlobFromAllCanvases(repo, "blob-1", "blake3-1")
    ).resolves.toBeUndefined();
  });

  it("matches by legacy blobId when blake3 differs (dual-key resolution, mirrors resolveBlob)", async () => {
    const repo = createTestRepo();
    const canvas = CanvasStore.create(repo);
    const docId = addFileWidget(canvas, repo, "w-legacy", {
      blobId: "legacy-sha256-id",
      blake3: "",
      snatchedBy: ["node-a"],
    });

    mockGetBlobCanvasRefs.mockResolvedValue([canvas.handle.documentId]);

    await unregisterBlobFromAllCanvases(repo, "legacy-sha256-id", null);

    expect(repo.handles[docId].doc().snatchedBy).toEqual([]);
  });

  it("silently skips a canvas that can't currently be opened (unreachable/unauthorized)", async () => {
    const repo = createTestRepo();
    mockGetBlobCanvasRefs.mockResolvedValue(["bogus-unreachable-canvas" as DocumentId]);

    const openSpy = vi.spyOn(CanvasStore, "open").mockRejectedValueOnce(new Error("timed out"));
    try {
      await expect(
        unregisterBlobFromAllCanvases(repo, "blob-1", "blake3-1")
      ).resolves.toBeUndefined();
    } finally {
      openSpy.mockRestore();
    }
  });
});

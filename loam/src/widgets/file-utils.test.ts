// ---------------------------------------------------------------------------
// unit tests for file-utils.ts's tauri-mode branches.
//
// before this file, checkBlobLocality/snatchBlob/uploadFile had zero test
// coverage of any kind (browser or tauri) — see
// docs/widget-blob-acl-plan.md's phase 5 item 3. these tests target only
// the isTauriMode() === true branches, mocking the tauri IPC boundary
// (dispatch) and the blob-store/identity/blob-worker modules that would
// otherwise touch real IndexedDB/OPFS/wasm.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

// mock the tauri transport — controls isTauriMode() + intercepts every
// dispatch("action", payload) IPC call so we can assert on it and control
// its response, without a real tauri webview.
const mockIsTauriMode = vi.fn<() => boolean>();
const mockDispatch = vi.fn<(action: string, payload?: Record<string, unknown>) => Promise<any>>();
vi.mock("../p2p/tauri-transport", () => ({
  isTauriMode: (...args: any[]) => mockIsTauriMode(...args),
  dispatch: (...args: any[]) => mockDispatch(...args),
}));

// mock identity — snatchBlob's getPeerNodeIds() calls getStoredIdentity()
// to filter the local node out of the peer list. stubbed so the test
// doesn't depend on a real IndexedDB-backed identity (same precedent as
// friendz-wiring.test.ts / iroh-network-adapter.test.ts).
vi.mock("../p2p/identity", () => ({
  getStoredIdentity: vi.fn(async () => ({ node_id: "local-node-id" })),
  getMiddenNode: vi.fn(),
}));

// mock the blob store — the tauri-mode upload/dedup paths only ever touch
// getBlobRecord/storeBlob/classifyDomain; mocking the whole module avoids
// real IndexedDB/OPFS access.
const mockGetBlobRecord = vi.fn<(blobId: string) => Promise<any>>();
const mockStoreBlob = vi.fn<(...args: any[]) => Promise<void>>();
vi.mock("../storage/skein-blob-store", () => ({
  hasBlob: vi.fn(),
  getBlobRecord: (...args: any[]) => mockGetBlobRecord(...args),
  getBlobRecordBySha256: vi.fn(),
  getBlobRecordByBlake3: vi.fn(),
  getBlobObjectURL: vi.fn(),
  storeBlob: (...args: any[]) => mockStoreBlob(...args),
  computeSha256: vi.fn(),
  storeBlobFromFile: vi.fn(),
  resolveBlob: vi.fn(),
  getBlobData: vi.fn(),
  classifyDomain: (mime: string) => {
    if (mime.startsWith("image/")) return "photo";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "document";
    return "file";
  },
}));

// mock the blob worker client — avoids loading the real midden wasm module
// that this module transitively imports.
vi.mock("../workers/blob-worker-client", () => ({
  base64Decode: vi.fn(async (b64: string) =>
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  ),
  generateThumbnailDataUrl: vi.fn(async () => null),
}));

import { checkBlobLocality, snatchBlob, uploadFile } from "./file-utils";

describe("file-utils — tauri-mode branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkBlobLocality", () => {
    it("returns local metadata when the tauri blob_get_path dispatch finds the blob", async () => {
      mockIsTauriMode.mockReturnValue(true);
      mockDispatch.mockResolvedValue({
        path: "/tmp/skein-blobz/abc123",
        mime: "image/png",
        size: 42,
      });

      const result = await checkBlobLocality("blake3hash-1");

      expect(mockDispatch).toHaveBeenCalledWith("blob_get_path", { blake3: "blake3hash-1" });
      expect(result).toEqual({
        locality: "local",
        metadata: { id: "blake3hash-1", mime: "image/png", size: 42, blake3: "blake3hash-1" },
      });
    });

    it("returns remote when the tauri dispatch reports no local path", async () => {
      mockIsTauriMode.mockReturnValue(true);
      mockDispatch.mockResolvedValue({ path: undefined });

      const result = await checkBlobLocality("blake3hash-2");

      expect(result).toEqual({ locality: "remote" });
    });

    it("returns unknown when the tauri dispatch throws an unexpected (non-not-found) error", async () => {
      mockIsTauriMode.mockReturnValue(true);
      mockDispatch.mockRejectedValue(new Error("ipc channel closed"));

      const result = await checkBlobLocality("blake3hash-3");

      expect(result).toEqual({ locality: "unknown" });
    });
  });

  describe("snatchBlob (tauri local-blake3 short-circuit)", () => {
    it("skips p2p snatch entirely when the blob already exists locally under the same blake3", async () => {
      mockIsTauriMode.mockReturnValue(true);
      mockDispatch.mockResolvedValue({
        path: "/tmp/skein-blobz/deadbeef",
        mime: "audio/mpeg",
        size: 999,
      });

      const result = await snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "clip.mp3",
          mime: "audio/mpeg",
          size: 100,
          blake3: "deadbeef",
          domain: "audio",
        },
        { peer1: { nodeId: "remote-node-id" } }
      );

      expect(mockDispatch).toHaveBeenCalledWith("blob_get_path", { blake3: "deadbeef" });
      expect(result).toEqual({
        blobId: "deadbeef",
        domain: "audio",
        jobId: null,
        sha256: "",
        blake3: "deadbeef",
        size: 999,
        mime: "audio/mpeg",
        existing: true,
      });
    });
  });

  describe("uploadFile (tauri mode)", () => {
    it("uploads via blob_insert_from_path and mirrors the bytes into the local blob store", async () => {
      mockIsTauriMode.mockReturnValue(true);
      mockGetBlobRecord.mockResolvedValue(null); // not already mirrored locally
      mockDispatch.mockResolvedValue({
        meta: {
          blake3: "newblake3hash",
          iroh_hash: "irohhash",
          filename: "notes.txt",
          mime: "text/plain",
          size: 11,
          created_at: Date.now(),
        },
        data: btoa("hello world"),
      });

      const result = await uploadFile({
        path: "/Users/x/notes.txt",
        filename: "notes.txt",
        size: 0,
        file: null,
      });

      expect(mockDispatch).toHaveBeenCalledWith("blob_insert_from_path", {
        local_path: "/Users/x/notes.txt",
        filename: "notes.txt",
        mime: "text/plain",
      });
      expect(mockStoreBlob).toHaveBeenCalledTimes(1);
      expect(result.existing).toBe(false);
      expect(result.blake3).toBe("newblake3hash");
      expect(result.domain).toBe("file");
    });

    it("skips re-storing bytes when the blake3 is already mirrored locally", async () => {
      mockIsTauriMode.mockReturnValue(true);
      mockGetBlobRecord.mockResolvedValue({ blob_id: "newblake3hash" });
      mockDispatch.mockResolvedValue({
        meta: {
          blake3: "newblake3hash",
          iroh_hash: "irohhash",
          filename: "notes.txt",
          mime: "text/plain",
          size: 11,
          created_at: Date.now(),
        },
        data: btoa("hello world"),
      });

      const result = await uploadFile({
        path: "/Users/x/notes.txt",
        filename: "notes.txt",
        size: 0,
        file: null,
      });

      expect(mockStoreBlob).not.toHaveBeenCalled();
      expect(result.existing).toBe(true);
    });

    it("throws when called in tauri mode without a picked.path", async () => {
      mockIsTauriMode.mockReturnValue(true);

      await expect(
        uploadFile({ path: null, filename: "notes.txt", size: 0, file: null })
      ).rejects.toThrow("tauri uploadFile requires picked.path");
      expect(mockDispatch).not.toHaveBeenCalled();
    });
  });
});

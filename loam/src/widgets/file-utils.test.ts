// ---------------------------------------------------------------------------
// unit tests for file-utils.ts's tauri-mode branches.
//
// these tests target the isTauriMode() === true branches, mocking the tauri
// IPC boundary (dispatch) and the blob-store/identity/blob-worker modules
// that would otherwise touch real IndexedDB/OPFS/wasm.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// friendz-wiring.test.ts / iroh-network-adapter.test.ts). getMiddenNode is
// separately controllable per test for the browser-mode snatch-to-disk tests.
const mockGetMiddenNode = vi.fn<() => Promise<unknown>>();
vi.mock("../p2p/identity", () => ({
  getStoredIdentity: vi.fn(async () => ({ node_id: "local-node-id" })),
  getMiddenNode: (...args: any[]) => mockGetMiddenNode(...args),
}));

// mock the blob store — the tauri-mode upload/dedup paths only ever touch
// getBlobRecord/storeBlob/classifyDomain; mocking the whole module avoids
// real IndexedDB/OPFS access. storeBlob returns a fake record (the shared
// package's real storeBlob computes blake3/sha256 from the bytes and
// returns the stored record) — a generic default is enough everywhere
// except the one test that asserts on the returned sha256 specifically.
const mockGetBlobRecord = vi.fn<(blobId: string) => Promise<any>>();
const mockStoreBlob = vi.fn<(...args: any[]) => Promise<any>>(async (data: ArrayBuffer, meta: any) => ({
  blob_id: "mock-stored-blob-id",
  blake3: "mock-stored-blob-id",
  sha256: "mock-stored-sha256",
  filename: meta?.filename,
  mime: meta?.mime,
  size: data?.byteLength ?? 0,
  blob_type: meta?.blob_type ?? "original",
  parent_blob_id: meta?.parent_blob_id ?? null,
  metadata: meta?.metadata,
  created_at: Date.now(),
}));
const mockResolveBlob = vi.fn<(blobId: string, blake3?: string) => Promise<any>>();
const mockHasBlobBytes = vi.fn<(blobId: string) => Promise<boolean>>();
vi.mock("../storage/blob-store", () => ({
  hasBlobBytes: (...args: any[]) => mockHasBlobBytes(...args),
  getBlobRecord: (...args: any[]) => mockGetBlobRecord(...args),
  getBlobObjectURL: vi.fn(),
  storeBlob: (...args: any[]) => mockStoreBlob(...args),
  storeBlobFromFile: vi.fn(),
  resolveBlob: (...args: any[]) => mockResolveBlob(...args),
  getBlobData: vi.fn(),
  getBlobDomain: (record: any) => record?.metadata?.domain ?? "file",
  classifyDomain: (mime: string) => {
    if (mime.startsWith("image/")) return "photo";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "document";
    return "file";
  },
}));

// mock the blob worker client — avoids loading the real midden wasm module
// that this module transitively imports. hashBlake3 is controllable per
// test — it backs the defensive hash-verification check on the unverified
// proxy_request fallback download path (strategy 3 in
// downloadBlobBytesFromPeer).
const mockHashBlake3 = vi.fn<(bytes: Uint8Array) => Promise<string>>();
vi.mock("@freqhole/reliquary/worker", () => ({
  base64Decode: vi.fn(async (b64: string) =>
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  ),
  generateThumbnailDataUrl: vi.fn(async () => null),
  hashBlake3: (...args: any[]) => mockHashBlake3(...args),
}));

// mock the friend-status check used by the friend-fetch gate — defaults
// every peer to "friend" so the existing transport/probe/error tests below
// (none of which are about friend-gating) aren't affected. tests that
// specifically exercise the gate override this per-test.
const mockIsFriend = vi.fn<(nodeId: string) => boolean>(() => true);
vi.mock("../p2p/friendz-bridge", () => ({
  isFriend: (...args: any[]) => mockIsFriend(...args),
}));

// reset to the "everyone is a friend" default before every test in this
// file — most describe blocks below aren't testing the friend gate at all,
// and a per-test override via mockImplementation() (see the friend-gate
// describe) would otherwise leak into later, unrelated tests (clearAllMocks
// clears call history but not a previously-set implementation).
beforeEach(() => {
  mockIsFriend.mockReturnValue(true);
});

import {
  canSnatchToDisk,
  checkBlobLocality,
  discardPausedDownload,
  formatUploadError,
  isDownloadCancelled,
  pauseSnatchDownload,
  snatchBlob,
  snatchBlobToDisk,
  getThumbnailDataUrl,
  uploadFile,
  BlobAccessDeniedError,
} from "./file-utils";
import { IrohNetworkAdapter } from "@freqhole/reliquary/automerge";
import { createMockMidden, createMockBiStream } from "@freqhole/reliquary/testing";
import { DEFAULT_ENSURE_ALPN } from "@freqhole/reliquary/ensure";
import { handleSkeinStream, createSkeinEnsureBlobHandler } from "../p2p/skein-handler";

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

/** 
 * create a mock open_bi implementation that simulates the ensure-blob protocol.
 * used to adapt tests that previously mocked `ensure_blob` to the new
 * `ensureBlobOverAlpn` code path (which calls `node.open_bi` internally).
 */
function createMockEnsureBlobProtocol(available: boolean | (() => boolean | Promise<boolean>)) {
  return vi.fn(async (_peerAddr: string, _alpn: string) => {
    const isAvailable = typeof available === "function" ? await available() : available;
    const response = {
      type: "ensure_blob_response",
      id: 1,
      available: isAvailable,
    };
    const responseBytes = new TextEncoder().encode(JSON.stringify(response));
    
    return {
      read_to_end: vi.fn(async () => responseBytes),
      write_message: vi.fn(),
      write_raw_and_finish: vi.fn(),
      close: vi.fn(),
      peer_node_id: vi.fn(() => "mock-peer-id"),
      _written: [] as any[],
    };
  });
}

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

    it("browser: local when a record resolves AND its OPFS bytes exist", async () => {
      mockIsTauriMode.mockReturnValue(false);
      mockResolveBlob.mockResolvedValue({
        blob_id: "blake3-abc",
        blake3: "blake3-abc",
        mime: "video/mp4",
        filename: "movie.mp4",
        size: 1234,
      });
      mockHasBlobBytes.mockResolvedValue(true);

      const result = await checkBlobLocality("blake3-abc");

      expect(result.locality).toBe("local");
      expect(result.metadata?.blake3).toBe("blake3-abc");
      expect(mockHasBlobBytes).toHaveBeenCalledWith("blake3-abc");
    });

    it("browser: a stranded record (bytes missing from OPFS) counts as remote so re-snatch can repair it", async () => {
      mockIsTauriMode.mockReturnValue(false);
      mockResolveBlob.mockResolvedValue({
        blob_id: "blake3-stranded",
        blake3: "blake3-stranded",
        mime: "video/mp4",
        filename: "movie.mp4",
        size: 1234,
      });
      mockHasBlobBytes.mockResolvedValue(false);

      const result = await checkBlobLocality("blake3-stranded");

      expect(result).toEqual({ locality: "remote" });
    });

    it("browser: remote when no record resolves at all", async () => {
      mockIsTauriMode.mockReturnValue(false);
      mockResolveBlob.mockResolvedValue(null);

      const result = await checkBlobLocality("unknown-id");

      expect(result).toEqual({ locality: "remote" });
      expect(mockHasBlobBytes).not.toHaveBeenCalled();
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

    it("downloads into the native store (no IPC payload, no storeBlob) when the peer has the blob", async () => {
      mockIsTauriMode.mockReturnValue(true);
      // blob_get_path misses -> not local -> proceeds to the peer snatch
      mockDispatch.mockRejectedValue(new Error("not found"));

      const downloadToNativeStore = vi.fn(async () => ({
        size: 4321,
        mime: "video/mp4",
        filename: "movie.mp4",
      }));
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_to_native_store: downloadToNativeStore,
        // the buffered method must never be needed on this path
        download_verified_with_ensure_progress: vi.fn(async () => {
          throw new Error("buffered path should not run");
        }),
      });

      const result = await snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "movie.mp4",
          mime: "video/mp4",
          size: 4321,
          blake3: "cafebabe",
          domain: "video",
        },
        { peer1: { nodeId: "remote-node-id" } }
      );

      expect(downloadToNativeStore).toHaveBeenCalledWith(
        expect.any(String), // peer addr
        "cafebabe",
        4321,
        undefined, // no onProgress passed in this test
        "movie.mp4",
        "video/mp4"
      );
      // the rust store is the destination — nothing persisted JS-side
      expect(mockStoreBlob).not.toHaveBeenCalled();
      expect(result).toEqual({
        blobId: "cafebabe",
        domain: "video",
        jobId: null,
        sha256: "",
        blake3: "cafebabe",
        size: 4321,
        mime: "video/mp4",
        existing: false,
      });
    });
  });

  describe("uploadFile (tauri mode)", () => {
    it("uploads via blob_insert_from_path without mirroring bytes into OPFS/IndexedDB", async () => {
      mockIsTauriMode.mockReturnValue(true);
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
        upload_id: expect.any(String),
      });
      // no browser blob-store mirror: tauri media/locality/preview reads all
      // go through rust dispatch calls, and the browser blake3 hasher can't
      // work in a tauri build (no midden module to hash with) — see
      // uploadFile()'s tauri-mode comment.
      expect(mockGetBlobRecord).not.toHaveBeenCalled();
      expect(mockStoreBlob).not.toHaveBeenCalled();
      expect(result.existing).toBe(false);
      expect(result.blake3).toBe("newblake3hash");
      expect(result.domain).toBe("file");
    });

    it("throws when called in tauri mode without a picked.path", async () => {
      mockIsTauriMode.mockReturnValue(true);

      await expect(
        uploadFile({ path: null, filename: "notes.txt", size: 0, file: null })
      ).rejects.toThrow("tauri uploadFile requires picked.path");
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("skips the OPFS mirror entirely when rust reports data: null (large file over the mirror threshold)", async () => {
      mockIsTauriMode.mockReturnValue(true);
      mockDispatch.mockResolvedValue({
        meta: {
          blake3: "hugefileblake3",
          iroh_hash: "irohhash",
          filename: "huge.bin",
          mime: "application/octet-stream",
          size: 7_000_000_000,
          created_at: Date.now(),
        },
        data: null,
      });

      const result = await uploadFile({
        path: "/Users/x/huge.bin",
        filename: "huge.bin",
        size: 0,
        file: null,
      });

      expect(mockGetBlobRecord).not.toHaveBeenCalled();
      expect(mockStoreBlob).not.toHaveBeenCalled();
      expect(result.existing).toBe(false);
      expect(result.blake3).toBe("hugefileblake3");
      expect(result.thumbnailDataUrl).toBeNull();
      expect(result.size).toBe(7_000_000_000);
    });

    it("wraps a rejected dispatch through formatUploadError", async () => {
      mockIsTauriMode.mockReturnValue(true);
      mockDispatch.mockRejectedValue("blob: io error: No space left on device (os error 28)");

      await expect(
        uploadFile({ path: "/Users/x/huge.bin", filename: "huge.bin", size: 0, file: null })
      ).rejects.toThrow("upload failed: not enough disk space");
    });
  });

  describe("formatUploadError", () => {
    it("recognizes a disk-space error", () => {
      expect(formatUploadError("blob: io error: No space left on device (os error 28)")).toBe(
        "upload failed: not enough disk space"
      );
    });

    it("recognizes a permission error", () => {
      expect(formatUploadError(new Error("Permission denied (os error 13)"))).toBe(
        "upload failed: permission denied"
      );
    });

    it("recognizes a missing-file error", () => {
      expect(formatUploadError("No such file or directory (os error 2)")).toBe(
        "upload failed: file not found (moved or deleted?)"
      );
    });

    it("falls back to a truncated generic message for anything else", () => {
      expect(formatUploadError("some totally unexpected rust panic message")).toBe(
        "upload failed: some totally unexpected rust panic message"
      );
    });

    it("truncates a very long message", () => {
      const long = "x".repeat(200);
      const result = formatUploadError(long);
      expect(result.length).toBeLessThanOrEqual(60 + "upload failed: ".length);
      expect(result.endsWith("...")).toBe(true);
    });
  });

  describe("canSnatchToDisk", () => {
    const originalPicker = (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;

    afterEach(() => {
      (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = originalPicker;
    });

    it("is false in tauri mode even when the File System Access API is present", () => {
      mockIsTauriMode.mockReturnValue(true);
      (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn();

      expect(canSnatchToDisk()).toBe(false);
    });

    it("is false in browser mode when showSaveFilePicker isn't available (e.g. Safari)", () => {
      mockIsTauriMode.mockReturnValue(false);
      delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;

      expect(canSnatchToDisk()).toBe(false);
    });

    it("is true in browser mode when the File System Access API is available", () => {
      mockIsTauriMode.mockReturnValue(false);
      (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn();

      expect(canSnatchToDisk()).toBe(true);
    });
  });

  describe("snatchBlobToDisk (browser mode — skips OPFS/IndexedDB persistence)", () => {
    it("throws when called in tauri mode", async () => {
      mockIsTauriMode.mockReturnValue(true);

      const writable = { write: vi.fn(), close: vi.fn() };

      await expect(
        snatchBlobToDisk(
          {
            blobId: "doc-blob-id",
            filename: "movie.mp4",
            mime: "video/mp4",
            size: 4,
            blake3: "deadbeef",
            domain: "video",
          },
          { peer1: { nodeId: "remote-node-id" } },
          writable as unknown as FileSystemWritableFileStream
        )
      ).rejects.toThrow("snatchBlobToDisk is browser-only");

      expect(writable.write).not.toHaveBeenCalled();
    });

    it("downloads the full payload and writes it to the writable stream, without touching storeBlob", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_with_ensure_progress: vi.fn(
          async (
            _peerAddr: string,
            _blake3: string,
            _size: number,
            onProgress: (fraction: number) => void
          ) => {
            onProgress(1);
            return payload;
          }
        ),
      });

      const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}) };

      const result = await snatchBlobToDisk(
        {
          blobId: "doc-blob-id",
          filename: "movie.mp4",
          mime: "video/mp4",
          size: 5,
          blake3: "deadbeef",
          domain: "video",
        },
        { peer1: { nodeId: "remote-node-id" } },
        writable as unknown as FileSystemWritableFileStream
      );

      expect(result).toEqual({ size: 5, mime: "video/mp4", blake3: "deadbeef" });
      expect(writable.write).toHaveBeenCalledTimes(1);
      expect(writable.write).toHaveBeenCalledWith(payload);
      expect(writable.close).toHaveBeenCalledTimes(1);
      expect(mockStoreBlob).not.toHaveBeenCalled();
    });

    it("throws when no peer has the blob, without ever calling write()", async () => {
      mockIsTauriMode.mockReturnValue(false);
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(false),
      });

      const writable = { write: vi.fn(), close: vi.fn() };

      await expect(
        snatchBlobToDisk(
          {
            blobId: "doc-blob-id",
            filename: "movie.mp4",
            mime: "video/mp4",
            size: 5,
            blake3: "deadbeef",
            domain: "video",
          },
          { peer1: { nodeId: "remote-node-id" } },
          writable as unknown as FileSystemWritableFileStream
        )
      ).rejects.toThrow("no peer has the blob");

      expect(writable.write).not.toHaveBeenCalled();
    });

    it("propagates a disk-write failure directly, without retrying another peer", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const payload = new Uint8Array([9, 9, 9]);
      const openBi = createMockEnsureBlobProtocol(true);
      const downloadFn = vi.fn(async () => payload);
      mockGetMiddenNode.mockResolvedValue({
        open_bi: openBi,
        download_verified_with_ensure_progress: downloadFn,
      });

      const writable = {
        write: vi.fn(async () => {
          throw new Error("disk full");
        }),
        close: vi.fn(async () => {}),
      };

      await expect(
        snatchBlobToDisk(
          {
            blobId: "doc-blob-id",
            filename: "movie.mp4",
            mime: "video/mp4",
            size: 3,
            blake3: "deadbeef",
            domain: "video",
          },
          {
            peer1: { nodeId: "remote-node-id-1" },
            peer2: { nodeId: "remote-node-id-2" },
          },
          writable as unknown as FileSystemWritableFileStream
        )
      ).rejects.toThrow("disk full");

      // both peers are probed once, in parallel (that's normal) — the
      // real assertion is that the DOWNLOAD only happens once (from
      // whichever peer wins the probe) and there is no second probe
      // round: a write failure is a real disk error, not a peer problem,
      // so it must not retry download against the other peer.
      expect(openBi).toHaveBeenCalledTimes(2);
      expect(downloadFn).toHaveBeenCalledTimes(1);
      expect(writable.close).not.toHaveBeenCalled();
      expect(mockStoreBlob).not.toHaveBeenCalled();
    });
  });

  describe("snatchBlobToDisk — chunk-streamed path (download_verified_streaming_with_ensure)", () => {
    const blobInfo = {
      blobId: "doc-blob-id",
      filename: "movie.mp4",
      mime: "video/mp4",
      size: 8,
      blake3: "deadbeef",
      domain: "video",
    };

    function makeWritable() {
      return {
        write: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        truncate: vi.fn(async () => {}),
      };
    }

    it("streams chunks to the writable at explicit offsets and never buffers the payload", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const chunk1 = new Uint8Array([1, 2, 3, 4]);
      const chunk2 = new Uint8Array([5, 6, 7, 8]);
      const buffered = vi.fn();
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_with_ensure_progress: buffered,
        download_verified_streaming_with_ensure: vi.fn(
          async (
            _peerAddr: string,
            _blake3: string,
            _size: number,
            onChunk: (chunk: Uint8Array, offset: number) => void,
            onProgress: (fraction: number) => void
          ) => {
            onChunk(chunk1, 0);
            onChunk(chunk2, 4);
            onProgress(1);
            return 8;
          }
        ),
      });

      const writable = makeWritable();

      const result = await snatchBlobToDisk(
        blobInfo,
        { peer1: { nodeId: "remote-node-id" } },
        writable as unknown as FileSystemWritableFileStream
      );

      expect(result).toEqual({ size: 8, mime: "video/mp4", blake3: "deadbeef" });
      expect(writable.write).toHaveBeenCalledTimes(2);
      expect(writable.write).toHaveBeenNthCalledWith(1, {
        type: "write",
        position: 0,
        data: chunk1,
      });
      expect(writable.write).toHaveBeenNthCalledWith(2, {
        type: "write",
        position: 4,
        data: chunk2,
      });
      expect(writable.close).toHaveBeenCalledTimes(1);
      // the buffered download method must not be touched on the streamed path
      expect(buffered).not.toHaveBeenCalled();
      expect(mockStoreBlob).not.toHaveBeenCalled();
    });

    it("truncates partial data and retries the next peer after a mid-stream failure", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const goodChunk = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7]);
      let attempt = 0;
      const streamFn = vi.fn(
        async (
          _peerAddr: string,
          _blake3: string,
          _size: number,
          onChunk: (chunk: Uint8Array, offset: number) => void
        ) => {
          attempt += 1;
          if (attempt === 1) {
            // first peer dies mid-transfer after delivering a partial chunk
            onChunk(goodChunk.slice(0, 4), 0);
            throw new Error("connection lost");
          }
          onChunk(goodChunk, 0);
          return 8;
        }
      );
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_streaming_with_ensure: streamFn,
      });

      const writable = makeWritable();

      const result = await snatchBlobToDisk(
        blobInfo,
        {
          peer1: { nodeId: "remote-node-id-1" },
          peer2: { nodeId: "remote-node-id-2" },
        },
        writable as unknown as FileSystemWritableFileStream
      );

      expect(result.size).toBe(8);
      expect(streamFn).toHaveBeenCalledTimes(2);
      // partial data from the failed attempt was wiped before the retry
      expect(writable.truncate).toHaveBeenCalledWith(0);
      expect(writable.close).toHaveBeenCalledTimes(1);
    });

    it("rejects a 0-byte streamed payload", async () => {
      mockIsTauriMode.mockReturnValue(false);
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_streaming_with_ensure: vi.fn(async () => 0),
      });

      const writable = makeWritable();

      await expect(
        snatchBlobToDisk(
          blobInfo,
          { peer1: { nodeId: "remote-node-id" } },
          writable as unknown as FileSystemWritableFileStream
        )
      ).rejects.toThrow("0 bytes");

      expect(writable.close).not.toHaveBeenCalled();
    });

    it("surfaces a chunk write failure instead of silently completing", async () => {
      mockIsTauriMode.mockReturnValue(false);
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_streaming_with_ensure: vi.fn(
          async (
            _peerAddr: string,
            _blake3: string,
            _size: number,
            onChunk: (chunk: Uint8Array, offset: number) => void
          ) => {
            onChunk(new Uint8Array([1]), 0);
            return 1;
          }
        ),
      });

      const writable = makeWritable();
      writable.write.mockRejectedValue(new Error("disk full"));

      await expect(
        snatchBlobToDisk(
          blobInfo,
          { peer1: { nodeId: "remote-node-id" } },
          writable as unknown as FileSystemWritableFileStream
        )
      ).rejects.toThrow("disk full");

      expect(writable.close).not.toHaveBeenCalled();
    });

    it("fails fast when the doc has no blake3 hash (no compute-on-demand fallback — the transport package always requires blake3 up front)", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const streamFn = vi.fn(async () => {
        throw new Error("peer rejected empty blake3 hash");
      });
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_streaming_with_ensure: streamFn,
      });

      const writable = makeWritable();

      await expect(
        snatchBlobToDisk(
          { ...blobInfo, blake3: "" },
          { peer1: { nodeId: "remote-node-id" } },
          writable as unknown as FileSystemWritableFileStream
        )
      ).rejects.toThrow("peer rejected empty blake3 hash");

      expect(writable.write).not.toHaveBeenCalled();
    });
  });

  describe("pause/cancel semantics", () => {
    const blobInfo = {
      blobId: "doc-blob-id",
      filename: "movie.mp4",
      mime: "video/mp4",
      size: 8,
      blake3: "deadbeef",
      domain: "video",
    };

    function makeWritable() {
      return {
        write: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        truncate: vi.fn(async () => {}),
      };
    }

    it("isDownloadCancelled recognizes deliberate cancellations only", () => {
      expect(isDownloadCancelled(new Error("download cancelled"))).toBe(true);
      expect(isDownloadCancelled(new Error("first attempt: download cancelled by user"))).toBe(
        true
      );
      expect(isDownloadCancelled(new DOMException("snatch cancelled", "AbortError"))).toBe(true);
      expect(isDownloadCancelled(new Error("connection lost"))).toBe(false);
      expect(isDownloadCancelled(new Error("blob not available on peer"))).toBe(false);
    });

    it("snatchBlobToDisk (streamed): a paused download propagates without truncate or next-peer retry", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const streamFn = vi.fn(async () => {
        throw new Error("download cancelled");
      });
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_streaming_with_ensure: streamFn,
      });

      const writable = makeWritable();

      await expect(
        snatchBlobToDisk(
          blobInfo,
          {
            peer1: { nodeId: "remote-node-id-1" },
            peer2: { nodeId: "remote-node-id-2" },
          },
          writable as unknown as FileSystemWritableFileStream
        )
      ).rejects.toThrow("download cancelled");

      // no next-peer retry, no truncate (resume rewrites the same offsets)
      expect(streamFn).toHaveBeenCalledTimes(1);
      expect(writable.truncate).not.toHaveBeenCalled();
      expect(writable.close).not.toHaveBeenCalled();
    });

    it("snatchBlob (buffered): a paused download propagates instead of falling to the next strategy/peer", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const strategy1 = vi.fn(async () => {
        throw new Error("download cancelled");
      });
      const strategy2 = vi.fn();
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_with_ensure_progress: strategy1,
        download_verified_by_id_progress: strategy2,
      });

      await expect(
        snatchBlob(blobInfo, {
          peer1: { nodeId: "remote-node-id-1" },
          peer2: { nodeId: "remote-node-id-2" },
        })
      ).rejects.toThrow("download cancelled");

      expect(strategy1).toHaveBeenCalledTimes(1);
      // the unverified fallback strategies must not run after a pause
      expect(strategy2).not.toHaveBeenCalled();
    });

    it("snatchBlobToDisk threads options.downloadId into the streaming download call", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const streamFn = vi.fn(
        async (
          _peerAddr: string,
          _blake3: string,
          _size: number,
          onChunk: (chunk: Uint8Array, offset: number) => void
        ) => {
          onChunk(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0);
          return 8;
        }
      );
      mockGetMiddenNode.mockResolvedValue({
        open_bi: createMockEnsureBlobProtocol(true),
        download_verified_streaming_with_ensure: streamFn,
      });

      const writable = makeWritable();
      await snatchBlobToDisk(
        blobInfo,
        { peer1: { nodeId: "remote-node-id" } },
        writable as unknown as FileSystemWritableFileStream,
        { downloadId: "dl-123" }
      );

      expect(streamFn).toHaveBeenCalledWith(
        expect.any(String),
        "deadbeef",
        8,
        expect.any(Function),
        expect.any(Function),
        "dl-123"
      );
    });

    it("pauseSnatchDownload: browser mode flags the worker cancel token by downloadId", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const downloadCancel = vi.fn(async () => true);
      mockGetMiddenNode.mockResolvedValue({ download_cancel: downloadCancel });

      const flagged = await pauseSnatchDownload({ downloadId: "dl-456", blake3: "deadbeef" });

      expect(flagged).toBe(true);
      expect(downloadCancel).toHaveBeenCalledWith("dl-456");
    });

    it("pauseSnatchDownload: tauri mode cancels the native download by blake3", async () => {
      mockIsTauriMode.mockReturnValue(true);
      const cancelNative = vi.fn(async () => true);
      mockGetMiddenNode.mockResolvedValue({ cancel_native_download: cancelNative });

      const flagged = await pauseSnatchDownload({ downloadId: "dl-789", blake3: "deadbeef" });

      expect(flagged).toBe(true);
      expect(cancelNative).toHaveBeenCalledWith("deadbeef");
    });

    it("pauseSnatchDownload: returns false when the node has no cancel capability", async () => {
      mockIsTauriMode.mockReturnValue(false);
      mockGetMiddenNode.mockResolvedValue({});

      expect(await pauseSnatchDownload({ downloadId: "dl-000" })).toBe(false);
    });

    it("discardPausedDownload releases the gc pin in browser mode and no-ops in tauri mode", async () => {
      mockIsTauriMode.mockReturnValue(false);
      const unprotect = vi.fn(async () => {});
      mockGetMiddenNode.mockResolvedValue({ unprotect_blob: unprotect });

      await discardPausedDownload("deadbeef");
      expect(unprotect).toHaveBeenCalledWith("deadbeef");

      unprotect.mockClear();
      mockIsTauriMode.mockReturnValue(true);
      await discardPausedDownload("deadbeef");
      expect(unprotect).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// adversarial tests: concurrent/duplicate snatch races + widget-deletion-
// mid-snatch safety (see docs/opfs-blob-store-design.md's snatch section
// and file-utils.ts's `inFlightSnatches` doc comment for the design this
// targets).
// ---------------------------------------------------------------------------

/** resolves/rejects on demand — lets a test control exactly when a mocked
 *  P2P call "completes" relative to other assertions, instead of racing
 *  real timers. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("snatchBlob — concurrent/duplicate snatch races (browser mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauriMode.mockReturnValue(false);
  });

  it("two concurrent snatchBlob calls for the SAME blake3 hash share one in-flight download (no redundant P2P work, no duplicate OPFS/IDB write)", async () => {
    const download = createDeferred<Uint8Array>();
    const openBi = createMockEnsureBlobProtocol(true);
    const downloadFn = vi.fn(() => download.promise);
    mockGetMiddenNode.mockResolvedValue({
      open_bi: openBi,
      download_verified_with_ensure_progress: downloadFn,
    });
    mockGetBlobRecord.mockResolvedValue(null);

    const info = {
      blobId: "doc-blob-id",
      filename: "clip.mp3",
      mime: "audio/mpeg",
      size: 5,
      blake3: "same-hash-both-callers",
      domain: "audio",
    };
    const peers = { peer1: { nodeId: "remote-node-id" } };

    // fire both calls back-to-back, BEFORE the download resolves — this is
    // the exact "same blob snatched from two different widgets at nearly
    // the same time" scenario.
    const first = snatchBlob(info, peers);
    const second = snatchBlob(info, peers);

    // let both calls' synchronous/microtask setup (dedup-map check, probe)
    // run before resolving the download. a real macrotask tick is used
    // rather than a fixed number of microtask hops, since the probe path
    // goes through getMiddenNode()/ensure_blob()/withPeerTimeout.
    await new Promise((r) => setTimeout(r, 0));

    download.resolve(new Uint8Array([1, 2, 3, 4, 5]));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    // the second caller must have joined the first's in-flight promise
    // instead of starting its own redundant probe+download+store.
    expect(openBi).toHaveBeenCalledTimes(1);
    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(mockStoreBlob).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(firstResult);
  });

  it("a FAILED snatch does not raise an unhandled promise rejection from the internal dedup-cleanup chain (regression test)", async () => {
    // every peer reports it doesn't have the blob -> snatchBlobUncached
    // rejects with "no peer has the blob (all probes failed)". this is the
    // exact rejection path that previously leaked a second, unhandled
    // promise rejection out of the `void promise.finally(...)` cleanup
    // (finally() returns a distinct promise from the one callers await —
    // handling `promise` doesn't handle its own finally-derived promise).
    mockGetMiddenNode.mockResolvedValue({
      ensure_blob: vi.fn(async () => false),
    });

    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(
        snatchBlob(
          {
            blobId: "doc-blob-id-fail",
            filename: "clip.mp3",
            mime: "audio/mpeg",
            size: 5,
            blake3: "hash-nobody-has",
            domain: "audio",
          },
          { peer1: { nodeId: "remote-node-id" } }
        )
      ).rejects.toThrow("no peer has the blob");

      // give the event loop a couple of ticks — an unhandled rejection is
      // reported asynchronously, not synchronously at reject() time.
      await new Promise((r) => setTimeout(r, 20));

      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("two concurrent calls for DIFFERENT hashes do NOT get coalesced (dedup is content-scoped, not global)", async () => {
    const openBi = createMockEnsureBlobProtocol(true);
    const downloadFn = vi.fn(async () => new Uint8Array([9, 9, 9]));
    mockGetMiddenNode.mockResolvedValue({
      open_bi: openBi,
      download_verified_with_ensure_progress: downloadFn,
    });
    mockGetBlobRecord.mockResolvedValue(null);

    const peers = { peer1: { nodeId: "remote-node-id" } };
    const [a, b] = await Promise.all([
      snatchBlob(
        { blobId: "b1", filename: "a.mp3", mime: "audio/mpeg", size: 3, blake3: "hash-a", domain: "audio" },
        peers
      ),
      snatchBlob(
        { blobId: "b2", filename: "b.mp3", mime: "audio/mpeg", size: 3, blake3: "hash-b", domain: "audio" },
        peers
      ),
    ]);

    expect(openBi).toHaveBeenCalledTimes(2);
    expect(downloadFn).toHaveBeenCalledTimes(2);
    expect(a).not.toEqual(b);
  });
});

describe("snatchBlob — abort signal semantics (widget-deleted-mid-snatch scenario)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauriMode.mockReturnValue(false);
  });

  it("aborting the signal WHILE a download is already in flight does NOT cancel the underlying WASM call — the transfer runs to completion, but the result is discarded before it can be persisted", async () => {
    // this precisely confirms the documented (but previously unverified by
    // a real test) behavior: SnatchOptions.signal is only polled at
    // discrete checkpoints (before a probe, before a download attempt, and
    // right after a download resolves but before persisting it) — it is
    // never threaded into the in-flight download_verified_with_ensure_progress
    // call itself, which has no cancellation parameter to accept one.
    // calling .abort() after the download has already started therefore
    // cannot stop the transfer (downloadFn still runs to completion below,
    // wasting the full network/CPU cost) — but the very next polled check
    // (in snatchFromBrowserPeer, right after the download resolves) DOES
    // catch the abort and rejects before storeBlob is ever called. net
    // effect: no wasted persistence, but wasted bandwidth for anything
    // already in flight when abort() is called — a real, bounded cost.
    const download = createDeferred<Uint8Array>();
    const openBi = createMockEnsureBlobProtocol(true);
    const downloadFn = vi.fn(() => download.promise);
    mockGetMiddenNode.mockResolvedValue({
      open_bi: openBi,
      download_verified_with_ensure_progress: downloadFn,
    });
    mockGetBlobRecord.mockResolvedValue(null);

    const abortController = new AbortController();
    const resultPromise = snatchBlob(
      {
        blobId: "doc-blob-id",
        filename: "clip.mp3",
        mime: "audio/mpeg",
        size: 5,
        blake3: "abort-mid-flight-hash",
        domain: "audio",
      },
      { peer1: { nodeId: "remote-node-id" } },
      { signal: abortController.signal }
    );

    // let the probe complete and the download call actually start (so
    // downloadFn has genuinely been invoked) before aborting. several
    // microtask hops happen first (getMiddenNode(), ensure_blob(),
    // withPeerTimeout's Promise.race) — a real macrotask tick is the
    // robust way to wait for all of them rather than guessing a fixed
    // number of Promise.resolve() hops.
    await new Promise((r) => setTimeout(r, 0));
    expect(downloadFn).toHaveBeenCalledTimes(1);

    // simulate the widget being deleted mid-snatch: abort right now.
    abortController.abort();

    // the in-flight "download" (still pending) now completes successfully —
    // proving the abort did not stop the underlying transfer itself.
    download.resolve(new Uint8Array([1, 2, 3, 4, 5]));

    // the overall snatch correctly rejects (AbortError) rather than
    // silently resolving with data nobody asked for anymore...
    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });

    // ...and, critically, NOTHING was persisted to OPFS/IndexedDB — the
    // polled check right after the download stopped it from being stored.
    // this is what actually matters for the "widget deleted mid-snatch"
    // scenario: file.ts's handleSnatch also independently checks its own
    // `destroyed` flag before touching ctx.doc, so this is real
    // defense-in-depth, not the only thing preventing an orphaned write.
    expect(mockStoreBlob).not.toHaveBeenCalled();
  });

  it("aborting the signal BEFORE a retry/next-peer attempt starts DOES stop it (the polled checkpoint works)", async () => {
    // contrast case: abort BEFORE the next phase's checkpoint is reached
    // (here, before probePeersForBlob's first `options.signal.aborted`
    // check ever runs) — the polled check correctly prevents that phase.
    const ensureBlob = vi.fn(async () => true);
    const downloadFn = vi.fn(async () => new Uint8Array([1, 2, 3]));
    mockGetMiddenNode.mockResolvedValue({
      ensure_blob: ensureBlob,
      download_verified_with_ensure_progress: downloadFn,
    });

    const abortController = new AbortController();
    abortController.abort(); // abort BEFORE snatchBlob is even called

    await expect(
      snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "clip.mp3",
          mime: "audio/mpeg",
          size: 5,
          blake3: "abort-before-start-hash",
          domain: "audio",
        },
        { peer1: { nodeId: "remote-node-id" } },
        { signal: abortController.signal }
      )
    ).rejects.toThrow("snatch cancelled");

    expect(ensureBlob).not.toHaveBeenCalled();
    expect(downloadFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// adversarial tests: every candidate peer fails (offline, rejects, or has
// no info about the blob). the existing "no peer has the blob" test above
// only covers a single peer's probe failing — these extend coverage to an
// empty peer list, a peer list that resolves to zero REMOTE peers, and the
// probe-succeeds-but-every-download-fails case, confirming the caller
// always gets a single, clear, catchable rejection (never a hang, never an
// unhandled rejection) in each shape of "no candidate peer worked out".
// ---------------------------------------------------------------------------

describe("snatchBlob — every candidate peer fails (no hang, no unhandled rejection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauriMode.mockReturnValue(false);
  });

  it("rejects immediately with a clear error when the peers map is empty", async () => {
    await expect(
      snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "clip.mp3",
          mime: "audio/mpeg",
          size: 5,
          blake3: "hash-1",
          domain: "audio",
        },
        {}
      )
    ).rejects.toThrow("no peers available for snatch");

    // no wasted work: the p2p node should never even be touched.
    expect(mockGetMiddenNode).not.toHaveBeenCalled();
  });

  it("rejects with the same clear error when every entry in the peers map resolves to the LOCAL node (zero remote candidates)", async () => {
    await expect(
      snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "clip.mp3",
          mime: "audio/mpeg",
          size: 5,
          blake3: "hash-2",
          domain: "audio",
        },
        { peer1: { nodeId: "local-node-id" } }
      )
    ).rejects.toThrow("no peers available for snatch");

    expect(mockGetMiddenNode).not.toHaveBeenCalled();
  });

  it("rejects with a single clear error when every peer's probe reports the blob unavailable", async () => {
    const openBi = createMockEnsureBlobProtocol(false);
    mockGetMiddenNode.mockResolvedValue({ open_bi: openBi });

    await expect(
      snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "clip.mp3",
          mime: "audio/mpeg",
          size: 5,
          blake3: "hash-3",
          domain: "audio",
        },
        {
          peer1: { nodeId: "remote-node-id-1" },
          peer2: { nodeId: "remote-node-id-2" },
          peer3: { nodeId: "remote-node-id-3" },
        }
      )
    ).rejects.toThrow("no peer has the blob (all probes failed)");

    expect(openBi).toHaveBeenCalledTimes(3);
  });

  it("rejects with a single clear error (not a hang) when every peer's probe REJECTS outright (e.g. connection refused)", async () => {
    // a non-transient rejection message (doesn't match the /connection
    // (lost|closed)|stream closed|reset|broken/i retry regex in
    // probeSinglePeer) so this test doesn't pay the 1.5s transient-retry
    // delay — the point here is total-failure behavior, not the retry path.
    const openBi = vi.fn(async () => {
      throw new Error("connection refused");
    });
    mockGetMiddenNode.mockResolvedValue({ open_bi: openBi });

    await expect(
      snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "clip.mp3",
          mime: "audio/mpeg",
          size: 5,
          blake3: "hash-4",
          domain: "audio",
        },
        {
          peer1: { nodeId: "remote-node-id-1" },
          peer2: { nodeId: "remote-node-id-2" },
        }
      )
    ).rejects.toThrow("no peer has the blob (all probes failed)");
  });

  it("rejects with the underlying download error (not a hang, not a swallowed failure) when every peer's probe succeeds but every download attempt fails", async () => {
    // both peers report they HAVE the blob (probe succeeds), but the
    // actual download fails for both (peer went offline mid-transfer, or
    // never really had the bytes despite a stale/incorrect ensure_blob
    // response). no streaming/proxy strategy is configured, so the
    // transport package's own last-real-error (not a generic "no fallback"
    // message) is what should surface.
    const openBi = createMockEnsureBlobProtocol(true);
    const downloadFn = vi.fn(async () => {
      throw new Error("peer connection reset mid-transfer");
    });
    mockGetMiddenNode.mockResolvedValue({
      open_bi: openBi,
      download_verified_with_ensure_progress: downloadFn,
    });

    await expect(
      snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "clip.mp3",
          mime: "audio/mpeg",
          size: 5,
          blake3: "hash-5",
          domain: "audio",
        },
        {
          peer1: { nodeId: "remote-node-id-1" },
          peer2: { nodeId: "remote-node-id-2" },
        }
      )
    ).rejects.toThrow("peer connection reset mid-transfer");

    // both peers were genuinely tried for the download (retry-against-
    // next-peer worked), not just probed once and given up on.
    expect(downloadFn).toHaveBeenCalledTimes(2);
    expect(mockStoreBlob).not.toHaveBeenCalled();
  });

  it("never produces an unhandled promise rejection across any of the above all-peers-fail shapes", async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const openBi = createMockEnsureBlobProtocol(true);
      const downloadFn = vi.fn(async () => {
        throw new Error("gone");
      });
      mockGetMiddenNode.mockResolvedValue({
        open_bi: openBi,
        download_verified_with_ensure_progress: downloadFn,
      });

      await expect(
        snatchBlob(
          {
            blobId: "doc-blob-id",
            filename: "clip.mp3",
            mime: "audio/mpeg",
            size: 5,
            blake3: "hash-6",
            domain: "audio",
          },
          { peer1: { nodeId: "remote-node-id" } }
        )
      ).rejects.toThrow();

      await new Promise((r) => setTimeout(r, 20));
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

// ---------------------------------------------------------------------------
// friend-fetch gate: snatchBlob() shouldn't bother attempting a download
// from a peer we're not friends with (both platforms deny it) — it should
// throw BlobAccessDeniedError instead, distinctly from "no peer has it at
// all", so a caller can offer a friend-request UI. see friendz-bridge.ts's
// isFriend() (mocked above) and pending-blob-access.ts's retry registry.
// ---------------------------------------------------------------------------

describe("snatchBlob — friend-fetch gate (BlobAccessDeniedError)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauriMode.mockReturnValue(false);
    mockIsFriend.mockReturnValue(true);
  });

  it("throws BlobAccessDeniedError (not the generic all-probes-failed error) when the only peer with the blob isn't a friend", async () => {
    mockIsFriend.mockReturnValue(false);
    const openBi = createMockEnsureBlobProtocol(true);
    mockGetMiddenNode.mockResolvedValue({ open_bi: openBi });

    const err: unknown = await snatchBlob(
      {
        blobId: "doc-blob-id",
        filename: "clip.mp3",
        mime: "audio/mpeg",
        size: 5,
        blake3: "hash-friend-gate-1",
        domain: "audio",
      },
      { peer1: { nodeId: "non-friend-node-id" } }
    ).catch((e) => e);

    expect(err).toBeInstanceOf(BlobAccessDeniedError);
    expect((err as BlobAccessDeniedError).peerNodeId).toBe("non-friend-node-id");
    expect((err as BlobAccessDeniedError).peerNodeIds).toEqual(["non-friend-node-id"]);
    expect(mockIsFriend).toHaveBeenCalledWith("non-friend-node-id");
  });

  it("proceeds with the download when at least one peer with the blob IS a friend, ignoring non-friend peers that also have it", async () => {
    const openBi = createMockEnsureBlobProtocol(true);
    const downloadFn = vi.fn(async () => new Uint8Array([1, 2, 3]));
    mockGetMiddenNode.mockResolvedValue({
      open_bi: openBi,
      download_verified_with_ensure_progress: downloadFn,
    });
    // only "friend-node-id" is a friend
    mockIsFriend.mockImplementation((nodeId: string) => nodeId === "friend-node-id");

    const result = await snatchBlob(
      {
        blobId: "doc-blob-id",
        filename: "clip.mp3",
        mime: "audio/mpeg",
        size: 5,
        blake3: "hash-friend-gate-2",
        domain: "audio",
      },
      {
        peer1: { nodeId: "non-friend-node-id" },
        peer2: { nodeId: "friend-node-id" },
      }
    );

    expect(result).toBeTruthy();
    // the download was only attempted against the friend peer
    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(downloadFn.mock.calls[0]?.[0]).toBe("friend-node-id");
  });
});

// ---------------------------------------------------------------------------
// hash-mismatch / corrupted-transfer verification (the skein/1 proxy_request
// fallback, delegated to @freqhole/reliquary/transfer's snatchBlob).
//
// the bulk/streamed verified download strategies get real cryptographic
// verification for free from iroh-blobs itself: midden's Rust implementation
// (midden/src/lib.rs's download_verified) parses the REQUESTED blake3_hash
// into an iroh_blobs::Hash and downloads via
// `blobs_downloader.download(HashAndFormat::raw(hash), ...)`, then reads the
// result back via `blobs_store.get_bytes(hash)` keyed by that SAME hash —
// iroh-blobs' content-addressed store verifies each chunk against the
// requested hash's BAO tree during the transfer itself (a
// DownloadProgressItem::Error/DownloadError surfaces as an Err before any
// bytes are ever returned to JS). a mismatching response is therefore
// rejected at the WASM/Rust layer, not silently handed back — so these
// strategies are deliberately NOT re-verified again here; doing so would be
// redundant, not a real gap. this is NOT tested here (would require a real
// iroh-blobs transfer, out of scope for a mocked unit test) but is recorded
// as the evidenced reasoning behind the design.
//
// the skein/1 proxy_request JSON fallback (used only when a peer is a
// tauri app whose rust backend doesn't accept the iroh-blobs ALPN) has NO
// such transport-level guarantee — it's a plain base64 JSON response. the
// transport package computes blake3 of the received bytes and rejects on
// mismatch — these tests prove that check actually catches a corrupted/
// malicious response instead of silently accepting it.
// ---------------------------------------------------------------------------

describe("snatchBlob — proxy_request fallback hash verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauriMode.mockReturnValue(false);
  });

  function mockProxyRequestNode(base64Payload: string) {
    return {
      // no download_verified_with_ensure_progress / download_verified_streaming_with_ensure
      // — forces strategy 3 (proxy_request), same as a real tauri-peer target.
      open_bi: createMockEnsureBlobProtocol(true),
      proxy_request: vi.fn(async () => ({
        status: 200,
        body: JSON.stringify({ success: true, data: { data: base64Payload, mime: "audio/mpeg" } }),
      })),
    };
  }

  it("rejects with a clear hash-mismatch error when the fallback's bytes don't match the expected blake3", async () => {
    const payload = new TextEncoder().encode("corrupted or tampered bytes");
    const base64Payload = btoa(String.fromCharCode(...payload));
    mockGetMiddenNode.mockResolvedValue(mockProxyRequestNode(base64Payload));
    // the computed hash of the (mocked) received bytes does NOT match the
    // hash the caller requested — simulating a corrupted/malicious response.
    mockHashBlake3.mockResolvedValue("actual-hash-of-tampered-bytes");

    await expect(
      snatchBlob(
        {
          blobId: "doc-blob-id",
          filename: "clip.mp3",
          mime: "audio/mpeg",
          size: payload.length,
          blake3: "expected-hash-of-real-content",
          domain: "audio",
        },
        { peer1: { nodeId: "remote-node-id" } }
      )
    ).rejects.toThrow("snatch hash mismatch");

    // a mismatch must never reach storeBlob (would persist corrupted/
    // mismatched content under a trusted-looking record).
    expect(mockStoreBlob).not.toHaveBeenCalled();
  });

  it("accepts the fallback's bytes when the computed hash matches the expected blake3 (positive control — proves the check isn't just always rejecting)", async () => {
    const payload = new TextEncoder().encode("genuine, untampered bytes");
    const base64Payload = btoa(String.fromCharCode(...payload));
    mockGetMiddenNode.mockResolvedValue(mockProxyRequestNode(base64Payload));
    mockHashBlake3.mockResolvedValue("expected-hash-of-real-content");
    mockGetBlobRecord.mockResolvedValue(null);
    mockStoreBlob.mockResolvedValueOnce({
      blob_id: "expected-hash-of-real-content",
      blake3: "expected-hash-of-real-content",
      sha256: "sha256-of-payload",
      filename: "clip.mp3",
      mime: "audio/mpeg",
      size: payload.length,
      blob_type: "original",
      parent_blob_id: null,
      metadata: { domain: "audio", source: "snatch" },
      created_at: Date.now(),
    });

    const result = await snatchBlob(
      {
        blobId: "doc-blob-id",
        filename: "clip.mp3",
        mime: "audio/mpeg",
        size: payload.length,
        blake3: "expected-hash-of-real-content",
        domain: "audio",
      },
      { peer1: { nodeId: "remote-node-id" } }
    );

    // blake3 is the canonical blob id now — the record is keyed by the
    // (verified) content hash, not the legacy sha256.
    expect(result.blobId).toBe("expected-hash-of-real-content");
    expect(result.sha256).toBe("sha256-of-payload");
    expect(mockStoreBlob).toHaveBeenCalledTimes(1);
    expect(mockStoreBlob.mock.calls[0][1]).toMatchObject({
      metadata: { domain: "audio", source: "snatch" },
    });
  });
});

// ---------------------------------------------------------------------------
// getThumbnailDataUrl — tauri blob_thumbnail dispatch path
// ---------------------------------------------------------------------------

describe("getThumbnailDataUrl — tauri blob_thumbnail path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // all tests in this suite run in tauri mode
    mockIsTauriMode.mockReturnValue(true);
  });

  it("returns a data URL when dispatch returns { data, mime }", async () => {
    const fakeB64 = btoa("webp-bytes");
    mockDispatch.mockImplementation(async (action: string) => {
      if (action === "blob_thumbnail") {
        return { data: fakeB64, mime: "image/webp" };
      }
      return null;
    });

    const result = await getThumbnailDataUrl("test-blake3-id", { size: 200 });

    expect(mockDispatch).toHaveBeenCalledWith("blob_thumbnail", {
      blake3: "test-blake3-id",
      size: 200,
    });
    expect(result).toBe(`data:image/webp;base64,${fakeB64}`);
  });

  it("returns null when dispatch returns { data: null }", async () => {
    mockDispatch.mockImplementation(async (action: string) => {
      if (action === "blob_thumbnail") {
        return { data: null };
      }
      return null;
    });

    const result = await getThumbnailDataUrl("unsupported-blob-id", { size: 200 });

    expect(result).toBeNull();
  });

  it("returns null when dispatch rejects (blob not found)", async () => {
    mockDispatch.mockRejectedValue(new Error("not found"));

    const result = await getThumbnailDataUrl("missing-blob-id", { size: 200 });

    expect(result).toBeNull();
  });

  it("passes size from options to dispatch payload", async () => {
    const fakeB64 = btoa("small-thumb");
    mockDispatch.mockImplementation(async (action: string) => {
      if (action === "blob_thumbnail") {
        return { data: fakeB64, mime: "image/webp" };
      }
      return null;
    });

    await getThumbnailDataUrl("some-blob-id", { size: 64 });

    expect(mockDispatch).toHaveBeenCalledWith("blob_thumbnail", {
      blake3: "some-blob-id",
      size: 64,
    });
  });
});

// ---------------------------------------------------------------------------
// browser-mode blob probing — ALPN mismatch regression
//
// found via live browser-to-browser testing (two loam tabs, no tauri): a
// browser-mode snatch/probe between two peers always fails with
// "no peer has the blob (all probes failed)", even when the peer genuinely
// has it. root cause, traced through real source across three repos:
//
// - `probeSinglePeer` (above, in this file) calls `nodeAny.ensure_blob(...)`
//   directly on whatever `getMiddenNode()` returns. in pure browser mode
//   that's the wasm `MiddenNode`'s own native `ensure_blob` method (see
//   `@freqhole/midden`'s `workers/midden-worker.ts` passthrough).
// - midden's native `ensure_blob`/`connect_to_peer` (midden/src/lib.rs)
//   dials the peer using `FREQHOLE_ALPN` (`"freqhole/1"`), and its own doc
//   comment says the receiving app is expected to route it: "for other
//   ALPNs, return a BiStream to JS... the caller should check stream.alpn()
//   to route the connection to the appropriate handler."
// - loam only ever registers "skein/1" (handleSkeinStream) and the friendz
//   ALPN as receiving handlers (see `standalone/boot.ts`,
//   `standalone/friendz-wiring.ts`) - nothing answers "freqhole/1".
// - tauri mode's equivalent call (`tauri-transport.ts`'s `ensure_blob` ->
//   rust `blob_iroh_probe`) correctly dials via `b"skein/1"` instead (see
//   skein's `tauri/src/commands.rs`) - matching the registered handler.
//   pure browser mode has no equivalent client-side implementation; it only
//   ever calls the node's native `ensure_blob`, which can never reach a
//   registered handler.
//
// this test reproduces the gap directly against real production code (the
// actual `IrohNetworkAdapter` from `@freqhole/reliquary/automerge`, and
// loam's actual `registerAlpnHandler("skein/1", handleSkeinStream)` call
// site), simulating exactly what midden's native ensure_blob does on the
// wire: dial the peer via FREQHOLE_ALPN and wait for a response.
// ---------------------------------------------------------------------------

describe("browser-mode blob probing — ALPN mismatch regression", () => {
  it("a stream on FREQHOLE_ALPN ('freqhole/1') - the ALPN midden's native ensure_blob actually dials - reaches a registered handler in skein's real browser-mode ALPN wiring", async () => {
    const mockMidden = createMockMidden();
    const adapter = new IrohNetworkAdapter({
      getNode: vi.fn(async () => mockMidden as any),
      getIdentity: vi.fn(async () => ({ node_id: "a".repeat(64) })),
      onIdentityChange: vi.fn(() => () => {}),
    });

    adapter.connect("local-peer-id" as any);
    // register both handlers as the real browser-mode boot sequence does
    // (see boot.ts ~416, friendz-wiring.ts ~242)
    adapter.registerAlpnHandler("skein/1", handleSkeinStream);
    adapter.registerAlpnHandler(DEFAULT_ENSURE_ALPN, createSkeinEnsureBlobHandler());
    await new Promise((r) => setTimeout(r, 20)); // let the accept loop start

    // simulate exactly what midden's native ensure_blob does on the wire:
    // dial the peer via FREQHOLE_ALPN, write the request, and wait for a
    // response. built directly with createMockBiStream (not
    // mockMidden.open_bi, whose test double ignores the alpn argument and
    // always defaults to the sync ALPN) so the stream is genuinely
    // addressed to "freqhole/1".
    const stream = createMockBiStream("peer-addr", "freqhole/1");
    mockMidden.pushIncoming(stream);
    await new Promise((r) => setTimeout(r, 20));
    stream.pushMessage(
      new TextEncoder().encode(
        JSON.stringify({ type: "ensure_blob_request", id: 1, blake3_hash: "a".repeat(64) })
      )
    );
    await new Promise((r) => setTimeout(r, 20));

    // desired/correct behavior: the peer answers the request.
    // the fix registers a "freqhole/1" handler that bridges to the
    // ensure-blob logic.
    expect(stream.close).not.toHaveBeenCalled();
    expect(stream._written.length).toBeGreaterThan(0);
  });
});

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
// real IndexedDB/OPFS access.
const mockGetBlobRecord = vi.fn<(blobId: string) => Promise<any>>();
const mockStoreBlob = vi.fn<(...args: any[]) => Promise<void>>();
const mockComputeSha256 = vi.fn<(data: ArrayBuffer) => Promise<string>>();
vi.mock("../storage/skein-blob-store", () => ({
  hasBlob: vi.fn(),
  getBlobRecord: (...args: any[]) => mockGetBlobRecord(...args),
  getBlobRecordBySha256: vi.fn(),
  getBlobRecordByBlake3: vi.fn(),
  getBlobObjectURL: vi.fn(),
  storeBlob: (...args: any[]) => mockStoreBlob(...args),
  computeSha256: (...args: any[]) => mockComputeSha256(...args),
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
// that this module transitively imports. hashBlake3 is controllable per
// test — it backs the defensive hash-verification check on the unverified
// proxy_request fallback download path (strategy 3 in
// downloadBlobBytesFromPeer).
const mockHashBlake3 = vi.fn<(bytes: Uint8Array) => Promise<string>>();
vi.mock("../workers/blob-worker-client", () => ({
  base64Decode: vi.fn(async (b64: string) =>
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  ),
  generateThumbnailDataUrl: vi.fn(async () => null),
  hashBlake3: (...args: any[]) => mockHashBlake3(...args),
}));

import {
  canSnatchToDisk,
  checkBlobLocality,
  formatUploadError,
  snatchBlob,
  snatchBlobToDisk,
  uploadFile,
} from "./file-utils";

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
        upload_id: expect.any(String),
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
        ensure_blob: vi.fn(async () => true),
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
        ensure_blob: vi.fn(async () => false),
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
      const ensureBlob = vi.fn(async () => true);
      const downloadFn = vi.fn(async () => payload);
      mockGetMiddenNode.mockResolvedValue({
        ensure_blob: ensureBlob,
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
      expect(ensureBlob).toHaveBeenCalledTimes(2);
      expect(downloadFn).toHaveBeenCalledTimes(1);
      expect(writable.close).not.toHaveBeenCalled();
      expect(mockStoreBlob).not.toHaveBeenCalled();
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
    const ensureBlob = vi.fn(async () => true);
    const downloadFn = vi.fn(() => download.promise);
    mockGetMiddenNode.mockResolvedValue({
      ensure_blob: ensureBlob,
      download_verified_with_ensure_progress: downloadFn,
    });
    mockComputeSha256.mockResolvedValue("sha256-of-payload");
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
    expect(ensureBlob).toHaveBeenCalledTimes(1);
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
    const ensureBlob = vi.fn(async () => true);
    const downloadFn = vi.fn(async () => new Uint8Array([9, 9, 9]));
    mockGetMiddenNode.mockResolvedValue({
      ensure_blob: ensureBlob,
      download_verified_with_ensure_progress: downloadFn,
    });
    mockComputeSha256.mockResolvedValue("sha256-of-payload");
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

    expect(ensureBlob).toHaveBeenCalledTimes(2);
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
    const ensureBlob = vi.fn(async () => true);
    const downloadFn = vi.fn(() => download.promise);
    mockGetMiddenNode.mockResolvedValue({
      ensure_blob: ensureBlob,
      download_verified_with_ensure_progress: downloadFn,
    });
    mockComputeSha256.mockResolvedValue("sha256-of-payload");
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
    const ensureBlob = vi.fn(async () => false);
    mockGetMiddenNode.mockResolvedValue({ ensure_blob: ensureBlob });

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

    expect(ensureBlob).toHaveBeenCalledTimes(3);
  });

  it("rejects with a single clear error (not a hang) when every peer's probe REJECTS outright (e.g. connection refused)", async () => {
    // a non-transient rejection message (doesn't match the /connection
    // (lost|closed)|stream closed|reset|broken/i retry regex in
    // probeSinglePeer) so this test doesn't pay the 1.5s transient-retry
    // delay — the point here is total-failure behavior, not the retry path.
    const ensureBlob = vi.fn(async () => {
      throw new Error("connection refused");
    });
    mockGetMiddenNode.mockResolvedValue({ ensure_blob: ensureBlob });

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
    // response). no download_verified_by_id_progress / proxy_request
    // fallback is configured, so downloadBlobBytesFromPeer's own "no
    // fallback available" error is what should surface.
    const ensureBlob = vi.fn(async () => true);
    const downloadFn = vi.fn(async () => {
      throw new Error("peer connection reset mid-transfer");
    });
    mockGetMiddenNode.mockResolvedValue({
      ensure_blob: ensureBlob,
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
    ).rejects.toThrow("iroh-blobs download failed — no fallback available");

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
      const ensureBlob = vi.fn(async () => true);
      const downloadFn = vi.fn(async () => {
        throw new Error("gone");
      });
      mockGetMiddenNode.mockResolvedValue({
        ensure_blob: ensureBlob,
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
// hash-mismatch / corrupted-transfer verification (downloadBlobBytesFromPeer).
//
// strategies 1/2 (iroh-blobs download_verified_with_ensure_progress /
// download_verified_by_id_progress) get real cryptographic verification for
// free from iroh-blobs itself: midden's Rust implementation
// (midden/src/lib.rs's download_verified) parses the REQUESTED blake3_hash
// into an iroh_blobs::Hash and downloads via
// `blobs_downloader.download(HashAndFormat::raw(hash), ...)`, then reads the
// result back via `blobs_store.get_bytes(hash)` keyed by that SAME hash —
// iroh-blobs' content-addressed store verifies each chunk against the
// requested hash's BAO tree during the transfer itself (a
// DownloadProgressItem::Error/DownloadError surfaces as an Err before any
// bytes are ever returned to JS). a mismatching response is therefore
// rejected at the WASM/Rust layer, not silently handed back — so these two
// strategies are deliberately NOT re-verified again here; doing so would be
// redundant, not a real gap. this is NOT tested here (would require a real
// iroh-blobs transfer, out of scope for a mocked unit test) but is recorded
// as the evidenced reasoning behind the design.
//
// strategy 3 (the skein/1 proxy_request JSON fallback, used only when a
// peer is a tauri app whose rust backend doesn't accept the iroh-blobs
// ALPN) has NO such transport-level guarantee — it's a plain base64 JSON
// response. file-utils.ts already computes blake3 of the received bytes in
// JS (via hashBlake3, reused from the blob worker rather than a new
// dependency) and rejects on mismatch — these tests prove that check
// actually catches a corrupted/malicious response instead of silently
// accepting it.
// ---------------------------------------------------------------------------

describe("downloadBlobBytesFromPeer — proxy_request fallback hash verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauriMode.mockReturnValue(false);
  });

  function mockProxyRequestNode(base64Payload: string) {
    return {
      // no download_verified_with_ensure_progress / download_verified_by_id_progress
      // — forces strategy 3 (proxy_request), same as a real tauri-peer target.
      ensure_blob: vi.fn(async () => true),
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
    mockComputeSha256.mockResolvedValue("sha256-of-payload");
    mockGetBlobRecord.mockResolvedValue(null);

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

    expect(result.blobId).toBe("sha256-of-payload");
    expect(mockStoreBlob).toHaveBeenCalledTimes(1);
  });
});

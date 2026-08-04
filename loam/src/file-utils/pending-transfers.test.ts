// ---------------------------------------------------------------------------
// unit tests for pending-transfers.ts's merge/enrichment logic — mocks every
// upstream data source (transfer-queue, transfer-progress, blob-canvas-refs,
// peer-names) so this file never touches real IndexedDB/tauri/wasm, mirroring
// the vi.mock-with-factory style used in snatch.test.ts.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingTransferEntry } from "./transfer-queue";
import type { AllTransferProgressEntry } from "../p2p/transfer-progress";

const mockListPendingTransfers = vi.fn<() => PendingTransferEntry[]>(() => []);
vi.mock("./transfer-queue", () => ({
  listPendingTransfers: (...args: any[]) => mockListPendingTransfers(...args),
}));

// the wildcard subscription is the module's own trigger for re-emitting —
// captured here so tests can push new outgoing-transfer snapshots on demand
// instead of waiting on a real 300ms poll loop.
let outgoingListener: ((entries: AllTransferProgressEntry[]) => void) | null = null;
const mockUnsubscribeOutgoing = vi.fn();
const mockSubscribeAllTransferProgress = vi.fn(
  (listener: (entries: AllTransferProgressEntry[]) => void) => {
    outgoingListener = listener;
    return mockUnsubscribeOutgoing;
  }
);
vi.mock("../p2p/transfer-progress", () => ({
  subscribeAllTransferProgress: (...args: any[]) => mockSubscribeAllTransferProgress(...args),
}));

const mockGetBlobCanvasRefs = vi.fn<(blobId: string, blake3?: string | null) => Promise<string[]>>(
  async () => []
);
vi.mock("./blob-canvas-refs", () => ({
  getBlobCanvasRefs: (...args: any[]) => mockGetBlobCanvasRefs(...args),
}));

const mockPeerNameFor = vi.fn<(nodeId: string) => string | null>(() => null);
vi.mock("../canvas/peer-names", () => ({
  peerNameFor: (...args: any[]) => mockPeerNameFor(...args),
}));

import { subscribeToPendingTransfers, type PendingTransferItem } from "./pending-transfers";

/** wait for `listener` to have been called at least once since the last reset. */
async function waitForEmit(listener: ReturnType<typeof vi.fn>): Promise<PendingTransferItem[]> {
  await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  return listener.mock.calls.at(-1)![0];
}

describe("pending-transfers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPendingTransfers.mockReturnValue([]);
    mockGetBlobCanvasRefs.mockResolvedValue([]);
    mockPeerNameFor.mockReturnValue(null);
    outgoingListener = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merges local queue entries and outgoing-serving rows into one list", async () => {
    mockListPendingTransfers.mockReturnValue([
      {
        id: "up-1",
        direction: "upload",
        state: "active",
        blobId: "blob-a",
        filename: "a.txt",
        startedAt: 1000,
      },
    ]);
    mockGetBlobCanvasRefs.mockResolvedValue(["canvas-1"]);
    mockPeerNameFor.mockReturnValue("alice");

    const listener = vi.fn();
    const unsub = subscribeToPendingTransfers(listener);
    try {
      // first emit fires from local-queue data alone; push an outgoing row
      // through the captured wildcard listener to exercise the merge.
      await waitForEmit(listener);
      outgoingListener?.([
        { peerId: "peer-1", blake3: "blob-b", fraction: 0.5, bytesSent: 50, totalSize: 100 },
      ]);

      const items = await vi.waitFor(() => {
        const last = listener.mock.calls.at(-1)?.[0] as PendingTransferItem[];
        expect(last.some((item) => item.direction === "serving")).toBe(true);
        return last;
      });

      const upload = items.find((item) => item.id === "up-1")!;
      expect(upload).toMatchObject({
        direction: "upload",
        state: "active",
        blobId: "blob-a",
        filename: "a.txt",
        canvasIds: ["canvas-1"],
        canPause: false,
        canCancel: true,
      });

      const serving = items.find((item) => item.direction === "serving")!;
      expect(serving).toMatchObject({
        id: "serving:peer-1:blob-b",
        state: "active",
        blobId: "blob-b",
        peerId: "peer-1",
        peerName: "alice",
        fraction: 0.5,
        canPause: false,
        canCancel: false,
      });
    } finally {
      unsub();
    }
  });

  it("marks an active download pausable, a queued one not", async () => {
    mockListPendingTransfers.mockReturnValue([
      { id: "dl-active", direction: "download", state: "active", startedAt: 1 },
      { id: "dl-queued", direction: "download", state: "queued", startedAt: 2 },
    ]);

    const listener = vi.fn();
    const unsub = subscribeToPendingTransfers(listener);
    try {
      const items = await waitForEmit(listener);
      expect(items.find((i) => i.id === "dl-active")).toMatchObject({
        canPause: true,
        canCancel: true,
      });
      expect(items.find((i) => i.id === "dl-queued")).toMatchObject({
        canPause: false,
        canCancel: true,
      });
    } finally {
      unsub();
    }
  });

  it("omits canvasIds/peerName when the enrichment sources come back empty", async () => {
    mockListPendingTransfers.mockReturnValue([
      { id: "dl-1", direction: "download", state: "active", blobId: "blob-c", startedAt: 1 },
    ]);
    mockGetBlobCanvasRefs.mockResolvedValue([]);

    const listener = vi.fn();
    const unsub = subscribeToPendingTransfers(listener);
    try {
      const items = await waitForEmit(listener);
      const item = items.find((i) => i.id === "dl-1")!;
      expect(item.canvasIds).toBeUndefined();
    } finally {
      unsub();
    }
  });

  it("is resilient when getBlobCanvasRefs rejects", async () => {
    mockListPendingTransfers.mockReturnValue([
      { id: "dl-2", direction: "download", state: "active", blobId: "blob-d", startedAt: 1 },
    ]);
    mockGetBlobCanvasRefs.mockRejectedValue(new Error("boom"));

    const listener = vi.fn();
    const unsub = subscribeToPendingTransfers(listener);
    try {
      const items = await waitForEmit(listener);
      const item = items.find((i) => i.id === "dl-2")!;
      expect(item.canvasIds).toBeUndefined();
    } finally {
      unsub();
    }
  });

  it("unsubscribes from the outgoing-transfer feed once the last listener stops", async () => {
    const listener = vi.fn();
    const unsub = subscribeToPendingTransfers(listener);
    await waitForEmit(listener);
    expect(mockSubscribeAllTransferProgress).toHaveBeenCalledTimes(1);

    unsub();
    expect(mockUnsubscribeOutgoing).toHaveBeenCalledTimes(1);
  });
});

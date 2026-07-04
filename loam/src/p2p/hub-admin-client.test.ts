// ---------------------------------------------------------------------------
// unit tests for hub-admin-client — request/response wire shape handling,
// mocking the underlying open_bi transport (no real iroh networking).
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import { cbor } from "@automerge/automerge-repo";
import {
  createHubAdminClient,
  hubAdminTransportFromAdapter,
  type HubAdminResponse,
  type HubAdminTransport,
} from "./hub-admin-client";
import type { MiddenStreamNode } from "./iroh-network-adapter";

const PEER_NODE_ID = "a".repeat(64);

/**
 * build a fake `MiddenStreamNode` whose `open_bi` returns a fake raw bi
 * stream: `write_raw_and_finish` records the bytes it was called with,
 * `read_to_end` returns a fixed, pre-encoded CBOR response.
 */
function createFakeNode(wireResponse: unknown) {
  const encodedResponse = cbor.encode(wireResponse);
  let writtenBytes: Uint8Array | null = null;
  let closed = false;
  const openBi = vi.fn(async (peerAddr: string, alpn: string) => {
    return {
      peer_node_id: () => peerAddr,
      alpn: () => alpn,
      write_message: vi.fn(),
      read_message: vi.fn(),
      write_raw_and_finish: vi.fn(async (data: Uint8Array) => {
        writtenBytes = data;
      }),
      read_to_end: vi.fn(async (_maxSize: number) => encodedResponse),
      close: vi.fn(() => {
        closed = true;
      }),
    };
  });

  const node: MiddenStreamNode = {
    node_id: () => "self-node-id",
    open_bi: openBi as unknown as MiddenStreamNode["open_bi"],
    accept: vi.fn(async () => null),
  };

  return {
    node,
    openBi,
    getWrittenRequest: () => cbor.decode(writtenBytes!),
    isClosed: () => closed,
  };
}

function transportFor(node: MiddenStreamNode): HubAdminTransport {
  return { getMidden: () => Promise.resolve(node) };
}

describe("hub-admin-client", () => {
  describe("hubAdminAllow", () => {
    it("sends the correct wire request and parses an Allowed response", async () => {
      const fake = createFakeNode({ Allowed: { node_id: "target-node", status: "allowed" } });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminAllow(PEER_NODE_ID, "target-node");

      expect(fake.openBi).toHaveBeenCalledWith(PEER_NODE_ID, "iroh/skein-hub-admin/1");
      expect(fake.getWrittenRequest()).toEqual({ Allow: { node_id: "target-node" } });
      expect(response).toEqual({ kind: "allowed", nodeId: "target-node", status: "allowed" });
      expect(fake.isClosed()).toBe(true);
    });
  });

  describe("hubAdminList", () => {
    it("sends the unit-variant List request and parses a List response", async () => {
      const fake = createFakeNode({
        List: {
          friends: [
            {
              node_id: "node-a",
              status: "accepted",
              updated_at: 1000,
              username: "alice",
              bio: "hi",
              avatar_data_url: "data:image/webp;base64,abc",
              is_admin: true,
            },
            {
              node_id: "node-b",
              status: "allowed",
              updated_at: 2000,
              username: "",
              bio: "",
              avatar_data_url: "",
              is_admin: false,
            },
          ],
        },
      });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminList(PEER_NODE_ID);

      expect(fake.getWrittenRequest()).toEqual("List");
      expect(response).toEqual({
        kind: "list",
        friends: [
          {
            nodeId: "node-a",
            status: "accepted",
            updatedAt: 1000,
            username: "alice",
            bio: "hi",
            avatarDataUrl: "data:image/webp;base64,abc",
            isAdmin: true,
          },
          {
            nodeId: "node-b",
            status: "allowed",
            updatedAt: 2000,
            username: "",
            bio: "",
            avatarDataUrl: "",
            isAdmin: false,
          },
        ],
      });
    });
  });

  describe("hubAdminBlock", () => {
    it("sends the correct wire request and parses a Blocked response", async () => {
      const fake = createFakeNode({ Blocked: { node_id: "target-node" } });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminBlock(PEER_NODE_ID, "target-node");

      expect(fake.getWrittenRequest()).toEqual({ Block: { node_id: "target-node" } });
      expect(response).toEqual({ kind: "blocked", nodeId: "target-node" });
    });
  });

  describe("hubAdminPromoteAdmin / hubAdminDemoteAdmin", () => {
    it("sends the correct wire requests and parses AdminChanged responses", async () => {
      const promoteFake = createFakeNode({
        AdminChanged: { node_id: "target-node", is_admin: true },
      });
      const promoteClient = createHubAdminClient(transportFor(promoteFake.node));
      const promoteResponse = await promoteClient.hubAdminPromoteAdmin(
        PEER_NODE_ID,
        "target-node"
      );
      expect(promoteFake.getWrittenRequest()).toEqual({
        PromoteAdmin: { node_id: "target-node" },
      });
      expect(promoteResponse).toEqual({
        kind: "adminChanged",
        nodeId: "target-node",
        isAdmin: true,
      });

      const demoteFake = createFakeNode({
        AdminChanged: { node_id: "target-node", is_admin: false },
      });
      const demoteClient = createHubAdminClient(transportFor(demoteFake.node));
      const demoteResponse = await demoteClient.hubAdminDemoteAdmin(PEER_NODE_ID, "target-node");
      expect(demoteFake.getWrittenRequest()).toEqual({ DemoteAdmin: { node_id: "target-node" } });
      expect(demoteResponse).toEqual({
        kind: "adminChanged",
        nodeId: "target-node",
        isAdmin: false,
      });
    });
  });

  describe("hubAdminRemove", () => {
    it("sends the correct wire request and parses a Removed response", async () => {
      const fake = createFakeNode({ Removed: { node_id: "target-node" } });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminRemove(PEER_NODE_ID, "target-node");

      expect(fake.getWrittenRequest()).toEqual({ Remove: { node_id: "target-node" } });
      expect(response).toEqual({ kind: "removed", nodeId: "target-node" });
    });
  });

  describe("hubAdminListPendingKnocks", () => {
    it("sends the unit-variant ListPendingKnocks request and parses a PendingKnocks response", async () => {
      const fake = createFakeNode({
        PendingKnocks: {
          knocks: [
            {
              canvas_doc_id: "canvas-1",
              knock_id: "requester-node",
              requester_node_id: "requester-node",
              requester_username: "alice",
              message: "hi, it's me",
              knocked_at: 1_700_000_000,
            },
          ],
        },
      });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminListPendingKnocks(PEER_NODE_ID);

      expect(fake.getWrittenRequest()).toEqual("ListPendingKnocks");
      expect(response).toEqual({
        kind: "pendingKnocks",
        knocks: [
          {
            canvasDocId: "canvas-1",
            knockId: "requester-node",
            requesterNodeId: "requester-node",
            requesterUsername: "alice",
            message: "hi, it's me",
            knockedAt: 1_700_000_000,
          },
        ],
      });
    });

    it("returns an empty list when the hub holds no pending knocks", async () => {
      const fake = createFakeNode({ PendingKnocks: { knocks: [] } });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminListPendingKnocks(PEER_NODE_ID);

      expect(response).toEqual({ kind: "pendingKnocks", knocks: [] });
    });
  });

  describe("NotAdmin / Error responses", () => {
    it("parses a bare NotAdmin response for any request kind", async () => {
      const fake = createFakeNode("NotAdmin");
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminList(PEER_NODE_ID);

      expect(response).toEqual({ kind: "notAdmin" });
    });

    it("parses an Error response", async () => {
      const fake = createFakeNode({ Error: { message: "node_id cannot be empty" } });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminAllow(PEER_NODE_ID, "");

      expect(response).toEqual({ kind: "error", message: "node_id cannot be empty" });
    });
  });

  it("throws on an unrecognized wire response shape", async () => {
    const fake = createFakeNode({ SomethingUnexpected: {} });
    const client = createHubAdminClient(transportFor(fake.node));

    await expect(client.hubAdminList(PEER_NODE_ID)).rejects.toThrow(
      /unrecognized AdminResponse wire shape/
    );
  });

  describe("hubAdminTransportFromAdapter", () => {
    it("delegates getMidden() to the adapter's getNode()", async () => {
      const fake = createFakeNode({ List: { friends: [] } });
      const adapter = { getNode: vi.fn(async () => fake.node) };

      const transport = hubAdminTransportFromAdapter(adapter);
      const node = await transport.getMidden();

      expect(adapter.getNode).toHaveBeenCalledOnce();
      expect(node).toBe(fake.node);
    });
  });

  it("multiple client methods reuse the same transport independently (no shared mutable state)", async () => {
    const allowFake = createFakeNode({ Allowed: { node_id: "x", status: "allowed" } });
    const listFake = createFakeNode({ List: { friends: [] } });

    const results: HubAdminResponse[] = [];
    const clientA = createHubAdminClient(transportFor(allowFake.node));
    const clientB = createHubAdminClient(transportFor(listFake.node));

    results.push(await clientA.hubAdminAllow(PEER_NODE_ID, "x"));
    results.push(await clientB.hubAdminList(PEER_NODE_ID));

    expect(results[0]).toEqual({ kind: "allowed", nodeId: "x", status: "allowed" });
    expect(results[1]).toEqual({ kind: "list", friends: [] });
  });
});

// ---------------------------------------------------------------------------
// storage / disk management wire shapes
// ---------------------------------------------------------------------------

describe("hubAdminDiskUsage", () => {
  it("sends DiskUsage unit request and parses DiskUsage response with new field names", async () => {
    const fake = createFakeNode({
      DiskUsage: {
        total_blob_bytes: 1_000_000,
        blob_count: 42,
        disk_available_bytes: 500_000_000,
        disk_total_bytes: 1_000_000_000,
        soft_deleted_blob_bytes: 8_192,
        soft_deleted_blob_count: 3,
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminDiskUsage(PEER_NODE_ID);

    expect(fake.getWrittenRequest()).toEqual("DiskUsage");
    expect(response).toEqual({
      kind: "diskUsage",
      usage: {
        totalBlobBytes: 1_000_000,
        blobCount: 42,
        diskAvailableBytes: 500_000_000,
        diskTotalBytes: 1_000_000_000,
        softDeletedBlobBytes: 8_192,
        softDeletedBlobCount: 3,
      },
    });
  });

  it("handles null disk_available/total_bytes", async () => {
    const fake = createFakeNode({
      DiskUsage: {
        total_blob_bytes: 0,
        blob_count: 0,
        disk_available_bytes: null,
        disk_total_bytes: null,
        soft_deleted_blob_bytes: 0,
        soft_deleted_blob_count: 0,
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminDiskUsage(PEER_NODE_ID);

    expect(response).toMatchObject({
      kind: "diskUsage",
      usage: { diskAvailableBytes: null, diskTotalBytes: null },
    });
  });
});

describe("hubAdminCanvasUsage", () => {
  it("sends CanvasUsage unit request and parses CanvasUsage response", async () => {
    const fake = createFakeNode({
      CanvasUsage: {
        canvases: [
          { canvas_doc_id: "doc-abc", blob_count: 5, total_bytes: 2048 },
          { canvas_doc_id: "doc-xyz", blob_count: 0, total_bytes: 0 },
        ],
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminCanvasUsage(PEER_NODE_ID);

    expect(fake.getWrittenRequest()).toEqual("CanvasUsage");
    expect(response).toEqual({
      kind: "canvasUsage",
      canvases: [
        { canvasDocId: "doc-abc", blobCount: 5, totalBytes: 2048 },
        { canvasDocId: "doc-xyz", blobCount: 0, totalBytes: 0 },
      ],
    });
  });
});

describe("hubAdminBlobUsage", () => {
  it("sends BlobUsage unit request and parses BlobUsage response", async () => {
    const fake = createFakeNode({
      BlobUsage: {
        blobs: [
          { blake3: "aabbcc", filename: "photo.jpg", mime: "image/jpeg", size: 4096, external: false, soft_deleted: false },
          { blake3: "ddeeff", filename: null, mime: null, size: 512, external: true, soft_deleted: true },
        ],
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminBlobUsage(PEER_NODE_ID);

    expect(fake.getWrittenRequest()).toEqual("BlobUsage");
    expect(response).toEqual({
      kind: "blobUsage",
      blobs: [
        { blake3: "aabbcc", filename: "photo.jpg", mime: "image/jpeg", size: 4096, external: false, softDeleted: false },
        { blake3: "ddeeff", filename: null, mime: null, size: 512, external: true, softDeleted: true },
      ],
    });
  });
});

describe("hubAdminListSoftDeleted", () => {
  it("sends ListSoftDeleted unit request and parses SoftDeleted response with new shape", async () => {
    const fake = createFakeNode({
      SoftDeleted: {
        blobs: [
          {
            blake3: "aabbcc",
            filename: "old-photo.jpg",
            mime: "image/jpeg",
            size: 8192,
            soft_deleted_at: 1_700_000_000,
            soft_deleted_by: "node-admin-123",
          },
        ],
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminListSoftDeleted(PEER_NODE_ID);

    expect(fake.getWrittenRequest()).toEqual("ListSoftDeleted");
    expect(response).toEqual({
      kind: "softDeleted",
      blobs: [
        {
          blake3: "aabbcc",
          filename: "old-photo.jpg",
          mime: "image/jpeg",
          size: 8192,
          softDeletedAt: 1_700_000_000,
          softDeletedBy: "node-admin-123",
        },
      ],
    });
  });

  it("returns empty list when no soft-deleted blobs", async () => {
    const fake = createFakeNode({ SoftDeleted: { blobs: [] } });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminListSoftDeleted(PEER_NODE_ID);

    expect(response).toEqual({ kind: "softDeleted", blobs: [] });
  });
});

describe("hubAdminSoftDeleteBlobs", () => {
  it("sends SoftDeleteBlobs request and parses BlobsMutation response", async () => {
    const fake = createFakeNode({ BlobsMutation: { affected: 2, failed: [] } });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminSoftDeleteBlobs(PEER_NODE_ID, ["hash1", "hash2"]);

    expect(fake.getWrittenRequest()).toEqual({ SoftDeleteBlobs: { blake3s: ["hash1", "hash2"] } });
    expect(response).toEqual({ kind: "blobsMutation", affected: 2, failed: [] });
  });

  it("reports failures in BlobsMutation", async () => {
    const fake = createFakeNode({ BlobsMutation: { affected: 1, failed: ["missing-hash"] } });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminSoftDeleteBlobs(PEER_NODE_ID, ["ok-hash", "missing-hash"]);

    expect(response).toEqual({ kind: "blobsMutation", affected: 1, failed: ["missing-hash"] });
  });
});

describe("hubAdminRestoreBlobs", () => {
  it("sends RestoreBlobs request and parses BlobsMutation response", async () => {
    const fake = createFakeNode({ BlobsMutation: { affected: 1, failed: [] } });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminRestoreBlobs(PEER_NODE_ID, ["hash1"]);

    expect(fake.getWrittenRequest()).toEqual({ RestoreBlobs: { blake3s: ["hash1"] } });
    expect(response).toEqual({ kind: "blobsMutation", affected: 1, failed: [] });
  });
});

describe("hubAdminHardDeleteBlobs", () => {
  it("sends HardDeleteBlobs with all=false for targeted deletion", async () => {
    const fake = createFakeNode({ BlobsMutation: { affected: 1, failed: [] } });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminHardDeleteBlobs(PEER_NODE_ID, ["hash1"]);

    expect(fake.getWrittenRequest()).toEqual({
      HardDeleteBlobs: { blake3s: ["hash1"], all: false },
    });
    expect(response).toEqual({ kind: "blobsMutation", affected: 1, failed: [] });
  });

  it("sends HardDeleteBlobs with all=true to purge all soft-deleted blobs", async () => {
    const fake = createFakeNode({ BlobsMutation: { affected: 5, failed: [] } });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminHardDeleteBlobs(PEER_NODE_ID, [], true);

    expect(fake.getWrittenRequest()).toEqual({
      HardDeleteBlobs: { blake3s: [], all: true },
    });
    expect(response).toEqual({ kind: "blobsMutation", affected: 5, failed: [] });
  });
});

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

  describe("hubAdminApproveKnock / hubAdminDeclineKnock", () => {
    it("sends the correct wire request and parses a KnockDecided response for an approval", async () => {
      const fake = createFakeNode({
        KnockDecided: { canvas_doc_id: "canvas-1", requester_node_id: "requester-node" },
      });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminApproveKnock(
        PEER_NODE_ID,
        "canvas-1",
        "requester-node",
        "member"
      );

      expect(fake.getWrittenRequest()).toEqual({
        ApproveKnock: {
          canvas_doc_id: "canvas-1",
          requester_node_id: "requester-node",
          role: "member",
        },
      });
      expect(response).toEqual({
        kind: "knockDecided",
        canvasDocId: "canvas-1",
        requesterNodeId: "requester-node",
      });
    });

    it("sends the correct wire request and parses a KnockDecided response for a decline", async () => {
      const fake = createFakeNode({
        KnockDecided: { canvas_doc_id: "canvas-1", requester_node_id: "requester-node" },
      });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminDeclineKnock(PEER_NODE_ID, "canvas-1", "requester-node");

      expect(fake.getWrittenRequest()).toEqual({
        DeclineKnock: { canvas_doc_id: "canvas-1", requester_node_id: "requester-node" },
      });
      expect(response).toEqual({
        kind: "knockDecided",
        canvasDocId: "canvas-1",
        requesterNodeId: "requester-node",
      });
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

  it("coerces BigInt u64 fields to numbers (cbor decodes rust u64 as BigInt)", async () => {
    // regression: BigInt sizes reaching formatFileSize threw
    // "Cannot mix BigInt and other types"
    const fake = createFakeNode({
      DiskUsage: {
        total_blob_bytes: 262_144_000n,
        blob_count: 7n,
        disk_available_bytes: 500_000_000_000n,
        disk_total_bytes: 1_000_000_000_000n,
        soft_deleted_blob_bytes: 0n,
        soft_deleted_blob_count: 0n,
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminDiskUsage(PEER_NODE_ID);

    expect(response).toEqual({
      kind: "diskUsage",
      usage: {
        totalBlobBytes: 262_144_000,
        blobCount: 7,
        diskAvailableBytes: 500_000_000_000,
        diskTotalBytes: 1_000_000_000_000,
        softDeletedBlobBytes: 0,
        softDeletedBlobCount: 0,
      },
    });
  });
});

describe("hubAdminCanvasUsage", () => {
  it("sends CanvasUsage struct request and parses CanvasUsage response with total", async () => {
    const fake = createFakeNode({
      CanvasUsage: {
        canvases: [
          { canvas_doc_id: "doc-abc", blob_count: 5, total_bytes: 2048 },
          { canvas_doc_id: "doc-xyz", blob_count: 0, total_bytes: 0 },
        ],
        total: 7,
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminCanvasUsage(PEER_NODE_ID);

    expect(fake.getWrittenRequest()).toEqual({ CanvasUsage: { offset: 0, limit: 50 } });
    expect(response).toEqual({
      kind: "canvasUsage",
      total: 7,
      canvases: [
        { canvasDocId: "doc-abc", blobCount: 5, totalBytes: 2048 },
        { canvasDocId: "doc-xyz", blobCount: 0, totalBytes: 0 },
      ],
    });
  });

  it("passes pagination params as offset/limit in the struct variant", async () => {
    const fake = createFakeNode({ CanvasUsage: { canvases: [], total: 42 } });
    const client = createHubAdminClient(transportFor(fake.node));

    await client.hubAdminCanvasUsage(PEER_NODE_ID, 20, 10);

    expect(fake.getWrittenRequest()).toEqual({ CanvasUsage: { offset: 20, limit: 10 } });
  });
});

describe("hubAdminBlobUsage", () => {
  it("sends BlobUsage struct request and parses BlobUsage response with total", async () => {
    const fake = createFakeNode({
      BlobUsage: {
        blobs: [
          { blake3: "aabbcc", filename: "photo.jpg", mime: "image/jpeg", size: 4096, external: false, soft_deleted: false },
          { blake3: "ddeeff", filename: null, mime: null, size: 512, external: true, soft_deleted: true },
        ],
        total: 2,
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminBlobUsage(PEER_NODE_ID);

    expect(fake.getWrittenRequest()).toEqual({ BlobUsage: { offset: 0, limit: 50 } });
    expect(response).toEqual({
      kind: "blobUsage",
      total: 2,
      blobs: [
        { blake3: "aabbcc", filename: "photo.jpg", mime: "image/jpeg", size: 4096, external: false, softDeleted: false },
        { blake3: "ddeeff", filename: null, mime: null, size: 512, external: true, softDeleted: true },
      ],
    });
  });

  it("passes pagination params as offset/limit in the struct variant", async () => {
    const fake = createFakeNode({ BlobUsage: { blobs: [], total: 100 } });
    const client = createHubAdminClient(transportFor(fake.node));

    await client.hubAdminBlobUsage(PEER_NODE_ID, 10, 10);

    expect(fake.getWrittenRequest()).toEqual({ BlobUsage: { offset: 10, limit: 10 } });
  });
});

describe("hubAdminListSoftDeleted", () => {
  it("sends ListSoftDeleted struct request and parses SoftDeleted response with total", async () => {
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
        total: 1,
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminListSoftDeleted(PEER_NODE_ID);

    expect(fake.getWrittenRequest()).toEqual({ ListSoftDeleted: { offset: 0, limit: 50 } });
    expect(response).toEqual({
      kind: "softDeleted",
      total: 1,
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
    const fake = createFakeNode({ SoftDeleted: { blobs: [], total: 0 } });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminListSoftDeleted(PEER_NODE_ID);

    expect(response).toEqual({ kind: "softDeleted", total: 0, blobs: [] });
  });

  it("passes pagination params as offset/limit in the struct variant", async () => {
    const fake = createFakeNode({ SoftDeleted: { blobs: [], total: 5 } });
    const client = createHubAdminClient(transportFor(fake.node));

    await client.hubAdminListSoftDeleted(PEER_NODE_ID, 5, 10);

    expect(fake.getWrittenRequest()).toEqual({ ListSoftDeleted: { offset: 5, limit: 10 } });
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

describe("hubAdminUnsyncCanvas", () => {
  it("sends UnsyncCanvas struct request and parses CanvasUnsynced response", async () => {
    const fake = createFakeNode({
      CanvasUnsynced: { canvas_doc_id: "canvas-doc-abc", swept: 3 },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminUnsyncCanvas(PEER_NODE_ID, "canvas-doc-abc");

    expect(fake.getWrittenRequest()).toEqual({
      UnsyncCanvas: { canvas_doc_id: "canvas-doc-abc" },
    });
    expect(response).toEqual({
      kind: "canvasUnsynced",
      canvasDocId: "canvas-doc-abc",
      swept: 3,
    });
  });

  it("handles a zero swept count", async () => {
    const fake = createFakeNode({
      CanvasUnsynced: { canvas_doc_id: "canvas-empty", swept: 0 },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminUnsyncCanvas(PEER_NODE_ID, "canvas-empty");

    expect(response).toEqual({ kind: "canvasUnsynced", canvasDocId: "canvas-empty", swept: 0 });
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

// ---------------------------------------------------------------------------
// hub profile wire shapes
// ---------------------------------------------------------------------------

describe("hubAdminGetProfile", () => {
  it("sends unit-variant GetHubProfile request and parses HubProfile response", async () => {
    const fake = createFakeNode({
      HubProfile: { username: "myhub", bio: "a relay hub", accent_color: 0x6366f1, avatar_data_url: "data:image/webp;base64,abc" },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminGetProfile(PEER_NODE_ID);

    expect(fake.getWrittenRequest()).toEqual("GetHubProfile");
    expect(response).toEqual({
      kind: "hubProfile",
      profile: { username: "myhub", bio: "a relay hub", accentColor: 0x6366f1, avatarDataUrl: "data:image/webp;base64,abc" },
    });
  });

  it("handles an empty profile (fresh hub with no profile set)", async () => {
    const fake = createFakeNode({
      HubProfile: { username: "", bio: "", accent_color: 0, avatar_data_url: "" },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminGetProfile(PEER_NODE_ID);

    expect(response).toEqual({
      kind: "hubProfile",
      profile: { username: "", bio: "", accentColor: 0, avatarDataUrl: "" },
    });
  });
});

describe("hubAdminSetProfile", () => {
  it("sends SetHubProfile struct request and parses HubProfile response", async () => {
    const fake = createFakeNode({
      HubProfile: { username: "updated-hub", bio: "new bio", accent_color: 0xd946ef, avatar_data_url: "" },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminSetProfile(PEER_NODE_ID, {
      username: "updated-hub",
      bio: "new bio",
      accentColor: 0xd946ef,
    });

    expect(fake.getWrittenRequest()).toEqual({
      SetHubProfile: { username: "updated-hub", bio: "new bio", accent_color: 0xd946ef },
    });
    expect(response).toEqual({
      kind: "hubProfile",
      profile: { username: "updated-hub", bio: "new bio", accentColor: 0xd946ef, avatarDataUrl: "" },
    });
  });

  it("sends null fields when opts are omitted — hub-side leaves those fields unchanged", async () => {
    const fake = createFakeNode({
      HubProfile: { username: "unchanged", bio: "", accent_color: 0, avatar_data_url: "" },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    await client.hubAdminSetProfile(PEER_NODE_ID, {});

    expect(fake.getWrittenRequest()).toEqual({
      SetHubProfile: { username: null, bio: null, accent_color: null },
    });
  });
});

describe("hubAdminSetAvatar", () => {
  it("sends SetHubAvatar struct request and parses HubProfile response", async () => {
    const fake = createFakeNode({
      HubProfile: { username: "hub", bio: "", accent_color: 0, avatar_data_url: "data:image/webp;base64,xyz" },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminSetAvatar(PEER_NODE_ID, "base64data==");

    expect(fake.getWrittenRequest()).toEqual({ SetHubAvatar: { image_base64: "base64data==" } });
    expect(response).toEqual({
      kind: "hubProfile",
      profile: { username: "hub", bio: "", accentColor: 0, avatarDataUrl: "data:image/webp;base64,xyz" },
    });
  });
});

describe("hubAdminCanvasBlobs", () => {
  it("sends CanvasBlobs struct request and parses CanvasBlobs response", async () => {
    const fake = createFakeNode({
      CanvasBlobs: {
        canvas_doc_id: "canvas-abc",
        blobs: [
          { blake3: "aa", filename: "img.png", mime: "image/png", size: 2048, external: false, soft_deleted: false },
        ],
        total: 1,
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminCanvasBlobs(PEER_NODE_ID, "canvas-abc");

    expect(fake.getWrittenRequest()).toEqual({ CanvasBlobs: { canvas_doc_id: "canvas-abc", offset: 0, limit: 50 } });
    expect(response).toEqual({
      kind: "canvasBlobs",
      canvasDocId: "canvas-abc",
      total: 1,
      blobs: [{ blake3: "aa", filename: "img.png", mime: "image/png", size: 2048, external: false, softDeleted: false }],
    });
  });

  it("passes pagination params as canvas_doc_id / offset / limit", async () => {
    const fake = createFakeNode({ CanvasBlobs: { canvas_doc_id: "canvas-xyz", blobs: [], total: 42 } });
    const client = createHubAdminClient(transportFor(fake.node));

    await client.hubAdminCanvasBlobs(PEER_NODE_ID, "canvas-xyz", 10, 5);

    expect(fake.getWrittenRequest()).toEqual({ CanvasBlobs: { canvas_doc_id: "canvas-xyz", offset: 10, limit: 5 } });
  });

  it("coerces BigInt size and total fields to numbers (cbor decodes rust u64 as BigInt)", async () => {
    const fake = createFakeNode({
      CanvasBlobs: {
        canvas_doc_id: "canvas-bigint",
        blobs: [
          { blake3: "bb", filename: null, mime: null, size: 1_073_741_824n, external: false, soft_deleted: false },
        ],
        total: 1n,
      },
    });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminCanvasBlobs(PEER_NODE_ID, "canvas-bigint");

    expect(response).toEqual({
      kind: "canvasBlobs",
      canvasDocId: "canvas-bigint",
      total: 1,
      blobs: [{ blake3: "bb", filename: null, mime: null, size: 1_073_741_824, external: false, softDeleted: false }],
    });
  });

  it("returns empty blob list when the canvas has no blobs", async () => {
    const fake = createFakeNode({ CanvasBlobs: { canvas_doc_id: "canvas-empty", blobs: [], total: 0 } });
    const client = createHubAdminClient(transportFor(fake.node));

    const response = await client.hubAdminCanvasBlobs(PEER_NODE_ID, "canvas-empty");

    expect(response).toEqual({ kind: "canvasBlobs", canvasDocId: "canvas-empty", total: 0, blobs: [] });
  });
});

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
            { node_id: "node-a", status: "accepted", updated_at: 1000 },
            { node_id: "node-b", status: "allowed", updated_at: 2000 },
          ],
        },
      });
      const client = createHubAdminClient(transportFor(fake.node));

      const response = await client.hubAdminList(PEER_NODE_ID);

      expect(fake.getWrittenRequest()).toEqual("List");
      expect(response).toEqual({
        kind: "list",
        friends: [
          { nodeId: "node-a", status: "accepted", updatedAt: 1000 },
          { nodeId: "node-b", status: "allowed", updatedAt: 2000 },
        ],
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

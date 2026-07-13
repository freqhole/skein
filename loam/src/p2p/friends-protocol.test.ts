// ---------------------------------------------------------------------------
// unit tests for the FriendzProtocol adapter
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FriendzProtocol, HEARTBEAT_TIMEOUT_MS, type FriendzProtocolOptions, type GossipDigestMessage } from "./friends-protocol";
import type { BiStreamLike, MiddenStreamNode } from "./iroh-network-adapter";
import { FRIENDZ_ALPN } from "./iroh-network-adapter";

// ---------------------------------------------------------------------------
// exercises this adapter's own responsibility: translating skein's
// friend/presence/knock/canvas concepts to and from the shared
// `@freqhole/haruspex/protocol` wire format. plain codec round-tripping of
// the shared protocol's own message shapes is haruspex's own test
// responsibility (ts/src/protocol/*.test.ts, validated against the rust
// fixtures) - not re-tested here.
// ---------------------------------------------------------------------------

function createMockBiStream(peerId: string, alpn: string = FRIENDZ_ALPN) {
  const stream = {
    _messageQueue: [] as (Uint8Array | null)[],
    _written: [] as Uint8Array[],
    _closed: false,
    _readResolvers: [] as ((value: Uint8Array | null) => void)[],

    peer_node_id: () => peerId,
    alpn: () => alpn,

    write_message: vi.fn(async (data: Uint8Array) => {
      stream._written.push(data);
    }),

    read_message: vi.fn(async (): Promise<Uint8Array | null> => {
      if (stream._messageQueue.length > 0) {
        return stream._messageQueue.shift()!;
      }
      return new Promise<Uint8Array | null>((resolve) => {
        stream._readResolvers.push(resolve);
      });
    }),

    close: vi.fn(() => {
      stream._closed = true;
      for (const resolve of stream._readResolvers) {
        resolve(null);
      }
      stream._readResolvers = [];
    }),

    pushMessage(data: Uint8Array | null) {
      if (stream._readResolvers.length > 0) {
        stream._readResolvers.shift()!(data);
      } else {
        stream._messageQueue.push(data);
      }
    },

    /** feed a raw haruspex wire message (core or app-extension) as an
     *  incoming read, encoded exactly as the shared protocol's codec
     *  would encode it over the wire. */
    pushWire(msg: Record<string, unknown>) {
      this.pushMessage(new TextEncoder().encode(JSON.stringify(msg)));
    },
  };
  return stream;
}

type MockBiStream = ReturnType<typeof createMockBiStream>;

function createMockMidden(nodeId: string = "a".repeat(64)) {
  const midden = {
    node_id: () => nodeId,
    open_bi: vi.fn(async (_addr: string, _alpn: string) => {
      return createMockBiStream(_addr, _alpn);
    }),
    accept: vi.fn(async () => null),
  };
  return midden;
}

type MockMidden = ReturnType<typeof createMockMidden>;

function flush(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** parse the last message written to `stream` as the raw json object sent
 *  on the wire - lets tests assert on exact field names/shape rather than
 *  just this app's own decoded/translated shape. */
function lastWireJson(stream: MockBiStream): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(stream._written[stream._written.length - 1]));
}

function defaultOptions(overrides: Partial<FriendzProtocolOptions> = {}): FriendzProtocolOptions {
  return {
    getMidden: async () => createMockMidden() as unknown as MiddenStreamNode,
    localNodeId: "a".repeat(64),
    localUsername: "alice",
    getLocalProfile: () => ({ username: "alice", bio: "hi there", avatarDataUrl: "" }),
    isFriend: () => false,
    profileVisibility: "friends",
    friendRequestsFrom: "everyone",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("FriendzProtocol", () => {
  let protocol: FriendzProtocol;
  let mockMidden: MockMidden;

  beforeEach(() => {
    mockMidden = createMockMidden();
    protocol = new FriendzProtocol(
      defaultOptions({
        getMidden: async () => mockMidden as unknown as MiddenStreamNode,
      })
    );
  });

  afterEach(() => {
    protocol.destroy();
  });

  describe("wire transport", () => {
    it("opens outbound streams on the shared freqhole-friendz/1 alpn", async () => {
      await protocol.sendFriendRequest("b".repeat(64));
      expect(mockMidden.open_bi).toHaveBeenCalledWith("b".repeat(64), FRIENDZ_ALPN);
      expect(FRIENDZ_ALPN).toBe("freqhole-friendz/1");
    });

    it("reuses an existing stream instead of opening a new one", async () => {
      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      await flush();

      await protocol.sendFriendRequest(peerId);

      expect(mockMidden.open_bi).not.toHaveBeenCalled();
      expect(stream._written.length).toBeGreaterThan(0);
    });
  });

  describe("friend request / accept / reject", () => {
    it("sends a core friend-request message", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendFriendRequest(targetId);

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("friend-request");
      expect(json.fromNodeId).toBe("a".repeat(64));
    });

    it("fires onFriendRequest for an incoming friend-request", async () => {
      const requests: Array<{ fromUsername: string; from: string }> = [];
      protocol.onFriendRequest = (msg, from) => requests.push({ fromUsername: msg.fromUsername, from });

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({ type: "friend-request", v: 1, fromNodeId: peerId, fromUsername: "bob" });
      await flush();

      expect(requests).toEqual([{ fromUsername: "bob", from: peerId }]);
    });

    it("ignores incoming friend-request when friendRequestsFrom is 'nobody'", async () => {
      const closed = new FriendzProtocol(
        defaultOptions({
          getMidden: async () => mockMidden as unknown as MiddenStreamNode,
          friendRequestsFrom: "nobody",
        })
      );
      const requests: string[] = [];
      closed.onFriendRequest = (_msg, from) => requests.push(from);

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      closed.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({ type: "friend-request", v: 1, fromNodeId: peerId, fromUsername: "bob" });
      await flush();

      expect(requests).toEqual([]);
      closed.destroy();
    });

    it("fires onFriendAccept/onFriendReject/onFriendAcceptAck", async () => {
      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);

      const accepts: string[] = [];
      const rejects: string[] = [];
      const acks: string[] = [];
      protocol.onFriendAccept = (_msg, from) => accepts.push(from);
      protocol.onFriendReject = (_msg, from) => rejects.push(from);
      protocol.onFriendAcceptAck = (_msg, from) => acks.push(from);

      stream.pushWire({ type: "friend-accept", v: 1, fromNodeId: peerId, fromUsername: "bob" });
      stream.pushWire({ type: "friend-reject", v: 1, fromNodeId: peerId });
      stream.pushWire({ type: "friend-accept-ack", v: 1, fromNodeId: peerId });
      await flush();

      expect(accepts).toEqual([peerId]);
      expect(rejects).toEqual([peerId]);
      expect(acks).toEqual([peerId]);
    });
  });

  describe("profile request/response", () => {
    it("responds to profile-request from a friend when visibility is 'friends'", async () => {
      const friendId = "b".repeat(64);
      const friendly = new FriendzProtocol(
        defaultOptions({
          getMidden: async () => mockMidden as unknown as MiddenStreamNode,
          isFriend: (id) => id === friendId,
          profileVisibility: "friends",
        })
      );

      const stream = createMockBiStream(friendId);
      friendly.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({ type: "profile-request", v: 1 });
      await flush();

      const json = lastWireJson(stream);
      expect(json.type).toBe("profile-response");
      expect(json.username).toBe("alice");
      friendly.destroy();
    });

    it("ignores profile-request from a non-friend when visibility is 'friends'", async () => {
      const strangerId = "c".repeat(64);
      const stream = createMockBiStream(strangerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({ type: "profile-request", v: 1 });
      await flush();

      expect(stream._written).toHaveLength(0);
    });

    it("fires onProfileResponse for an incoming profile-response", async () => {
      const received: Array<{ username: string; from: string }> = [];
      protocol.onProfileResponse = (msg, from) => received.push({ username: msg.username, from });

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({ type: "profile-response", v: 1, username: "bob", bio: "hi", avatarDataUrl: "" });
      await flush();

      expect(received).toEqual([{ username: "bob", from: peerId }]);
    });
  });

  describe("heartbeat / presence", () => {
    it("marks a peer online after receiving a heartbeat", async () => {
      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);

      expect(protocol.isOnline(peerId)).toBe(false);
      stream.pushWire({ type: "heartbeat", v: 1, nodeId: peerId, username: "bob" });
      await flush();

      expect(protocol.isOnline(peerId)).toBe(true);
      expect(protocol.getOnlinePeers()).toContain(peerId);
    });

    it("sends a fast presence-ack heartbeat back on a peer's first heartbeat", async () => {
      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);

      stream.pushWire({ type: "heartbeat", v: 1, nodeId: peerId, username: "bob" });
      await flush();

      const replies = stream._written
        .map((b) => JSON.parse(new TextDecoder().decode(b)))
        .filter((m: { type: string }) => m.type === "heartbeat");
      expect(replies.length).toBeGreaterThanOrEqual(1);
      expect(replies[0].nodeId).toBe("a".repeat(64));
    });

    it("fires onPeerBecameOnline exactly once per online transition", async () => {
      const calls: string[] = [];
      protocol.onPeerBecameOnline = (id) => calls.push(id);

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);

      stream.pushWire({ type: "heartbeat", v: 1, nodeId: peerId, username: "bob" });
      stream.pushWire({ type: "heartbeat", v: 1, nodeId: peerId, username: "bob" });
      await flush();

      expect(calls).toEqual([peerId]);
    });

    it("carries canvasActivity in the heartbeat's appPayload field on send", async () => {
      const withActivity = new FriendzProtocol(
        defaultOptions({
          getMidden: async () => mockMidden as unknown as MiddenStreamNode,
          getCanvasActivity: () => [
            { canvasDocId: "doc-1", lastModifiedAt: "2025-01-15T00:00:00Z", widgetCount: 3 },
          ],
        })
      );
      const peerId = "b".repeat(64);
      await withActivity.probePeer(peerId);

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("heartbeat");
      expect(json.appPayload).toEqual([
        { canvasDocId: "doc-1", lastModifiedAt: "2025-01-15T00:00:00Z", widgetCount: 3 },
      ]);
      withActivity.destroy();
    });

    it("fires onCanvasActivity when an incoming heartbeat's appPayload is a non-empty array", async () => {
      const received: Array<{ canvasDocId: string }[]> = [];
      protocol.onCanvasActivity = (entries) => received.push(entries);

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "heartbeat",
        v: 1,
        nodeId: peerId,
        username: "bob",
        appPayload: [{ canvasDocId: "doc-1", lastModifiedAt: "2025-01-15T00:00:00Z", widgetCount: 3 }],
      });
      await flush();

      expect(received).toHaveLength(1);
      expect(received[0][0].canvasDocId).toBe("doc-1");
    });

    it("marks a peer offline on offline-announcement", async () => {
      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({ type: "heartbeat", v: 1, nodeId: peerId, username: "bob" });
      await flush();
      expect(protocol.isOnline(peerId)).toBe(true);

      stream.pushWire({ type: "offline-announcement", v: 1, nodeId: peerId });
      await flush();
      expect(protocol.isOnline(peerId)).toBe(false);
    });

    it("announceOffline sends offline-announcement to online peers", async () => {
      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({ type: "heartbeat", v: 1, nodeId: peerId, username: "bob" });
      await flush();

      protocol.announceOffline();
      await flush();

      const sent = stream._written.map((b) => JSON.parse(new TextDecoder().decode(b)));
      expect(sent.some((m: { type: string }) => m.type === "offline-announcement")).toBe(true);
    });

    it("startHeartbeat sends an initial round to all friends and fires onAfterHeartbeatTick", async () => {
      const friend1 = "b".repeat(64);
      const friend2 = "c".repeat(64);
      const ticks: string[][] = [];
      protocol.onAfterHeartbeatTick = (ids) => ticks.push([...ids]);

      protocol.startHeartbeat(() => [friend1, friend2]);
      await flush(30);

      expect(mockMidden.open_bi).toHaveBeenCalledWith(friend1, FRIENDZ_ALPN);
      expect(mockMidden.open_bi).toHaveBeenCalledWith(friend2, FRIENDZ_ALPN);
      expect(ticks[0]).toEqual(expect.arrayContaining([friend1, friend2]));

      protocol.stopHeartbeat();
    });

    it("stopHeartbeat clears the interval without throwing", () => {
      protocol.startHeartbeat(() => ["b".repeat(64)]);
      expect(() => protocol.stopHeartbeat()).not.toThrow();
    });
  });

  describe("canvas invite (skein: app-extension)", () => {
    it("sends canvas-invite as a skein:canvas-invite app-extension message", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendCanvasInvite(targetId, {
        inviteId: "inv-1",
        canvasDocId: "doc-1",
        canvasTitle: "cool canvas",
        originNodeId: "a".repeat(64),
        originUsername: "alice",
        role: "member",
        targets: [targetId],
        acked: [],
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("skein:canvas-invite");
      expect(json.inviteId).toBe("inv-1");
    });

    it("fires onCanvasInvite for an incoming skein:canvas-invite message", async () => {
      const invites: Array<{ inviteId: string }> = [];
      protocol.onCanvasInvite = (msg) => invites.push({ inviteId: msg.inviteId });

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "skein:canvas-invite",
        v: 1,
        inviteId: "inv-1",
        canvasDocId: "doc-1",
        canvasTitle: "cool canvas",
        originNodeId: peerId,
        originUsername: "bob",
        role: "member",
        targets: ["a".repeat(64)],
        acked: [],
      });
      await flush();

      expect(invites).toEqual([{ inviteId: "inv-1" }]);
    });

    it("blocks canvas invites when canvasInvitesFrom is 'nobody'", async () => {
      const closed = new FriendzProtocol(
        defaultOptions({
          getMidden: async () => mockMidden as unknown as MiddenStreamNode,
          canvasInvitesFrom: "nobody",
        })
      );
      const invites: unknown[] = [];
      closed.onCanvasInvite = (msg) => invites.push(msg);

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      closed.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "skein:canvas-invite",
        v: 1,
        inviteId: "inv-1",
        canvasDocId: "doc-1",
        canvasTitle: "cool canvas",
        originNodeId: peerId,
        originUsername: "bob",
        role: "member",
        targets: [],
        acked: [],
      });
      await flush();

      expect(invites).toEqual([]);
      closed.destroy();
    });

    it("sends canvas-update/canvas-deleted as skein: app-extension messages", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendCanvasUpdate(targetId, {
        canvasDocId: "doc-1",
        lastModifiedAt: "2025-01-01T00:00:00Z",
        widgetCount: 2,
        modifiedByNodeId: "a".repeat(64),
        modifiedByUsername: "alice",
      });
      let stream = await mockMidden.open_bi.mock.results[0].value;
      expect(lastWireJson(stream).type).toBe("skein:canvas-update");

      await protocol.sendCanvasDeleted(targetId, {
        canvasDocId: "doc-1",
        canvasTitle: "cool canvas",
        deletedBy: "a".repeat(64),
        deletedByUsername: "alice",
        deleteMode: "soft",
        deletedAt: "2025-01-01T00:00:00Z",
      });
      stream = await mockMidden.open_bi.mock.results[0].value;
      expect(lastWireJson(stream).type).toBe("skein:canvas-deleted");
    });
  });

  describe("canvas knock (knock-request / knock-ack / knock-outcome)", () => {
    it("sends canvas-knock as a resource-scoped knock-request", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendCanvasKnock(targetId, {
        knockId: "knock-1",
        canvasDocId: "doc-1",
        requesterNodeId: "a".repeat(64),
        requesterUsername: "alice",
        message: "let me in",
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("knock-request");
      expect(json.knockId).toBe("knock-1");
      expect(json.nodeId).toBe("a".repeat(64));
      expect(json.scope).toEqual({ kind: "resource", resourceId: "doc-1" });
    });

    it("fires onCanvasKnock for an incoming resource-scoped knock-request", async () => {
      const knocks: Array<{ canvasDocId: string; requesterNodeId: string }> = [];
      protocol.onCanvasKnock = (msg) =>
        knocks.push({ canvasDocId: msg.canvasDocId, requesterNodeId: msg.requesterNodeId });

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "knock-request",
        v: 1,
        knockId: "knock-1",
        nodeId: peerId,
        username: "bob",
        message: "let me in",
        scope: { kind: "resource", resourceId: "doc-1" },
      });
      await flush();

      expect(knocks).toEqual([{ canvasDocId: "doc-1", requesterNodeId: peerId }]);
    });

    it("ignores an incoming knock-request with a non-resource scope", async () => {
      const knocks: unknown[] = [];
      protocol.onCanvasKnock = (msg) => knocks.push(msg);

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "knock-request",
        v: 1,
        knockId: "knock-1",
        nodeId: peerId,
        message: "let me browse",
        scope: { kind: "browse" },
      });
      await flush();

      expect(knocks).toEqual([]);
    });

    it("sends canvas-knock-ack as knock-ack with resourceId", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendCanvasKnockAck(targetId, {
        knockId: "knock-1",
        canvasDocId: "doc-1",
        ackerNodeId: "a".repeat(64),
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("knock-ack");
      expect(json.resourceId).toBe("doc-1");
    });

    it("sends canvas-knock-approve as an accepted knock-outcome with grantedResourceIds", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendCanvasKnockApprove(targetId, {
        knockId: "knock-1",
        canvasDocId: "doc-1",
        approverNodeId: "a".repeat(64),
        role: "member",
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("knock-outcome");
      expect(json.status).toBe("accepted");
      expect(json.grantedRole).toBe("member");
      expect(json.grantedResourceIds).toEqual(["doc-1"]);
    });

    it("sends canvas-knock-decline as a denied knock-outcome with no resource id", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendCanvasKnockDecline(targetId, {
        knockId: "knock-1",
        canvasDocId: "doc-1",
        declinerNodeId: "a".repeat(64),
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("knock-outcome");
      expect(json.status).toBe("denied");
      expect(json.grantedResourceIds).toEqual([]);
    });

    it("synthesizes onCanvasKnockApprove from an accepted knock-outcome", async () => {
      const approvals: Array<{ canvasDocId: string; role: string }> = [];
      protocol.onCanvasKnockApprove = (msg) => approvals.push({ canvasDocId: msg.canvasDocId, role: msg.role });

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "knock-outcome",
        v: 1,
        knockId: "knock-1",
        status: "accepted",
        grantedRole: "member",
        grantedResourceIds: ["doc-1"],
        byNodeId: peerId,
      });
      await flush();

      expect(approvals).toEqual([{ canvasDocId: "doc-1", role: "member" }]);
    });

    it("synthesizes onCanvasKnockDecline from a denied knock-outcome with an empty canvasDocId", async () => {
      const declines: Array<{ canvasDocId: string }> = [];
      protocol.onCanvasKnockDecline = (msg) => declines.push({ canvasDocId: msg.canvasDocId });

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "knock-outcome",
        v: 1,
        knockId: "knock-1",
        status: "denied",
        grantedResourceIds: [],
        byNodeId: peerId,
      });
      await flush();

      expect(declines).toEqual([{ canvasDocId: "" }]);
    });
  });

  describe("acl-change", () => {
    it("sends acl-change with canvasDocId/canvasTitle renamed to resourceId/resourceTitle", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendAclChange(targetId, {
        canvasDocId: "doc-1",
        canvasTitle: "cool canvas",
        targetNodeId: targetId,
        newRole: "viewer",
        changedBy: "a".repeat(64),
        changedByUsername: "alice",
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("acl-change");
      expect(json.resourceId).toBe("doc-1");
      expect(json.resourceTitle).toBe("cool canvas");
      expect(json.newRole).toBe("viewer");
    });

    it("sends newRole: 'removed' as an absent newRole field", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendAclChange(targetId, {
        canvasDocId: "doc-1",
        canvasTitle: "cool canvas",
        targetNodeId: targetId,
        newRole: "removed",
        changedBy: "a".repeat(64),
        changedByUsername: "alice",
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("acl-change");
      expect("newRole" in json).toBe(false);
    });

    it("receives an absent newRole as 'removed'", async () => {
      const changes: Array<{ newRole: string }> = [];
      protocol.onAclChange = (msg) => changes.push({ newRole: msg.newRole });

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "acl-change",
        v: 1,
        resourceId: "doc-1",
        resourceTitle: "cool canvas",
        targetNodeId: "a".repeat(64),
        changedBy: peerId,
        changedByUsername: "bob",
      });
      await flush();

      expect(changes).toEqual([{ newRole: "removed" }]);
    });

    it("receives a real role as itself", async () => {
      const changes: Array<{ newRole: string; canvasDocId: string }> = [];
      protocol.onAclChange = (msg) => changes.push({ newRole: msg.newRole, canvasDocId: msg.canvasDocId });

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "acl-change",
        v: 1,
        resourceId: "doc-1",
        targetNodeId: "a".repeat(64),
        newRole: "viewer",
        changedBy: peerId,
        changedByUsername: "bob",
      });
      await flush();

      expect(changes).toEqual([{ newRole: "viewer", canvasDocId: "doc-1" }]);
    });
  });

  describe("gossip-digest", () => {
    it("carries canvasUpdates/pendingInvites/sharedCanvasIds in appPayload", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendGossipDigest(targetId, {
        canvasUpdates: [
          { canvasDocId: "doc-1", lastModifiedAt: "2025-01-01T00:00:00Z", lastModifiedBy: "a".repeat(64) },
        ],
        pendingInvites: [],
        pendingKnocks: [],
        sharedCanvasIds: ["doc-1"],
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("gossip-digest");
      expect(json.appPayload).toMatchObject({
        canvasUpdates: [{ canvasDocId: "doc-1" }],
        sharedCanvasIds: ["doc-1"],
      });
    });

    it("omits appPayload when there's nothing skein-specific to say", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendGossipDigest(targetId, {
        canvasUpdates: [],
        pendingInvites: [],
        pendingKnocks: [],
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.appPayload).toBeUndefined();
    });

    it("translates pendingKnocks to the shared protocol's knockId/scope shape", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendGossipDigest(targetId, {
        canvasUpdates: [],
        pendingInvites: [],
        pendingKnocks: [
          {
            knockId: "knock-1",
            canvasDocId: "doc-1",
            requesterNodeId: "c".repeat(64),
            requesterUsername: "carol",
            message: "let me in",
            knockedAt: "2025-01-01T00:00:00Z",
          },
        ],
      });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.pendingKnocks).toEqual([
        {
          knockId: "knock-1",
          nodeId: "c".repeat(64),
          username: "carol",
          message: "let me in",
          scope: { kind: "resource", resourceId: "doc-1" },
          knockedAt: "2025-01-01T00:00:00Z",
        },
      ]);
    });

    it("fires onGossipDigest with pendingKnocks translated back to canvasDocId", async () => {
      const received: GossipDigestMessage["pendingKnocks"][] = [];
      protocol.onGossipDigest = (msg) => received.push(msg.pendingKnocks);

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "gossip-digest",
        v: 1,
        pendingKnocks: [
          {
            knockId: "knock-1",
            nodeId: "c".repeat(64),
            username: "carol",
            message: "let me in",
            scope: { kind: "resource", resourceId: "doc-1" },
            knockedAt: "2025-01-01T00:00:00Z",
          },
        ],
        profiles: [],
      });
      await flush();

      expect(received[0]).toEqual([
        {
          knockId: "knock-1",
          canvasDocId: "doc-1",
          requesterNodeId: "c".repeat(64),
          requesterUsername: "carol",
          message: "let me in",
          knockedAt: "2025-01-01T00:00:00Z",
        },
      ]);
    });

    it("passes profiles through unchanged", async () => {
      const received: (GossipDigestMessage["profiles"] | undefined)[] = [];
      protocol.onGossipDigest = (msg) => received.push(msg.profiles);

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({
        type: "gossip-digest",
        v: 1,
        pendingKnocks: [],
        profiles: [{ peerNodeId: peerId, profileDocId: "doc-x", updatedAt: "2025-01-01T00:00:00Z" }],
      });
      await flush();

      expect(received[0]).toEqual([
        { peerNodeId: peerId, profileDocId: "doc-x", updatedAt: "2025-01-01T00:00:00Z" },
      ]);
    });
  });

  describe("blob-seek / blob-offer", () => {
    it("fires onBlobSeek with the needed hash list", async () => {
      const received: string[][] = [];
      protocol.onBlobSeek = (msg) => received.push(msg.needed);

      const peerId = "b".repeat(64);
      const stream = createMockBiStream(peerId);
      protocol.handleStream(stream as unknown as BiStreamLike);
      stream.pushWire({ type: "blob-seek", v: 1, needed: ["hash-1", "hash-2"] });
      await flush();

      expect(received).toEqual([["hash-1", "hash-2"]]);
    });

    it("sends blob-offer with the available hash list", async () => {
      const targetId = "b".repeat(64);
      await protocol.sendBlobOffer(targetId, { available: ["hash-1"] });

      const stream = await mockMidden.open_bi.mock.results[0].value;
      const json = lastWireJson(stream);
      expect(json.type).toBe("blob-offer");
      expect(json.available).toEqual(["hash-1"]);
    });
  });

  describe("setters", () => {
    it("getLocalUsername/setLocalUsername/setLocalNodeId round-trip", () => {
      expect(protocol.getLocalUsername()).toBe("alice");
      protocol.setLocalUsername("alicia");
      expect(protocol.getLocalUsername()).toBe("alicia");
      expect(() => protocol.setLocalNodeId("f".repeat(64))).not.toThrow();
    });

    it("setProfileVisibility/setFriendRequestsFrom/setCanvasInvitesFrom don't throw", () => {
      expect(() => protocol.setProfileVisibility("nobody")).not.toThrow();
      expect(() => protocol.setFriendRequestsFrom("nobody")).not.toThrow();
      expect(() => protocol.setCanvasInvitesFrom("nobody")).not.toThrow();
    });
  });

  describe("destroy()", () => {
    it("clears every event handler", () => {
      protocol.onFriendRequest = () => {};
      protocol.onFriendAccept = () => {};
      protocol.onCanvasKnock = () => {};
      protocol.onGossipDigest = () => {};
      protocol.onBlobSeek = () => {};
      protocol.onCanvasUpdate = () => {};
      protocol.onCanvasDeleted = () => {};

      protocol.destroy();

      expect(protocol.onFriendRequest).toBeNull();
      expect(protocol.onFriendAccept).toBeNull();
      expect(protocol.onCanvasKnock).toBeNull();
      expect(protocol.onGossipDigest).toBeNull();
      expect(protocol.onBlobSeek).toBeNull();
      expect(protocol.onCanvasUpdate).toBeNull();
      expect(protocol.onCanvasDeleted).toBeNull();
    });

    it("stops the heartbeat timer without throwing", () => {
      protocol.startHeartbeat(() => ["b".repeat(64)]);
      expect(() => protocol.destroy()).not.toThrow();
    });
  });

  it("HEARTBEAT_TIMEOUT_MS matches the shared protocol's own default (90s)", () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBe(90_000);
  });
});



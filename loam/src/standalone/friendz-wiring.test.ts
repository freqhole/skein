// ---------------------------------------------------------------------------
// unit tests for wireFriendHandlers() — sticky hub-flag recording
// (docs/hub-and-profile-plan.md section 3.3)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { docHandleAsSocialDoc, wireFriendHandlers } from "./friendz-wiring";
import { FriendzProtocol, type FriendzProtocolOptions } from "../p2p/friends-protocol";
import type { MiddenStreamNode } from "../p2p/iroh-network-adapter";
import type { SocialDoc } from "../../widgets/narthex/social/types";

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

/** build a fresh in-memory social doc for testing, seeded with an empty
 *  social state shape (mirrors what boot.ts seeds on first run — same
 *  helper as group-store.test.ts uses). */
function createTestSocialDoc(): SocialDoc {
  const repo = createTestRepo();
  const handle = repo.create<any>({
    profile: { username: "local", bio: "", avatarDataUrl: "", accentColor: 0xd946ef, nodeId: "" },
    friends: [],
    groups: [],
    shareGroups: [],
    pendingRequests: [],
    outboundRequests: [],
    profileVisibility: "friends",
    friendRequestsFrom: "everyone",
  });
  return docHandleAsSocialDoc(handle);
}

/** a minimal fake midden — no real iroh/network involved, just enough for
 *  FriendzProtocol.sendFriendAccept()/requestProfile() to resolve without
 *  throwing (mirrors friends-protocol.test.ts's createMockMidden). */
function createMockMidden(nodeId: string) {
  return {
    node_id: () => nodeId,
    open_bi: async (_addr: string, _alpn: string) => ({
      peer_node_id: () => _addr,
      alpn: () => _alpn,
      write_message: async () => {},
      read_message: async () => null,
      close: () => {},
    }),
    accept: async () => null,
  };
}

function createTestProtocol(localNodeId = "a".repeat(64)): FriendzProtocol {
  const options: FriendzProtocolOptions = {
    getMidden: async () => createMockMidden(localNodeId) as unknown as MiddenStreamNode,
    localNodeId,
    localUsername: "local",
    getLocalProfile: () => ({ username: "local", bio: "", avatarDataUrl: "" }),
    isFriend: () => false,
    profileVisibility: "friends",
    friendRequestsFrom: "everyone",
  };
  return new FriendzProtocol(options);
}

const BOB = "b".repeat(64);

// ---------------------------------------------------------------------------
// onFriendRequest
// ---------------------------------------------------------------------------

describe("wireFriendHandlers — onFriendRequest", () => {
  it("records isHub: true on a new reciprocal-add friend entry when the message carries it", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    // seed a pending outbound request so the incoming request is reciprocal
    // (triggers the auto-add branch instead of just recording a pending inbound request)
    sDoc.change((draft: any) => {
      draft.outboundRequests.push({
        toNodeId: BOB,
        toUsername: "bob",
        sentAt: new Date().toISOString(),
        status: "pending",
      });
    });

    protocol.onFriendRequest!(
      { type: "friend-request", fromNodeId: BOB, fromUsername: "bob", isHub: true },
      BOB
    );

    const friend = sDoc.current.friends.find((f) => f.nodeIds.some((n) => n.nodeId === BOB));
    expect(friend).toBeDefined();
    expect(friend!.isHub).toBe(true);
  });

  it("defaults isHub to false on a new friend entry when the message omits the flag", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    sDoc.change((draft: any) => {
      draft.outboundRequests.push({
        toNodeId: BOB,
        toUsername: "bob",
        sentAt: new Date().toISOString(),
        status: "pending",
      });
    });

    protocol.onFriendRequest!({ type: "friend-request", fromNodeId: BOB, fromUsername: "bob" }, BOB);

    const friend = sDoc.current.friends.find((f) => f.nodeIds.some((n) => n.nodeId === BOB));
    expect(friend).toBeDefined();
    expect(friend!.isHub).toBe(false);
  });

  it("sticky: flips an existing friend's isHub to true on a duplicate request that now carries the flag", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    // seed an already-known (non-hub) friend
    sDoc.change((draft: any) => {
      draft.friends.push({
        id: "f1",
        alias: "",
        username: "bob",
        group: "",
        nodeIds: [{ nodeId: BOB, addedAt: "", lastSeenAt: "", username: "bob", bio: "", avatarDataUrl: "" }],
        createdAt: "",
        isHub: false,
      });
    });

    protocol.onFriendRequest!(
      { type: "friend-request", fromNodeId: BOB, fromUsername: "bob", isHub: true },
      BOB
    );

    const friend = sDoc.current.friends.find((f) => f.nodeIds.some((n) => n.nodeId === BOB));
    expect(friend!.isHub).toBe(true);
  });

  it("sticky: never unsets isHub when a later request from the same hub omits the flag", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    sDoc.change((draft: any) => {
      draft.friends.push({
        id: "f1",
        alias: "",
        username: "bob",
        group: "",
        nodeIds: [{ nodeId: BOB, addedAt: "", lastSeenAt: "", username: "bob", bio: "", avatarDataUrl: "" }],
        createdAt: "",
        isHub: true,
      });
    });

    protocol.onFriendRequest!({ type: "friend-request", fromNodeId: BOB, fromUsername: "bob" }, BOB);

    const friend = sDoc.current.friends.find((f) => f.nodeIds.some((n) => n.nodeId === BOB));
    expect(friend!.isHub).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// onFriendAccept
// ---------------------------------------------------------------------------

describe("wireFriendHandlers — onFriendAccept", () => {
  it("records isHub: true on a brand-new friend entry when the accept carries it", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    protocol.onFriendAccept!(
      { type: "friend-accept", fromNodeId: BOB, fromUsername: "bob", isHub: true },
      BOB
    );

    const friend = sDoc.current.friends.find((f) => f.nodeIds.some((n) => n.nodeId === BOB));
    expect(friend).toBeDefined();
    expect(friend!.isHub).toBe(true);
  });

  it("defaults isHub to false on a brand-new friend entry when the accept omits the flag", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    protocol.onFriendAccept!({ type: "friend-accept", fromNodeId: BOB, fromUsername: "bob" }, BOB);

    const friend = sDoc.current.friends.find((f) => f.nodeIds.some((n) => n.nodeId === BOB));
    expect(friend).toBeDefined();
    expect(friend!.isHub).toBe(false);
  });

  it("sticky: flips an existing (pre-created) friend entry's isHub to true on accept", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    // pre-created by the add-friend UI, before we knew bob was a hub
    sDoc.change((draft: any) => {
      draft.friends.push({
        id: "f1",
        alias: "",
        username: "",
        group: "",
        nodeIds: [{ nodeId: BOB, addedAt: "", lastSeenAt: "", username: "", bio: "", avatarDataUrl: "" }],
        createdAt: "",
        isHub: false,
      });
    });

    protocol.onFriendAccept!(
      { type: "friend-accept", fromNodeId: BOB, fromUsername: "bob", isHub: true },
      BOB
    );

    const friend = sDoc.current.friends.find((f) => f.nodeIds.some((n) => n.nodeId === BOB));
    expect(friend!.isHub).toBe(true);
    // backfill of other fields still happens as before (not a regression)
    expect(friend!.username).toBe("bob");
  });

  it("sticky: never unsets an existing friend's isHub when a later accept omits the flag", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    sDoc.change((draft: any) => {
      draft.friends.push({
        id: "f1",
        alias: "",
        username: "bob",
        group: "",
        nodeIds: [{ nodeId: BOB, addedAt: "", lastSeenAt: "", username: "bob", bio: "", avatarDataUrl: "" }],
        createdAt: "",
        isHub: true,
      });
    });

    protocol.onFriendAccept!({ type: "friend-accept", fromNodeId: BOB, fromUsername: "bob" }, BOB);

    const friend = sDoc.current.friends.find((f) => f.nodeIds.some((n) => n.nodeId === BOB));
    expect(friend!.isHub).toBe(true);
  });
});

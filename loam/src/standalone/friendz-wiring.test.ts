// ---------------------------------------------------------------------------
// unit tests for wireFriendHandlers() — sticky hub-flag recording
// (docs/hub-and-profile-plan.md section 3.3)
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { docHandleAsSocialDoc, wireAclChangeHandlers, wireFriendHandlers } from "./friendz-wiring";
import { FriendzProtocol, type FriendzProtocolOptions } from "../p2p/friends-protocol";
import type { MiddenStreamNode } from "../p2p/iroh-network-adapter";
import type { SocialDoc } from "../../widgets/narthex/social/types";
import { CanvasStore } from "../canvas/canvas-store";
import { TRASH_WIDGET_TYPE } from "../../widgets/narthex/trash-widget";

// ---------------------------------------------------------------------------
// mock: ../p2p/identity — wireAclChangeHandlers' viewer-auto-trash path
// (see the new test below) calls getStoredIdentity() to stamp the local
// node id before trashing a card; stubbed so the test doesn't depend on a
// real IndexedDB-backed identity existing in this environment (mirrors
// iroh-network-adapter.test.ts's identity mock).
// ---------------------------------------------------------------------------

vi.mock("../p2p/identity", () => ({
  getStoredIdentity: vi.fn(async () => ({ node_id: "local-node-id" })),
}));

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

  it("refreshes identity fields in place on a resend from an already-pending fromNodeId, without duplicating the entry", () => {
    const sDoc = createTestSocialDoc();
    const protocol = createTestProtocol();
    wireFriendHandlers({ protocol, sDoc });

    protocol.onFriendRequest!(
      {
        type: "friend-request",
        fromNodeId: BOB,
        fromUsername: "bob",
        bio: "old bio",
        avatarDataUrl: "data:old",
      },
      BOB
    );

    // bob edits his profile and resends the still-pending request
    protocol.onFriendRequest!(
      {
        type: "friend-request",
        fromNodeId: BOB,
        fromUsername: "bobby",
        bio: "new bio",
        avatarDataUrl: "data:new",
        accentColor: 0x123456,
      },
      BOB
    );

    const matching = sDoc.current.pendingRequests.filter((r) => r.fromNodeId === BOB);
    expect(matching).toHaveLength(1);
    expect(matching[0].fromUsername).toBe("bobby");
    expect(matching[0].fromBio).toBe("new bio");
    expect(matching[0].fromAvatarDataUrl).toBe("data:new");
    expect((matching[0] as any).fromAccentColor).toBe(0x123456);
    expect(matching[0].status).toBe("pending");
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

// ---------------------------------------------------------------------------
// wireAclChangeHandlers — onAclChange
//
// covers the real, previously-unwired bug: sendAclChange/onAclChange
// existed fully built and tested in friends-protocol.ts, but nothing ever
// called wireAclChangeHandlers() in production, so a demoted/revoked
// peer's own narthex canvas-card never reflected the change.
// ---------------------------------------------------------------------------

describe("wireAclChangeHandlers — onAclChange", () => {
  const TARGET_CANVAS_DOC_ID = "canvas-doc-1";

  /** seed a narthex doc with a single canvas-card widget (on its own doc,
   *  same two-doc shape production uses) referencing TARGET_CANVAS_DOC_ID,
   *  with the given initial role/accessRevoked. returns both handles. */
  function seedNarthexWithCard(role: string, accessRevoked: boolean) {
    const repo = createTestRepo();
    const cardHandle = repo.create<any>({
      canvasDocId: TARGET_CANVAS_DOC_ID,
      isRemote: true,
      role,
      accessRevoked,
    });
    const narthexHandle = repo.create<any>({
      widgets: {
        "widget-1": {
          type: "canvas-card",
          docId: cardHandle.documentId,
          props: { canvasDocId: TARGET_CANVAS_DOC_ID },
        },
      },
    });
    return { repo, narthexHandle, cardHandle };
  }

  it("updates the matching narthex card's role when newRole is a real role", () => {
    const { repo, narthexHandle, cardHandle } = seedNarthexWithCard("member", false);
    const protocol = createTestProtocol();
    wireAclChangeHandlers({ protocol, repo, narthexDocId: narthexHandle.documentId });

    protocol.onAclChange!(
      {
        type: "acl-change",
        canvasDocId: TARGET_CANVAS_DOC_ID,
        canvasTitle: "shared canvas",
        targetNodeId: "me",
        newRole: "viewer",
        changedBy: BOB,
        changedByUsername: "bob",
      },
      BOB
    );

    expect(cardHandle.doc().role).toBe("viewer");
    expect(cardHandle.doc().accessRevoked).toBe(false);
  });

  it("sets accessRevoked on the matching narthex card when newRole is 'removed'", () => {
    const { repo, narthexHandle, cardHandle } = seedNarthexWithCard("member", false);
    const protocol = createTestProtocol();
    wireAclChangeHandlers({ protocol, repo, narthexDocId: narthexHandle.documentId });

    protocol.onAclChange!(
      {
        type: "acl-change",
        canvasDocId: TARGET_CANVAS_DOC_ID,
        canvasTitle: "shared canvas",
        targetNodeId: "me",
        newRole: "removed",
        changedBy: BOB,
        changedByUsername: "bob",
      },
      BOB
    );

    expect(cardHandle.doc().accessRevoked).toBe(true);
    // the last real role is left in place — accessRevoked, not the role
    // itself, is what canvas-card.ts's drawRevokedOverlay() gates on.
    expect(cardHandle.doc().role).toBe("member");
  });

  it("re-admitting after a revocation (a real role arriving again) clears accessRevoked", () => {
    const { repo, narthexHandle, cardHandle } = seedNarthexWithCard("viewer", true);
    const protocol = createTestProtocol();
    wireAclChangeHandlers({ protocol, repo, narthexDocId: narthexHandle.documentId });

    protocol.onAclChange!(
      {
        type: "acl-change",
        canvasDocId: TARGET_CANVAS_DOC_ID,
        canvasTitle: "shared canvas",
        targetNodeId: "me",
        newRole: "member",
        changedBy: BOB,
        changedByUsername: "bob",
      },
      BOB
    );

    expect(cardHandle.doc().role).toBe("member");
    expect(cardHandle.doc().accessRevoked).toBe(false);
  });

  it("ignores an ACL change for a canvas this peer has no matching narthex card for", () => {
    const { repo, narthexHandle, cardHandle } = seedNarthexWithCard("member", false);
    const protocol = createTestProtocol();
    wireAclChangeHandlers({ protocol, repo, narthexDocId: narthexHandle.documentId });

    protocol.onAclChange!(
      {
        type: "acl-change",
        canvasDocId: "some-other-canvas",
        canvasTitle: "unrelated canvas",
        targetNodeId: "me",
        newRole: "viewer",
        changedBy: BOB,
        changedByUsername: "bob",
      },
      BOB
    );

    // untouched — no card matches "some-other-canvas"
    expect(cardHandle.doc().role).toBe("member");
    expect(cardHandle.doc().accessRevoked).toBe(false);
  });

  // -------------------------------------------------------------------------
  // viewer-role auto-trash on removal
  // -------------------------------------------------------------------------

  /** seed a real narthex CanvasStore (with a trash widget + a canvas-card
   *  widget pointing at a real target CanvasStore) — a fuller setup than
   *  `seedNarthexWithCard()` above (which uses bare automerge docs), needed
   *  here because the auto-trash path exercises the real `CanvasStore`/
   *  `trashCanvasCard()` machinery end to end, not just the card doc's own
   *  `role`/`accessRevoked` fields. */
  async function seedRealNarthexWithTrashAndCard(role: string) {
    const repo = createTestRepo();

    const targetCanvas = CanvasStore.create(repo);

    const cardHandle = repo.create<any>({
      canvasDocId: targetCanvas.handle.documentId,
      isRemote: true,
      role,
      accessRevoked: false,
    });

    const narthexStore = CanvasStore.create(repo);
    const trashDocHandle = repo.create<any>({ items: [], cols: 3, rows: 1, slotScale: "m" });
    narthexStore.addWidget({
      id: "trash-1",
      type: TRASH_WIDGET_TYPE,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 0,
      props: {},
      collapsed: false,
      docId: trashDocHandle.documentId,
      parentId: null,
    });
    narthexStore.addWidget({
      id: "widget-1",
      type: "canvas-card",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 0,
      props: { canvasDocId: targetCanvas.handle.documentId },
      collapsed: false,
      docId: cardHandle.documentId,
      parentId: null,
    });

    return { repo, narthexStore, cardHandle, targetCanvas, trashDocHandle };
  }

  /** poll until `predicate()` is true or `timeoutMs` elapses — the
   *  auto-trash path is a best-effort async IIFE fired from inside the
   *  synchronous `onAclChange` handler, so the test can't just await a
   *  returned promise. */
  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("waitFor: predicate never became true");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("auto-trashes the narthex card when a removed peer's last known role was 'viewer'", async () => {
    const { repo, narthexStore, cardHandle, targetCanvas, trashDocHandle } =
      await seedRealNarthexWithTrashAndCard("viewer");
    const protocol = createTestProtocol();
    wireAclChangeHandlers({ protocol, repo, narthexDocId: narthexStore.handle.documentId });

    protocol.onAclChange!(
      {
        type: "acl-change",
        canvasDocId: targetCanvas.handle.documentId,
        canvasTitle: "shared canvas",
        targetNodeId: "me",
        newRole: "removed",
        changedBy: BOB,
        changedByUsername: "bob",
      },
      BOB
    );

    // synchronous part: accessRevoked flips immediately.
    expect(cardHandle.doc().accessRevoked).toBe(true);

    // async part: the card gets reparented under the trash widget, the
    // trash widget's items list gains an entry for it, and the target
    // canvas itself gets soft-deleted (tombstoned).
    await waitFor(() => narthexStore.getWidget("widget-1")?.parentId === "trash-1");
    expect(trashDocHandle.doc().items.some((i: any) => i.widgetId === "widget-1")).toBe(true);
    await waitFor(() => targetCanvas.handle.doc()?.deleted === true);
    expect(targetCanvas.handle.doc()?.deleteMode).toBe("soft");
  });

  it("does NOT auto-trash the narthex card when a removed peer's last known role was 'member'", async () => {
    const { repo, narthexStore, cardHandle, targetCanvas, trashDocHandle } =
      await seedRealNarthexWithTrashAndCard("member");
    const protocol = createTestProtocol();
    wireAclChangeHandlers({ protocol, repo, narthexDocId: narthexStore.handle.documentId });

    protocol.onAclChange!(
      {
        type: "acl-change",
        canvasDocId: targetCanvas.handle.documentId,
        canvasTitle: "shared canvas",
        targetNodeId: "me",
        newRole: "removed",
        changedBy: BOB,
        changedByUsername: "bob",
      },
      BOB
    );

    expect(cardHandle.doc().accessRevoked).toBe(true);

    // give any (incorrectly-fired) async auto-trash a chance to run before
    // asserting its absence — a plain synchronous assertion right here
    // wouldn't prove a bug is absent, only that it hasn't happened *yet*.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(narthexStore.getWidget("widget-1")?.parentId ?? null).toBeNull();
    expect(trashDocHandle.doc().items).toEqual([]);
    expect(targetCanvas.handle.doc()?.deleted).not.toBe(true);
  });
});

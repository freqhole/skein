// unit tests for share-dialog.ts's pure friend-grouping logic.
//
// share-dialog.ts had zero test coverage anywhere in the repo before this
// file (confirmed via search) — everything else in it is pixi rendering,
// which has no test infrastructure/precedent here either. splitFriendsForInvite()
// is the one piece of pure, testable logic: it decides which friends land in
// the regular "invite friends" section vs. the "hub nodes" section (see
// docs/hub-and-profile-plan.md section 4 for the underlying isHub concept).
// covering it directly here avoids needing any pixi/e2e machinery to prove
// the grouping rule itself; tests/share-dialog.test.ts additionally proves
// the real boot.ts pipeline feeds this function real, correctly-flagged data.

import { describe, expect, it } from "vitest";
import { splitFriendsForInvite, type FriendInfo } from "./share-dialog";

function friend(overrides: Partial<FriendInfo> & { friendId: string }): FriendInfo {
  return {
    username: overrides.friendId,
    nodeId: `node-${overrides.friendId}`,
    isOnline: false,
    ...overrides,
  };
}

describe("splitFriendsForInvite", () => {
  it("returns two empty lists for an empty input", () => {
    const { regular, hub } = splitFriendsForInvite([]);
    expect(regular).toEqual([]);
    expect(hub).toEqual([]);
  });

  it("puts a friend with isHub undefined in the regular list, not the hub list", () => {
    const f = friend({ friendId: "a" });
    const { regular, hub } = splitFriendsForInvite([f]);
    expect(regular).toEqual([f]);
    expect(hub).toEqual([]);
  });

  it("puts a friend with isHub false in the regular list", () => {
    const f = friend({ friendId: "a", isHub: false });
    const { regular, hub } = splitFriendsForInvite([f]);
    expect(regular).toEqual([f]);
    expect(hub).toEqual([]);
  });

  it("puts a friend with isHub true in the hub list, not the regular list", () => {
    const f = friend({ friendId: "a", isHub: true });
    const { regular, hub } = splitFriendsForInvite([f]);
    expect(regular).toEqual([]);
    expect(hub).toEqual([f]);
  });

  it("splits a mixed list correctly, with no friend appearing in both or neither", () => {
    const hubFriend = friend({ friendId: "hub-node", isHub: true });
    const regularFriend = friend({ friendId: "regular-node", isHub: false });
    const untaggedFriend = friend({ friendId: "untagged-node" });

    const { regular, hub } = splitFriendsForInvite([hubFriend, regularFriend, untaggedFriend]);

    expect(hub).toEqual([hubFriend]);
    expect(regular).toEqual([regularFriend, untaggedFriend]);

    // no friend appears in both sections, and none are dropped
    const allIds = [...regular, ...hub].map((f) => f.friendId).sort();
    expect(allIds).toEqual(["hub-node", "regular-node", "untagged-node"].sort());
  });

  it("preserves the original relative order within each section", () => {
    const a = friend({ friendId: "a" });
    const b = friend({ friendId: "b", isHub: true });
    const c = friend({ friendId: "c" });
    const d = friend({ friendId: "d", isHub: true });

    const { regular, hub } = splitFriendsForInvite([a, b, c, d]);

    expect(regular.map((f) => f.friendId)).toEqual(["a", "c"]);
    expect(hub.map((f) => f.friendId)).toEqual(["b", "d"]);
  });
});

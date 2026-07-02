import { beforeEach, describe, expect, it } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { docHandleAsSocialDoc } from "../standalone/friendz-wiring";
import type { SocialDoc } from "../../widgets/narthex/social/types";
import { CanvasStore } from "./canvas-store";
import { GroupStore } from "./group-store";

/** build a fresh in-memory social doc for testing, seeded with an empty
 *  social state shape (mirrors what boot.ts seeds on first run). */
function createTestSocialDoc(): SocialDoc {
  const repo = createTestRepo();
  const handle = repo.create<any>({
    profile: { username: "", bio: "", avatarDataUrl: "", accentColor: 0xd946ef, nodeId: "" },
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

describe("GroupStore", () => {
  let socialDoc: SocialDoc;
  let groups: GroupStore;

  beforeEach(() => {
    socialDoc = createTestSocialDoc();
    groups = new GroupStore(socialDoc);
  });

  describe("createGroup", () => {
    it("creates a group with a stable id, the given name, and no members", () => {
      const id = groups.createGroup("book club");
      const group = groups.getGroup(id);
      expect(group).not.toBeNull();
      expect(group!.id).toBe(id);
      expect(group!.name).toBe("book club");
      expect(group!.memberNodeIds).toEqual([]);
    });

    it("assigns distinct ids to distinct groups", () => {
      const a = groups.createGroup("family");
      const b = groups.createGroup("coworkers");
      expect(a).not.toBe(b);
      expect(groups.allGroups()).toHaveLength(2);
    });
  });

  describe("renameGroup", () => {
    it("updates the display name", () => {
      const id = groups.createGroup("old name");
      groups.renameGroup(id, "new name");
      expect(groups.getGroup(id)!.name).toBe("new name");
    });

    it("is a no-op for a nonexistent group", () => {
      groups.renameGroup("nonexistent", "whatever");
      expect(groups.allGroups()).toEqual([]);
    });
  });

  describe("addMember / removeMember", () => {
    it("adds a member's node id to the group", () => {
      const id = groups.createGroup("family");
      groups.addMember(id, "a".repeat(64));
      expect(groups.getGroup(id)!.memberNodeIds).toEqual(["a".repeat(64)]);
      expect(groups.isMember(id, "a".repeat(64))).toBe(true);
    });

    it("is idempotent — adding the same member twice does not duplicate", () => {
      const id = groups.createGroup("family");
      groups.addMember(id, "a".repeat(64));
      groups.addMember(id, "a".repeat(64));
      expect(groups.getGroup(id)!.memberNodeIds).toEqual(["a".repeat(64)]);
    });

    it("removes a member's node id from the group", () => {
      const id = groups.createGroup("family");
      groups.addMember(id, "a".repeat(64));
      groups.addMember(id, "b".repeat(64));
      groups.removeMember(id, "a".repeat(64));
      expect(groups.getGroup(id)!.memberNodeIds).toEqual(["b".repeat(64)]);
      expect(groups.isMember(id, "a".repeat(64))).toBe(false);
    });

    it("is a no-op removing a non-member", () => {
      const id = groups.createGroup("family");
      groups.addMember(id, "a".repeat(64));
      groups.removeMember(id, "b".repeat(64));
      expect(groups.getGroup(id)!.memberNodeIds).toEqual(["a".repeat(64)]);
    });
  });

  describe("groupsForMember — many-to-many membership", () => {
    it("a node id can belong to multiple groups at once", () => {
      const bookClub = groups.createGroup("book club");
      const family = groups.createGroup("family");
      const nodeId = "a".repeat(64);
      groups.addMember(bookClub, nodeId);
      groups.addMember(family, nodeId);

      const memberOf = groups.groupsForMember(nodeId);
      expect(memberOf.map((g) => g.id).sort()).toEqual([bookClub, family].sort());
    });

    it("returns an empty list for a node id in no groups", () => {
      groups.createGroup("book club");
      expect(groups.groupsForMember("z".repeat(64))).toEqual([]);
    });
  });

  describe("deleteGroup", () => {
    it("removes the group", () => {
      const id = groups.createGroup("temp");
      groups.deleteGroup(id);
      expect(groups.getGroup(id)).toBeNull();
      expect(groups.allGroups()).toEqual([]);
    });

    it("is a no-op for a nonexistent group", () => {
      groups.deleteGroup("nonexistent");
      expect(groups.allGroups()).toEqual([]);
    });
  });

  describe("shareCanvasWithGroup", () => {
    it("grants the given role to every current group member's ACL entry", () => {
      const canvasRepo = createTestRepo();
      const canvas = CanvasStore.create(canvasRepo);

      const id = groups.createGroup("book club");
      const alice = "a".repeat(64);
      const bob = "b".repeat(64);
      groups.addMember(id, alice);
      groups.addMember(id, bob);

      const granted = groups.shareCanvasWithGroup(canvas, id, "viewer");

      expect(granted.sort()).toEqual([alice, bob].sort());
      expect(canvas.getRole(alice)).toBe("viewer");
      expect(canvas.getRole(bob)).toBe("viewer");
    });

    it("returns an empty list and grants nothing for a nonexistent group", () => {
      const canvasRepo = createTestRepo();
      const canvas = CanvasStore.create(canvasRepo);

      const granted = groups.shareCanvasWithGroup(canvas, "nonexistent", "member");

      expect(granted).toEqual([]);
    });

    it("returns an empty list for a group with no members", () => {
      const canvasRepo = createTestRepo();
      const canvas = CanvasStore.create(canvasRepo);
      const id = groups.createGroup("empty group");

      const granted = groups.shareCanvasWithGroup(canvas, id, "member");

      expect(granted).toEqual([]);
    });

    it("does not touch an admin's own ACL entry, even if the admin is a group member", () => {
      const canvasRepo = createTestRepo();
      const canvas = CanvasStore.create(canvasRepo);
      const adminNodeId = "admin".padEnd(64, "0");
      canvas.stampAdmin(adminNodeId);

      const id = groups.createGroup("everyone");
      groups.addMember(id, adminNodeId);

      groups.shareCanvasWithGroup(canvas, id, "viewer");

      expect(canvas.getRole(adminNodeId)).toBe("admin");
    });
  });

  describe("retroactive membership changes do not affect canvases already shared", () => {
    it("adding a member to a group after sharing does NOT grant them access to the already-shared canvas", () => {
      const canvasRepo = createTestRepo();
      const canvas = CanvasStore.create(canvasRepo);

      const id = groups.createGroup("book club");
      const alice = "a".repeat(64);
      groups.addMember(id, alice);

      groups.shareCanvasWithGroup(canvas, id, "viewer");
      expect(canvas.getRole(alice)).toBe("viewer");

      // add a new member to the group AFTER the canvas was already shared
      const lateJoiner = "b".repeat(64);
      groups.addMember(id, lateJoiner);

      // the late joiner was never individually invited, so they get the
      // default "member" fallback (see CanvasStore.getRole()), not the
      // "viewer" role the group was shared with — no retroactive grant.
      expect(canvas.getRole(lateJoiner)).toBe("member");
      expect(canvas.getRole(lateJoiner)).not.toBe("viewer");
    });

    it("removing a member from a group after sharing does NOT revoke their already-granted access", () => {
      const canvasRepo = createTestRepo();
      const canvas = CanvasStore.create(canvasRepo);

      const id = groups.createGroup("book club");
      const alice = "a".repeat(64);
      groups.addMember(id, alice);

      groups.shareCanvasWithGroup(canvas, id, "viewer");
      expect(canvas.getRole(alice)).toBe("viewer");

      groups.removeMember(id, alice);

      // access already granted via the canvas ACL is untouched by the
      // group membership change — the two are only linked at share time.
      expect(canvas.getRole(alice)).toBe("viewer");
    });

    it("deleting the group entirely after sharing does NOT revoke already-granted access", () => {
      const canvasRepo = createTestRepo();
      const canvas = CanvasStore.create(canvasRepo);

      const id = groups.createGroup("book club");
      const alice = "a".repeat(64);
      groups.addMember(id, alice);
      groups.shareCanvasWithGroup(canvas, id, "viewer");

      groups.deleteGroup(id);

      expect(canvas.getRole(alice)).toBe("viewer");
    });
  });

  describe("defensive parsing", () => {
    it("falls back to an empty list when shareGroups is malformed", () => {
      socialDoc.change((draft) => {
        (draft as any).shareGroups = [{ id: "x", name: "ok" }, { totally: "wrong" }];
      });
      expect(groups.allGroups()).toEqual([]);
    });

    it("treats a missing shareGroups field as an empty list", () => {
      socialDoc.change((draft) => {
        delete (draft as any).shareGroups;
      });
      expect(groups.allGroups()).toEqual([]);
    });
  });
});

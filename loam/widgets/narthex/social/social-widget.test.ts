import { describe, expect, it } from "vitest";
import {
  buildFriendRowItems,
  colorForName,
  friendDisplayName,
  friendDisplayNameFull,
  friendHasPendingOutboundRequest,
  HUB_GROUP_KEY,
  isValidNodeId,
  truncate,
} from "./helpers";
import {
  friendEntrySchema,
  friendGroupSchema as _friendGroupSchema,
  friendNodeIdSchema,
  outboundFriendRequestSchema,
  pendingFriendRequestSchema,
  profileSchema,
  socialSchema,
  type FriendEntry,
  type OutboundFriendRequest,
} from "./schema";
import { socialWidget } from "./social-widget";

// ---------------------------------------------------------------------------
// socialSchema
// ---------------------------------------------------------------------------

describe("socialSchema", () => {
  it("parses empty object with all defaults", () => {
    const result = socialSchema.parse({});
    expect(result).toEqual({
      profile: {
        username: "",
        bio: "",
        avatarDataUrl: "",
        accentColor: 0x6366f1,
        nodeId: "",
      },
      friends: [],
      groups: [],
      shareGroups: [],
      pendingRequests: [],
      outboundRequests: [],
      relayedFriendRequests: [],
      relayedFriendRequestOutcomes: [],
      profileVisibility: "friends",
      friendRequestsFrom: "everyone",
      soundEffectsEnabled: true,
    });
  });

  it("parses full object with all fields populated", () => {
    const full = {
      profile: {
        username: "alice",
        bio: "hello world",
        avatarDataUrl: "data:image/png;base64,abc",
        accentColor: 0xff0000,
        nodeId: "a".repeat(64),
      },
      friends: [
        {
          id: "friend-1",
          alias: "bestie",
          username: "bob",
          group: "close",
          nodeIds: [
            {
              nodeId: "b".repeat(64),
              addedAt: "2025-01-01",
              lastSeenAt: "2025-06-01",
              username: "bob",
              bio: "hi",
              avatarDataUrl: "",
              profileDocId: "",
              profileUpdatedAt: "",
            },
          ],
          createdAt: "2025-01-01",
          isHub: false,
        },
      ],
      groups: [{ name: "close", createdAt: "2025-01-01" }],
      pendingRequests: [
        {
          fromNodeId: "c".repeat(64),
          fromUsername: "charlie",
          fromBio: "charlie's bio",
          fromAvatarDataUrl: "data:image/png;base64,charlie",
          receivedAt: "2025-06-01",
          status: "pending" as const,
          relayedBy: "",
          expiresAt: "",
        },
      ],
      outboundRequests: [
        {
          toNodeId: "d".repeat(64),
          toUsername: "dave",
          toBio: "",
          toAvatarDataUrl: "",
          sentAt: "2025-06-01",
          expiresAt: "",
          status: "pending" as const,
        },
      ],
      relayedFriendRequests: [],
      relayedFriendRequestOutcomes: [],
      shareGroups: [
        {
          id: "share-group-1",
          name: "book club",
          memberNodeIds: ["a".repeat(64), "b".repeat(64)],
          createdAt: "2025-01-01",
        },
      ],
      profileVisibility: "everyone" as const,
      friendRequestsFrom: "nobody" as const,
      soundEffectsEnabled: true,
    };
    const result = socialSchema.parse(full);
    expect(result).toEqual(full);
  });

  it("preserves friends array with v2 shape", () => {
    const friend = {
      id: "uuid-123",
      alias: "my-alias",
      username: "bob",
      group: "work",
      nodeIds: [
        {
          nodeId: "a".repeat(64),
          addedAt: "2025-01-01",
          lastSeenAt: "2025-06-15",
          username: "bob",
          bio: "",
          avatarDataUrl: "",
          profileDocId: "",
          profileUpdatedAt: "",
        },
      ],
      createdAt: "2025-01-01",
    };
    const result = socialSchema.parse({ friends: [friend] });
    expect(result.friends).toHaveLength(1);
    expect(result.friends[0]).toEqual({ ...friend, isHub: false });
  });

  it("fills friend entry defaults", () => {
    const result = friendEntrySchema.parse({ id: "f1" });
    expect(result.alias).toBe("");
    expect(result.username).toBe("");
    expect(result.group).toBe("");
    expect(result.nodeIds).toEqual([]);
    expect(result.createdAt).toBe("");
    expect(result.isHub).toBe(false);
  });

  it("parses an explicit isHub: true", () => {
    const result = friendEntrySchema.parse({ id: "f1", isHub: true });
    expect(result.isHub).toBe(true);
  });

  it("fills nodeId entry defaults", () => {
    const result = friendNodeIdSchema.parse({ nodeId: "a".repeat(64) });
    expect(result.addedAt).toBe("");
    expect(result.lastSeenAt).toBe("");
    expect(result.username).toBe("");
    expect(result.bio).toBe("");
    expect(result.avatarDataUrl).toBe("");
  });

  it("parses friend with multiple nodeIds", () => {
    const friend = {
      id: "multi-node",
      nodeIds: [{ nodeId: "a".repeat(64) }, { nodeId: "b".repeat(64) }, { nodeId: "c".repeat(64) }],
    };
    const result = friendEntrySchema.parse(friend);
    expect(result.nodeIds).toHaveLength(3);
    expect(result.nodeIds[0].nodeId).toBe("a".repeat(64));
    expect(result.nodeIds[1].nodeId).toBe("b".repeat(64));
    expect(result.nodeIds[2].nodeId).toBe("c".repeat(64));
  });

  it("parses groups array with defaults", () => {
    const result = socialSchema.parse({
      groups: [{ name: "family" }, { name: "work", createdAt: "2025-03-01" }],
    });
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toEqual({ name: "family", createdAt: "" });
    expect(result.groups[1]).toEqual({ name: "work", createdAt: "2025-03-01" });
  });

  it("parses pending requests with all statuses", () => {
    const statuses = ["pending", "accepted", "accepted-pending-ack", "rejected"] as const;
    for (const status of statuses) {
      const result = pendingFriendRequestSchema.parse({
        fromNodeId: "a".repeat(64),
        status,
      });
      expect(result.status).toBe(status);
    }
  });

  it("parses outbound requests with all statuses", () => {
    const statuses = ["pending", "accepted", "accepted-pending-ack", "rejected"] as const;
    for (const status of statuses) {
      const result = outboundFriendRequestSchema.parse({
        toNodeId: "a".repeat(64),
        status,
      });
      expect(result.status).toBe(status);
    }
  });

  it("parses pending request defaults", () => {
    const result = pendingFriendRequestSchema.parse({ fromNodeId: "a".repeat(64) });
    expect(result.fromUsername).toBe("");
    expect(result.receivedAt).toBe("");
    expect(result.status).toBe("pending");
  });

  it("parses outbound request defaults", () => {
    const result = outboundFriendRequestSchema.parse({ toNodeId: "b".repeat(64) });
    expect(result.toUsername).toBe("");
    expect(result.sentAt).toBe("");
    expect(result.status).toBe("pending");
  });

  it("parses profileVisibility values", () => {
    for (const v of ["friends", "everyone", "nobody"] as const) {
      const result = socialSchema.parse({ profileVisibility: v });
      expect(result.profileVisibility).toBe(v);
    }
  });

  it("parses friendRequestsFrom values", () => {
    for (const v of ["everyone", "nobody"] as const) {
      const result = socialSchema.parse({ friendRequestsFrom: v });
      expect(result.friendRequestsFrom).toBe(v);
    }
  });

  it("rejects invalid profileVisibility", () => {
    expect(() => socialSchema.parse({ profileVisibility: "secret" })).toThrow();
  });

  it("rejects invalid friendRequestsFrom", () => {
    expect(() => socialSchema.parse({ friendRequestsFrom: "friends" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// profileSchema
// ---------------------------------------------------------------------------

describe("profileSchema", () => {
  it("parses empty object with defaults", () => {
    const result = profileSchema.parse({});
    expect(result).toEqual({
      username: "",
      bio: "",
      avatarDataUrl: "",
      accentColor: 0x6366f1,
      nodeId: "",
    });
  });

  it("parses full profile with all fields", () => {
    const full = {
      username: "alice",
      bio: "just vibin",
      avatarDataUrl: "data:image/png;base64,xyz",
      accentColor: 0x10b981,
      nodeId: "f".repeat(64),
    };
    const result = profileSchema.parse(full);
    expect(result).toEqual(full);
  });

  it("preserves username", () => {
    const result = profileSchema.parse({ username: "bob" });
    expect(result.username).toBe("bob");
  });

  it("preserves bio", () => {
    const result = profileSchema.parse({ bio: "hello there" });
    expect(result.bio).toBe("hello there");
  });

  it("preserves avatarDataUrl", () => {
    const result = profileSchema.parse({ avatarDataUrl: "data:image/jpeg;base64,abc" });
    expect(result.avatarDataUrl).toBe("data:image/jpeg;base64,abc");
  });

  it("preserves accentColor", () => {
    const result = profileSchema.parse({ accentColor: 0xef4444 });
    expect(result.accentColor).toBe(0xef4444);
  });

  it("preserves nodeId", () => {
    const nodeId = "ab".repeat(32);
    const result = profileSchema.parse({ nodeId });
    expect(result.nodeId).toBe(nodeId);
  });

  it("default accentColor is 0x6366f1", () => {
    const result = profileSchema.parse({});
    expect(result.accentColor).toBe(0x6366f1);
  });
});

// ---------------------------------------------------------------------------
// socialWidget metadata
// ---------------------------------------------------------------------------

describe("socialWidget", () => {
  it("type is 'social'", () => {
    expect(socialWidget.type).toBe("social");
  });

  it("metadata.name is 'social'", () => {
    expect(socialWidget.metadata.name).toBe("social");
  });

  it("metadata.category is 'narthex'", () => {
    expect(socialWidget.metadata.category).toBe("narthex");
  });

  it("metadata.singleton is true", () => {
    expect(socialWidget.metadata.singleton).toBe(true);
  });

  it("metadata.singletonId is 'skein-social'", () => {
    expect(socialWidget.metadata.singletonId).toBe("skein-social");
  });

  it("metadata.defaultWidth is 280", () => {
    expect(socialWidget.metadata.defaultWidth).toBe(280);
  });

  it("metadata.defaultHeight is 500", () => {
    expect(socialWidget.metadata.defaultHeight).toBe(500);
  });

  it("schema is defined and equals socialSchema", () => {
    expect(socialWidget.schema).toBeDefined();
    expect(socialWidget.schema).toBe(socialSchema);
  });

  it("editableProps is empty array", () => {
    expect(socialWidget.editableProps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isValidNodeId
// ---------------------------------------------------------------------------

describe("isValidNodeId", () => {
  it("accepts valid 64-char lowercase hex string", () => {
    const valid = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    expect(valid).toHaveLength(64);
    expect(isValidNodeId(valid)).toBe(true);
  });

  it("accepts all-zero 64-char hex", () => {
    expect(isValidNodeId("0".repeat(64))).toBe(true);
  });

  it("accepts all-f 64-char hex", () => {
    expect(isValidNodeId("f".repeat(64))).toBe(true);
  });

  it("rejects strings too short", () => {
    expect(isValidNodeId("abcdef1234")).toBe(false);
    expect(isValidNodeId("a".repeat(63))).toBe(false);
  });

  it("rejects strings too long", () => {
    expect(isValidNodeId("a".repeat(65))).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(isValidNodeId("A".repeat(64))).toBe(false);
    expect(isValidNodeId("ABCDEF".repeat(10) + "ABCD")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    const withG = "g" + "a".repeat(63);
    expect(isValidNodeId(withG)).toBe(false);

    const withDash = "a".repeat(32) + "-" + "a".repeat(31);
    expect(isValidNodeId(withDash)).toBe(false);

    const withSpace = " " + "a".repeat(63);
    expect(isValidNodeId(withSpace)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidNodeId("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// friendDisplayName
// ---------------------------------------------------------------------------

describe("friendDisplayName", () => {
  const makeFriend = (overrides: Partial<FriendEntry> = {}): FriendEntry => ({
    id: "test-id",
    alias: "",
    username: "",
    group: "",
    nodeIds: [],
    createdAt: "",
    ...overrides,
  });

  it("returns username over alias when both are set", () => {
    const friend = makeFriend({ alias: "bestie", username: "bob" });
    expect(friendDisplayName(friend)).toBe("bob");
  });

  it("returns username when set", () => {
    const friend = makeFriend({ username: "bob" });
    expect(friendDisplayName(friend)).toBe("bob");
  });

  it("returns truncated nodeId when alias and username are empty", () => {
    const nodeId = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const friend = makeFriend({
      nodeIds: [{ nodeId, addedAt: "", lastSeenAt: "", username: "", bio: "", avatarDataUrl: "" }],
    });
    const result = friendDisplayName(friend);
    expect(result).toBe("abcdef01...23456789");
    expect(result).toHaveLength(19); // 8 + 3 + 8
  });

  it("returns 'unknown' when all fields are empty", () => {
    const friend = makeFriend();
    expect(friendDisplayName(friend)).toBe("unknown");
  });

  it("prefers username over everything else", () => {
    const nodeId = "a".repeat(64);
    const friend = makeFriend({
      alias: "my-alias",
      username: "bob",
      nodeIds: [{ nodeId, addedAt: "", lastSeenAt: "", username: "", bio: "", avatarDataUrl: "" }],
    });
    expect(friendDisplayName(friend)).toBe("bob");
  });

  it("returns alias when username is empty", () => {
    const friend = makeFriend({ alias: "bestie" });
    expect(friendDisplayName(friend)).toBe("bestie");
  });
});

// ---------------------------------------------------------------------------
// friendHasPendingOutboundRequest
// ---------------------------------------------------------------------------

describe("friendHasPendingOutboundRequest", () => {
  const makeFriend = (overrides: Partial<FriendEntry> = {}): FriendEntry => ({
    id: "test-id",
    alias: "",
    username: "",
    group: "",
    nodeIds: [],
    createdAt: "",
    ...overrides,
  });

  const makeOutboundRequest = (
    overrides: Partial<OutboundFriendRequest> = {}
  ): OutboundFriendRequest => ({
    toNodeId: "b".repeat(64),
    toUsername: "unknown",
    sentAt: "",
    expiresAt: "",
    status: "pending",
    ...overrides,
  });

  it("returns true when a friend's nodeId has a pending outbound request", () => {
    const nodeId = "a".repeat(64);
    const friend = makeFriend({
      nodeIds: [{ nodeId, addedAt: "", lastSeenAt: "", username: "", bio: "", avatarDataUrl: "" }],
    });
    const outboundRequests = [makeOutboundRequest({ toNodeId: nodeId, status: "pending" })];
    expect(friendHasPendingOutboundRequest(friend, outboundRequests)).toBe(true);
  });

  it("returns false when the outbound request has already been accepted", () => {
    const nodeId = "a".repeat(64);
    const friend = makeFriend({
      nodeIds: [{ nodeId, addedAt: "", lastSeenAt: "", username: "", bio: "", avatarDataUrl: "" }],
    });
    const outboundRequests = [makeOutboundRequest({ toNodeId: nodeId, status: "accepted" })];
    expect(friendHasPendingOutboundRequest(friend, outboundRequests)).toBe(false);
  });

  it("returns false when no outbound request matches any of the friend's nodeIds", () => {
    const friend = makeFriend({
      nodeIds: [
        { nodeId: "a".repeat(64), addedAt: "", lastSeenAt: "", username: "", bio: "", avatarDataUrl: "" },
      ],
    });
    const outboundRequests = [makeOutboundRequest({ toNodeId: "c".repeat(64) })];
    expect(friendHasPendingOutboundRequest(friend, outboundRequests)).toBe(false);
  });

  it("returns false when outboundRequests is empty", () => {
    const friend = makeFriend({
      nodeIds: [
        { nodeId: "a".repeat(64), addedAt: "", lastSeenAt: "", username: "", bio: "", avatarDataUrl: "" },
      ],
    });
    expect(friendHasPendingOutboundRequest(friend, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// friendDisplayNameFull
// ---------------------------------------------------------------------------

describe("friendDisplayNameFull", () => {
  const makeFriend = (overrides: Partial<FriendEntry> = {}): FriendEntry => ({
    id: "test-id",
    alias: "",
    username: "",
    group: "",
    nodeIds: [],
    createdAt: "",
    ...overrides,
  });

  it("returns 'username (alias)' when both are set", () => {
    const friend = makeFriend({ alias: "bestie", username: "bob" });
    expect(friendDisplayNameFull(friend)).toBe("bob (bestie)");
  });

  it("returns username alone when alias is empty", () => {
    const friend = makeFriend({ username: "bob" });
    expect(friendDisplayNameFull(friend)).toBe("bob");
  });

  it("returns alias alone when username is empty", () => {
    const friend = makeFriend({ alias: "bestie" });
    expect(friendDisplayNameFull(friend)).toBe("bestie");
  });

  it("returns truncated nodeId when alias and username are empty", () => {
    const nodeId = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const friend = makeFriend({
      nodeIds: [{ nodeId, addedAt: "", lastSeenAt: "", username: "", bio: "", avatarDataUrl: "" }],
    });
    expect(friendDisplayNameFull(friend)).toBe("abcdef01...23456789");
  });

  it("returns 'unknown' when everything is empty", () => {
    const friend = makeFriend();
    expect(friendDisplayNameFull(friend)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// colorForName
// ---------------------------------------------------------------------------

describe("colorForName", () => {
  it("returns a number", () => {
    expect(typeof colorForName("alice", 0)).toBe("number");
  });

  it("returns deterministic color for the same name", () => {
    const a = colorForName("alice", 0);
    const b = colorForName("alice", 0);
    expect(a).toBe(b);
  });

  it("returns different colors for different names", () => {
    // not strictly guaranteed, but with these specific names the hashes differ
    const a = colorForName("alice", 0);
    const b = colorForName("zzzzz", 0);
    expect(a).not.toBe(b);
  });

  it("falls back to index-based color for empty name", () => {
    const c0 = colorForName("", 0);
    const c1 = colorForName("", 1);
    // with different indices, should cycle through palette
    expect(typeof c0).toBe("number");
    expect(typeof c1).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns string unchanged when under max length", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns string unchanged when exactly max length", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates with ellipsis when over max length", () => {
    const result = truncate("hello world", 6);
    expect(result).toHaveLength(6);
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildFriendRowItems — grouping / sort-order / reserved hub-nodes section
// (docs/hub-and-profile-plan.md section 4)
// ---------------------------------------------------------------------------

function makeFriend(overrides: Partial<FriendEntry> & { id: string }): FriendEntry {
  return {
    alias: "",
    username: overrides.id,
    group: "",
    nodeIds: [],
    createdAt: "",
    isHub: false,
    ...overrides,
  };
}

describe("buildFriendRowItems", () => {
  it("sorts real groups alphabetically with ungrouped friends last, no hub section when there are no hub friends", () => {
    const friends = [
      makeFriend({ id: "a", group: "zebra" }),
      makeFriend({ id: "b", group: "" }),
      makeFriend({ id: "c", group: "apple" }),
    ];
    const items = buildFriendRowItems(friends, new Set());

    expect(items).toEqual([
      { type: "header", group: "apple", count: 1 },
      { type: "friend", friend: friends[2] },
      { type: "header", group: "zebra", count: 1 },
      { type: "friend", friend: friends[0] },
      { type: "friend", friend: friends[1] },
    ]);
  });

  it("puts the reserved hub-nodes section after every real group and the ungrouped bucket", () => {
    const friends = [
      makeFriend({ id: "grouped", group: "zebra" }),
      makeFriend({ id: "ungrouped", group: "" }),
      makeFriend({ id: "hub-1", isHub: true }),
    ];
    const items = buildFriendRowItems(friends, new Set());

    expect(items).toEqual([
      { type: "header", group: "zebra", count: 1 },
      { type: "friend", friend: friends[0] },
      { type: "friend", friend: friends[1] },
      { type: "header", group: HUB_GROUP_KEY, count: 1 },
      { type: "friend", friend: friends[2] },
    ]);
  });

  it("excludes a hub friend from the normal group listing even when it has a stray group value, without mutating that field", () => {
    const hub = makeFriend({ id: "hub-1", isHub: true, group: "leftover-group" });
    const items = buildFriendRowItems([hub], new Set());

    // only ever appears once, in the reserved hub section — never under "leftover-group"
    const friendRows = items.filter((i) => i.type === "friend");
    expect(friendRows).toHaveLength(1);
    expect(items).toEqual([
      { type: "header", group: HUB_GROUP_KEY, count: 1 },
      { type: "friend", friend: hub },
    ]);
    // the friend's own group field is untouched
    expect(hub.group).toBe("leftover-group");
  });

  it("omits the hub-nodes header entirely when there are no hub friends", () => {
    const friends = [makeFriend({ id: "a" })];
    const items = buildFriendRowItems(friends, new Set());
    expect(items.some((i) => i.type === "header" && i.group === HUB_GROUP_KEY)).toBe(false);
  });

  it("hides a real group's members when its name is collapsed, but keeps its header", () => {
    const friends = [makeFriend({ id: "a", group: "zebra" }), makeFriend({ id: "b", group: "zebra" })];
    const items = buildFriendRowItems(friends, new Set(["zebra"]));
    expect(items).toEqual([{ type: "header", group: "zebra", count: 2 }]);
  });

  it("hides hub friends when the reserved hub-nodes key is collapsed, but keeps its header", () => {
    const friends = [makeFriend({ id: "hub-1", isHub: true }), makeFriend({ id: "hub-2", isHub: true })];
    const items = buildFriendRowItems(friends, new Set([HUB_GROUP_KEY]));
    expect(items).toEqual([{ type: "header", group: HUB_GROUP_KEY, count: 2 }]);
  });

  it("returns an empty list for no friends at all", () => {
    expect(buildFriendRowItems([], new Set())).toEqual([]);
  });
});

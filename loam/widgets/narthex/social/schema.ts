import { z } from "zod";

// ---------------------------------------------------------------------------
// friend sub-schemas (ported from friends-widget.ts)
// ---------------------------------------------------------------------------

export const friendNodeIdSchema = z.object({
  nodeId: z.string(),
  addedAt: z.string().default(""),
  lastSeenAt: z.string().default(""),
  // profile fields populated by fetching the peer's profile
  username: z.string().default(""),
  bio: z.string().default(""),
  avatarDataUrl: z.string().default(""),
});

export const friendEntrySchema = z.object({
  id: z.string(), // UUID — canonical friend identity
  alias: z.string().default(""), // user-set nickname (display priority)
  username: z.string().default(""), // best-effort: from most recently seen nodeId's profile
  group: z.string().default(""), // folder-style group name ("" = ungrouped)
  nodeIds: z.array(friendNodeIdSchema).default([]),
  createdAt: z.string().default(""),
  // true if this friend is a reliquary hub node, set from the isHub flag on
  // an incoming friend-request/friend-accept message (see
  // docs/hub-and-profile-plan.md section 3). sticky/OR-merge once true —
  // never unset by a later message that omits the flag (same spirit as
  // CanvasStore.addHubNodeId()'s append-only dedup).
  isHub: z.boolean().default(false),
});

export const friendGroupSchema = z.object({
  name: z.string(),
  createdAt: z.string().default(""),
});

// ---------------------------------------------------------------------------
// canvas-sharing groups
//
// NOT the same concept as `friendGroupSchema` above — that's a folder-style
// label for organizing the friends list UI (one group name per friend, no
// member list of its own). a `shareGroup` is a named collection of peer
// node ids the local user can share a canvas with all at once (see
// GroupStore in src/canvas/group-store.ts). a node id can belong to any
// number of share groups at the same time (many-to-many) — there's no
// single "the group" a peer is filed under, unlike the friend-folder model.
//
// design decisions (see GroupStore's doc comment for the full rationale):
// - groups are private, per-user data living in the local user's own
//   social doc (see SocialDoc) — not synced to the group's members, and
//   not a shared/co-owned concept between multiple people managing the
//   same group. they're an organizational convenience for the sharer, the
//   same way an address book's contact groups are private to the address
//   book's owner.
// - sharing a canvas with a group is a one-time bulk-invite: it expands
//   the group's *current* membership into individual canvas ACL entries
//   and leaves no ongoing link afterward. adding someone to a group later
//   does NOT retroactively grant them access to canvases already shared
//   with that group — see GroupStore.shareCanvasWithGroup().
// ---------------------------------------------------------------------------

export const shareGroupSchema = z.object({
  /** stable id, independent of display name (names can be renamed/reused). */
  id: z.string(),
  name: z.string(),
  /** peer node ids currently in this group. */
  memberNodeIds: z.array(z.string()).default([]),
  createdAt: z.string().default(""),
});

export const pendingFriendRequestSchema = z.object({
  fromNodeId: z.string(),
  fromUsername: z.string().default(""),
  receivedAt: z.string().default(""),
  status: z.enum(["pending", "accepted", "accepted-pending-ack", "rejected"]).default("pending"),
});

export const outboundFriendRequestSchema = z.object({
  toNodeId: z.string(),
  toUsername: z.string().default(""),
  sentAt: z.string().default(""),
  status: z.enum(["pending", "accepted", "accepted-pending-ack", "rejected"]).default("pending"),
});

// ---------------------------------------------------------------------------
// profile sub-schema (ported from profile-widget.ts)
// ---------------------------------------------------------------------------

export const profileSchema = z.object({
  username: z.string().default(""),
  bio: z.string().default(""),
  avatarDataUrl: z.string().default(""),
  accentColor: z.number().default(0x6366f1),
  nodeId: z.string().default(""),
});

// ---------------------------------------------------------------------------
// root social schema
// ---------------------------------------------------------------------------

export const socialSchema = z.object({
  /** local identity — username, bio, avatar, accent color, node ID */
  profile: profileSchema.default({
    username: "",
    bio: "",
    avatarDataUrl: "",
    accentColor: 0x6366f1,
    nodeId: "",
  }),

  /** peer directory */
  friends: z.array(friendEntrySchema).default([]),
  groups: z.array(friendGroupSchema).default([]),

  /** canvas-sharing groups — see shareGroupSchema above. distinct from
   *  `groups` (friend-list folder labels) above. */
  shareGroups: z.array(shareGroupSchema).default([]),

  /** friend requests */
  pendingRequests: z.array(pendingFriendRequestSchema).default([]),
  outboundRequests: z.array(outboundFriendRequestSchema).default([]),

  /** privacy settings */
  profileVisibility: z.enum(["friends", "everyone", "nobody"]).default("friends"),
  friendRequestsFrom: z.enum(["everyone", "nobody"]).default("everyone"),
});

// ---------------------------------------------------------------------------
// inferred types
// ---------------------------------------------------------------------------

export type FriendNodeId = z.infer<typeof friendNodeIdSchema>;
export type FriendEntry = z.infer<typeof friendEntrySchema>;
export type FriendGroup = z.infer<typeof friendGroupSchema>;
export type ShareGroup = z.infer<typeof shareGroupSchema>;
export type PendingFriendRequest = z.infer<typeof pendingFriendRequestSchema>;
export type OutboundFriendRequest = z.infer<typeof outboundFriendRequestSchema>;
export type ProfileState = z.infer<typeof profileSchema>;
export type SocialState = z.infer<typeof socialSchema>;

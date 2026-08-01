import { z } from "zod";

// ---------------------------------------------------------------------------
// friend sub-schemas
// ---------------------------------------------------------------------------

export const friendNodeIdSchema = z.object({
  nodeId: z.string(),
  addedAt: z.string().default(""),
  lastSeenAt: z.string().default(""),
  // profile fields populated by fetching the peer's profile
  username: z.string().default(""),
  bio: z.string().default(""),
  avatarDataUrl: z.string().default(""),
  // this peer's own profile accent color (profileSchema.accentColor on
  // their side), learned the same way as avatarDataUrl/username — via a
  // profile-response message (see friends-protocol.ts's
  // ProfileResponseMessage and friendz-wiring.ts's onProfileResponse).
  // undefined until a profile response naming a color has arrived; canvas
  // presence cursors fall back to the palette-assigned color until then
  // (see presence-renderer.ts's resolveCursorColor()).
  accentColor: z.number().optional(),
  // pointer to this peer's profile automerge doc (docs/hub-and-profile-plan.md
  // section 6) — learned either directly (profile-request/response) or
  // relayed via gossip digest from a mutual friend/hub (section 6's "hub
  // gossip of profile docs"). "" means unknown. `profileUpdatedAt` mirrors
  // ProfileStore.updatedAt() at the time this was learned, so a later
  // gossip entry for the same peer can be compared for staleness without
  // opening the doc itself. sticky: once learned, only ever overwritten by
  // a strictly newer `profileUpdatedAt` (or an equal-or-later one with a
  // non-empty id, when the currently stored id is empty) — never blanked
  // out by an older/incomplete message arriving late.
  profileDocId: z.string().default(""),
  profileUpdatedAt: z.string().default(""),
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
  // identity info carried on the request itself (sent regardless of the
  // sender's own profile visibility setting) so a pending request shows
  // more than a bare node id/username - updated in place if the sender
  // resends the request after editing their profile.
  fromBio: z.string().default(""),
  fromAvatarDataUrl: z.string().default(""),
  fromAccentColor: z.number().optional(),
  receivedAt: z.string().default(""),
  status: z.enum(["pending", "accepted", "accepted-pending-ack", "rejected"]).default("pending"),
  // node id of the mutual friend/hub that relayed this request to us,
  // rather than the requester dialing us directly - "" for a directly-
  // received request. mirrors CanvasInviteMessage's relayedBy attribution.
  relayedBy: z.string().default(""),
  // absolute cutoff for gossiping our eventual accept/decline back to the
  // requester if they're offline when we decide - see
  // relayedFriendRequestOutcomeSchema below. carried through unchanged from
  // whichever gossip-digest entry (or direct request, sentAt + 60 days)
  // first taught us about this request, so every relay hop agrees on the
  // same deadline regardless of how many hops it took to arrive.
  expiresAt: z.string().default(""),
});

export const outboundFriendRequestSchema = z.object({
  toNodeId: z.string(),
  toUsername: z.string().default(""),
  /** filled in once known, via a profile-response, identity-update, or
   *  gossip-relayed friend-request-outcome/pending-request from the
   *  recipient (never known at send time — an outbound friend request is
   *  often the very first contact with this node id) — see
   *  friendz-wiring.ts's onProfileResponse/onIdentityUpdate/onGossipDigest
   *  handlers. */
  toBio: z.string().default(""),
  toAvatarDataUrl: z.string().default(""),
  toAccentColor: z.number().optional(),
  sentAt: z.string().default(""),
  // absolute cutoff (sentAt + 60 days) past which mutual friends/hubs stop
  // gossiping this request onward to the target - see
  // computeAndSendGossipDigest's pendingFriendRequests gathering.
  expiresAt: z.string().default(""),
  status: z
    .enum(["pending", "accepted", "accepted-pending-ack", "rejected", "expired"])
    .default("pending"),
});

/**
 * a friend request this peer is holding purely to relay onward - neither
 * the original requester (`fromNodeId`) nor the target (`toNodeId`) is the
 * local user. populated from a gossip digest's `pendingFriendRequests`
 * entries (see friendz-wiring.ts's onGossipDigest) and re-gossiped to every
 * online friend on every subsequent digest exchange until it expires, so
 * the request keeps propagating through the friend graph even if the peer
 * holding it is never simultaneously online with both the requester and
 * the target.
 */
export const relayedFriendRequestSchema = z.object({
  fromNodeId: z.string(),
  fromUsername: z.string().default(""),
  fromBio: z.string().default(""),
  fromAvatarDataUrl: z.string().default(""),
  fromAccentColor: z.number().optional(),
  toNodeId: z.string(),
  requestedAt: z.string().default(""),
  expiresAt: z.string().default(""),
});

/**
 * a resolved (accepted/rejected) friend request this peer is holding
 * purely to relay the outcome back to the original requester - either
 * because the local user themselves resolved the request (see
 * requests-tab.ts's accept/reject handlers, which push an entry here
 * alongside the direct friend-accept/friend-reject message) or because
 * it arrived via someone else's gossip digest and is being relayed
 * further.
 */
export const relayedFriendRequestOutcomeSchema = z.object({
  fromNodeId: z.string(), // the original requester - who this outcome is for
  resolverNodeId: z.string(), // who accepted/rejected the request
  outcome: z.enum(["accepted", "rejected"]),
  resolverUsername: z.string().default(""),
  resolverBio: z.string().default(""),
  resolverAvatarDataUrl: z.string().default(""),
  resolverAccentColor: z.number().optional(),
  resolvedAt: z.string().default(""),
  expiresAt: z.string().default(""),
});

// ---------------------------------------------------------------------------
// profile sub-schema
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

  /** third-party friend-request relay state - see relayedFriendRequestSchema/
   *  relayedFriendRequestOutcomeSchema above for what each array holds. */
  relayedFriendRequests: z.array(relayedFriendRequestSchema).default([]),
  relayedFriendRequestOutcomes: z.array(relayedFriendRequestOutcomeSchema).default([]),

  /** privacy settings */
  profileVisibility: z.enum(["friends", "everyone", "nobody"]).default("friends"),
  friendRequestsFrom: z.enum(["everyone", "nobody"]).default("everyone"),

  /** short synthesized sound effects (friend online, new message, friend
   *  request) — see src/sfx/index.ts. a single on/off toggle covering all
   *  of them (settings-tab.ts's UI is tight on space); defaults on. */
  soundEffectsEnabled: z.boolean().default(true),
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
export type RelayedFriendRequest = z.infer<typeof relayedFriendRequestSchema>;
export type RelayedFriendRequestOutcome = z.infer<typeof relayedFriendRequestOutcomeSchema>;
export type ProfileState = z.infer<typeof profileSchema>;
export type SocialState = z.infer<typeof socialSchema>;

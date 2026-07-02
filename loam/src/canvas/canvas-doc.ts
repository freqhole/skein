import { z } from "zod";

// ---------------------------------------------------------------------------
// ACL role — the single source of truth for role names/values.
//
// import `CanvasRole`/`InvitableRole` (and the schemas, where runtime
// validation is needed) from here rather than re-declaring the literal
// union inline — this was previously duplicated across canvas-store.ts,
// share-dialog.ts, boot.ts, friends-protocol.ts, friendz-bridge.ts, and
// widgets/narthex/canvas-card.ts, which made the 2026-07-01 owner/editor
// → admin/member rename a many-file hunt (and nearly missed a zod-validated
// widget schema that would have silently rejected the new role values).
// ---------------------------------------------------------------------------

/**
 * a canvas ACL role. names match tomb/'s role model:
 * - `admin`: can read/write/invite other peers, can approve knock requests
 * - `member`: can read/write, cannot invite/share or approve knocks
 * - `viewer`: read-only
 *
 * exactly one peer per canvas is stamped `admin` at creation time (see
 * `CanvasStore.stampAdmin()`); it cannot be granted via invite (see
 * `InvitableRole` below) or reassigned via `CanvasStore.setRole()`.
 */
export const canvasRoleSchema = z.enum(["admin", "member", "viewer"]);
export type CanvasRole = z.infer<typeof canvasRoleSchema>;

/**
 * roles that can actually be granted via invite or role-change. `admin` is
 * deliberately excluded — it's only ever self-assigned once, at canvas
 * creation (see `CanvasRole` above).
 */
export const invitableRoleSchema = z.enum(["member", "viewer"]);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

/**
 * role value used in ACL-change protocol messages, where `"removed"` means
 * access was revoked entirely (see `friends-protocol.ts`'s `AclChangeMessage`).
 */
export const canvasRoleOrRemovedSchema = z.enum(["admin", "member", "viewer", "removed"]);
export type CanvasRoleOrRemoved = z.infer<typeof canvasRoleOrRemovedSchema>;

/**
 * a single widget's entry in the canvas document.
 * this describes the widget's position, size, type, and props
 * as seen by the canvas layout system.
 *
 * the widget's internal state lives in a separate per-widget document
 * (referenced by docId).
 */
export interface WidgetEntry {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  props: Record<string, unknown>;
  collapsed: boolean;
  /** user-editable display title shown in the frame header.
   *  when empty or undefined, the frame falls back to the factory metadata name. */
  title?: string;
  /** automerge document id for the widget's internal state. null if stateless. */
  docId: string | null;
  /** if set, this widget is nested inside another widget (e.g. a bin).
   *  the parent widget handles rendering; the widget manager skips mounting. */
  parentId?: string | null;
}

/** a peer that has connected to this canvas via P2P. */
export interface CanvasPeer {
  nodeId: string;
  joinedAt: string;
  /** ISO timestamp of when this peer last viewed or interacted with this canvas.
   *  each peer stamps only their own entry — no conflict possible. */
  lastSeenAt?: string;
}

/**
 * a canvas invite awaiting the target peer's response, or accepted but not
 * yet connected. tracked in the canvas doc (not just the messagez outbox)
 * so any peer on the canvas can see and relay it — see `pendingInvites` on
 * `CanvasDocument`.
 *
 * lifecycle: created on invite → `accepted`/`acceptedAt` set when an admin
 * receives the target's accept message (still present in this map — the
 * target hasn't necessarily connected yet) → removed once the target
 * actually shows up in `peers` (see boot.ts's join/navigate flow) or the
 * invite is cancelled/declined. **do not delete this entry purely because
 * an accept message arrived** — that was the old, buggy behavior (accepted
 * invites vanished from the UI before the peer ever connected, with no
 * "connecting…" state to show in the meantime).
 */
export interface PendingCanvasInvite {
  /** node ID of the peer who created the invite. */
  invitedBy: string;
  /** username of the inviter for display. */
  invitedByUsername: string;
  /** role being offered — admin invites are not sent via this path (an
   *  admin role is only ever self-assigned by the canvas creator, see
   *  `CanvasStore.stampAdmin()`). */
  role: InvitableRole;
  /** ISO timestamp when the invite was created. */
  invitedAt: string;
  /** true once an admin has received an accept message from the target. */
  accepted?: boolean;
  /** ISO timestamp of when the accept message was received. */
  acceptedAt?: string;
}

/**
 * a knock request awaiting an admin's decision, keyed by the requester's
 * node id — same shape/reasoning as `pendingInvites`: any peer (or the
 * hub) that already holds this canvas doc can see and relay a knock, and
 * it syncs to every admin's own devices via the normal CRDT sync path,
 * not a live-only proxy call. the `Record` key being the requester's node
 * id is what gives us "one outstanding knock per node id" for free — see
 * `CanvasStore.recordKnock()`'s doc comment for the exact enforcement +
 * idempotent-retry rules.
 */
export interface PendingCanvasKnock {
  /** node id of the peer knocking. redundant with the map key, kept for
   *  convenience when iterating values without the key. */
  requesterNodeId: string;
  /** pre-filled from the requester's local identity/profile, same as
   *  tomb's knock form. */
  requesterUsername: string;
  /** free-text message — same placeholder copy as the existing knock-form
   *  spec: "say who you are and mention something only the admin would
   *  know (but no passwords or secrets!)" */
  message: string;
  /** ISO timestamp the knock was first recorded (by whichever peer first
   *  wrote it into this map — may be later than when the requester
   *  actually sent it, if it arrived via relay). */
  knockedAt: string;
  /**
   * append-only decision log — every admin's response, in the order this
   * peer became aware of them. NOT a single mutable status field: two
   * admins can make conflicting decisions concurrently before either has
   * synced the other's, and automerge's per-field last-write-wins
   * semantics would silently pick one with no record of the conflict
   * ever existing. logging every decision and resolving deterministically
   * on read (see `CanvasStore.resolveKnockDecision()`) makes the conflict
   * visible and auditable instead of silently losing one admin's action.
   */
  decisions: KnockDecision[];
  /** set once the knock is fully approved and access has actually been
   *  granted (see `CanvasStore.setRole()` in the approval flow — a later
   *  phase, not implemented here). `resolveKnockDecision()` itself is a
   *  pure, read-only function and does not write this field; it's the
   *  approval flow's job. absent while still pending or mid-decision. */
  resolvedRole?: InvitableRole;
}

/** a single admin's response to a knock — see `PendingCanvasKnock.decisions`
 *  for why this is an append-only log rather than one mutable status field. */
export interface KnockDecision {
  /** node id of the admin who made this decision. */
  byNodeId: string;
  decision: "approve" | "decline";
  /** role granted, if `decision === "approve"`. admin picks this at
   *  approval time, same as the existing invite flow. */
  role?: InvitableRole;
  /** ISO timestamp this decision was made. NOT used to resolve conflicts
   *  (see `PendingCanvasKnock.decisions` — resolution is by insertion
   *  order, not wall-clock time, to avoid clock-skew ambiguity); kept for
   *  display only. */
  at: string;
}

/**
 * the top-level canvas document stored in Automerge.
 * contains the layout of all widgets on the canvas.
 */
export interface CanvasDocument {
  version: number;
  widgets: Record<string, WidgetEntry>;
  /** display title of the canvas */
  title: string;
  /** short description of the canvas */
  description: string;
  /** ISO date string when the canvas was created */
  createdAt: string;
  /** ISO date string when the canvas was last modified */
  lastModified: string;
  /** node ID of the peer who last modified this canvas */
  lastModifiedBy: string;
  /** tag color for the canvas (used for visual theming on narthex cards). 0 means no color set. */
  color: number;
  /** data URL for a preview/thumbnail image */
  previewUrl: string;
  /** peers that have connected to this canvas — used to re-establish P2P on reload */
  peers: Record<string, CanvasPeer>;
  /** pending invites for peers who haven't joined yet.
   *  keyed by target node ID. used for gossip relay — any peer on the canvas
   *  can read this and relay the invite when the target comes online. */
  pendingInvites?: Record<string, PendingCanvasInvite>;
  /**
   * knock requests awaiting an admin's decision, keyed by the requester's
   * node id — same shape/reasoning as `pendingInvites`: any peer (or the
   * hub) that already holds this canvas doc can see and relay a knock, and
   * it syncs to every admin's own devices via the normal CRDT sync path,
   * not a live-only proxy call. **the `Record` key being the requester's
   * node id is what gives us "one outstanding knock per node id" for
   * free** — see `CanvasStore.recordKnock()`'s doc comment for the exact
   * enforcement + idempotent-retry rules.
   */
  pendingKnocks?: Record<string, PendingCanvasKnock>;
  /** access control list — maps nodeId to role. see `CanvasRole` above for
   *  the semantics of each role. */
  acl?: Record<string, { role: CanvasRole }>;
  /** node ids that are reliquary hubs this canvas has been shared with.
   *  written once when the existing "share this canvas with a hub" flow
   *  completes. lets any peer who later joins this canvas — not just the
   *  one who did the sharing — recognize hub-relayed activity, since this
   *  syncs like any other canvas doc field. */
  hubNodeIds?: string[];
  /** tombstone: canvas has been deleted by owner */
  deleted?: boolean;
  /** ISO timestamp of when the canvas was deleted */
  deletedAt?: string;
  /** node ID of the peer who deleted this canvas */
  deletedBy?: string;
  /** deletion mode — soft (read-only copy remains) or purge (auto-delete everywhere) */
  deleteMode?: "soft" | "purge";
}

/**
 * create an empty canvas document with default values.
 */
export function emptyCanvasDoc(): CanvasDocument {
  return {
    version: 1,
    widgets: {},
    title: "",
    description: "",
    createdAt: "",
    lastModified: "",
    lastModifiedBy: "",
    color: 0,
    previewUrl: "",
    peers: {},
  };
}

// ---------------------------------------------------------------------------
// friendz protocol adapter — freqhole-friendz/1
//
// bridges skein's existing friend/presence/knock/canvas UI and business
// logic onto the shared wire protocol owned by `@freqhole/haruspex/protocol`
// (`FriendzClient`, `CoreMessage`, `AppExtensionMessage`), instead of a
// bespoke skein-only codec. presence, friend requests, knocks, and acl
// notifications ride the protocol's core message set; canvas invite/update/
// delete notifications (skein-only concepts with no core equivalent) ride
// as `skein:`-namespaced app-extension messages.
//
// this file keeps the same public `FriendzProtocol` class shape (method
// names, event-handler properties, message field names) that existed
// before this protocol swap, so the rest of skein's already-tested friend/
// canvas/knock business logic (friendz-wiring.ts, friendz-bridge.ts, the
// p2p test harness) doesn't need to relearn new field names for concepts
// whose shape didn't change - only the actual bytes on the wire changed,
// and the handful of messages whose shape genuinely did change (acl-change,
// canvas-knock*, gossip-digest) are translated here, in one place.
// ---------------------------------------------------------------------------

import {
  createFriendzClient,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  type CoreMessage,
  type FriendzClient,
  type FriendzMessage as WireMessage,
  type WireRole,
} from "@freqhole/haruspex/protocol";
import type { BiStreamLike, MiddenStreamNode } from "./iroh-network-adapter";
import type { CanvasRoleOrRemoved, InvitableRole } from "../canvas/canvas-doc";
import { log } from "@freqhole/reliquary/utils";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const TAG = "p2p.friendz";

/** how often to send heartbeat pings to friends (ms). matches the shared
 *  protocol's own default, so `FriendzClient`'s online/offline window and
 *  this adapter's own send cadence agree. */
export const HEARTBEAT_INTERVAL_MS = DEFAULT_HEARTBEAT_INTERVAL_MS;

/** time after last heartbeat before marking a friend offline (ms). */
export const HEARTBEAT_TIMEOUT_MS = DEFAULT_HEARTBEAT_TIMEOUT_MS;

/** interval for probing offline friends to see if they came back (ms). */
export const DISCOVERY_SWEEP_MS = 300_000; // 5 min

// ---------------------------------------------------------------------------
// message shapes consumed by this app's callbacks/senders
//
// these are no longer wire formats (the shared protocol owns the actual
// bytes) - they're this adapter's own internal shape for the concepts
// skein's UI/business logic cares about. most are unchanged from before
// this protocol swap; a few (canvas-knock*, acl-change, gossip-digest) are
// translated to/from the shared protocol's shapes, documented at each
// translation site below.
// ---------------------------------------------------------------------------

/** request the peer's profile. */
export interface ProfileRequestMessage {
  type: "profile-request";
}

export interface ProfileResponseMessage {
  type: "profile-response";
  username: string;
  bio: string;
  avatarDataUrl: string;
  accentColor?: number;
  profileDocId?: string;
  profileUpdatedAt?: string;
}

export interface FriendRequestMessage {
  type: "friend-request";
  fromNodeId: string;
  fromUsername: string;
  isHub?: boolean;
}

export interface FriendAcceptMessage {
  type: "friend-accept";
  fromNodeId: string;
  fromUsername: string;
  isHub?: boolean;
}

export interface FriendRejectMessage {
  type: "friend-reject";
  fromNodeId: string;
}

/** lightweight activity summary for a shared canvas, piggybacked on
 *  heartbeat via the shared protocol's generic `appPayload` field. */
export interface CanvasActivityEntry {
  canvasDocId: string;
  lastModifiedAt: string;
  widgetCount: number;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  nodeId: string;
  username: string;
  canvasActivity?: CanvasActivityEntry[];
}

export interface FriendAcceptAckMessage {
  type: "friend-accept-ack";
  fromNodeId: string;
}

/** sent as a `skein:canvas-invite` app-extension message. */
export interface CanvasInviteMessage {
  type: "canvas-invite";
  inviteId: string;
  canvasDocId: string;
  canvasTitle: string;
  canvasDescription?: string;
  canvasColor?: number;
  canvasPreviewUrl?: string;
  originNodeId: string;
  originUsername: string;
  role: InvitableRole;
  targets: string[];
  acked: string[];
}

export interface CanvasInviteAckMessage {
  type: "canvas-invite-ack";
  inviteId: string;
  canvasDocId: string;
  ackerNodeId: string;
}

export interface CanvasInviteAcceptMessage {
  type: "canvas-invite-accept";
  inviteId: string;
  canvasDocId: string;
  accepterNodeId: string;
}

export interface CanvasInviteDeclineMessage {
  type: "canvas-invite-decline";
  inviteId: string;
  canvasDocId: string;
  declinerNodeId: string;
}

/** a canvas knock (access request) - sent/received as the shared
 *  protocol's `knock-request`, scoped to a resource (`scope.resourceId`
 *  = `canvasDocId`). */
export interface CanvasKnockMessage {
  type: "canvas-knock";
  knockId: string;
  canvasDocId: string;
  requesterNodeId: string;
  requesterUsername: string;
  message: string;
}

/** sent/received as the shared protocol's `knock-ack`. */
export interface CanvasKnockAckMessage {
  type: "canvas-knock-ack";
  knockId: string;
  canvasDocId: string;
  ackerNodeId: string;
}

/**
 * an approved knock - synthesized from the shared protocol's single
 * `knock-outcome` message (`status: "accepted"`). `canvasDocId` is
 * recovered from `grantedResourceIds[0]` (the wire message doesn't carry
 * `canvasDocId` directly - the receiver correlates by `knockId` instead,
 * per the shared protocol's design).
 */
export interface CanvasKnockApproveMessage {
  type: "canvas-knock-approve";
  knockId: string;
  canvasDocId: string;
  approverNodeId: string;
  role: InvitableRole;
}

/**
 * a declined knock - synthesized from `knock-outcome` (`status:
 * "denied"`). `canvasDocId` is not recoverable here (the wire message
 * carries no resource id for a denial) - always `""`.
 */
export interface CanvasKnockDeclineMessage {
  type: "canvas-knock-decline";
  knockId: string;
  canvasDocId: string;
  declinerNodeId: string;
}

/** sent/received as the shared protocol's `acl-change`, with
 *  `canvasDocId`/`canvasTitle` renamed to `resourceId`/`resourceTitle` on
 *  the wire, and `newRole: "removed"` represented as an absent `newRole`
 *  field (the shared protocol has no "removed" role literal). */
export interface AclChangeMessage {
  type: "acl-change";
  canvasDocId: string;
  canvasTitle: string;
  targetNodeId: string;
  newRole: CanvasRoleOrRemoved;
  changedBy: string;
  changedByUsername: string;
}

/** sent as a `skein:canvas-update` app-extension message. */
export interface CanvasUpdateMessage {
  type: "canvas-update";
  canvasDocId: string;
  lastModifiedAt: string;
  widgetCount: number;
  modifiedByNodeId: string;
  modifiedByUsername: string;
}

/** sent as a `skein:canvas-deleted` app-extension message. */
export interface CanvasDeletedMessage {
  type: "canvas-deleted";
  canvasDocId: string;
  canvasTitle: string;
  deletedBy: string;
  deletedByUsername: string;
  deleteMode: "soft" | "purge";
  deletedAt: string;
}

export interface OfflineAnnouncementMessage {
  type: "offline-announcement";
  nodeId: string;
}

/** skein-only canvas-update summary - carried in the shared protocol's
 *  `gossip-digest.appPayload`, alongside `pendingInvites`/`sharedCanvasIds`. */
export interface GossipDigestCanvasUpdate {
  canvasDocId: string;
  lastModifiedAt: string;
  lastModifiedBy: string;
  deleted?: boolean;
}

/** skein-only pending-invite summary - carried in `appPayload`. */
export interface GossipDigestPendingInvite {
  canvasDocId: string;
  canvasTitle: string;
  canvasDescription: string;
  canvasColor: number;
  canvasPreviewUrl: string;
  invitedBy: string;
  invitedByUsername: string;
  role: InvitableRole;
  invitedAt: string;
}

/** a pending knock entry in a gossip digest - sent/received as the shared
 *  protocol's `GossipDigestPendingKnock`, which (unlike this app's own
 *  `PendingCanvasKnock` map) requires a `knockId` and a `scope` rather
 *  than a bare `canvasDocId`. */
export interface GossipDigestPendingKnock {
  knockId: string;
  canvasDocId: string;
  requesterNodeId: string;
  requesterUsername: string;
  message: string;
  knockedAt: string;
}

/** a profile-doc pointer entry in a gossip digest - identical shape on
 *  both sides of the wire, no translation needed. */
export interface GossipDigestProfileEntry {
  peerNodeId: string;
  profileDocId: string;
  updatedAt: string;
}

/** gossip digest sent when a peer comes online. `canvasUpdates`/
 *  `pendingInvites`/`sharedCanvasIds` have no core-protocol equivalent and
 *  ride in the wire message's generic `appPayload` field; `pendingKnocks`/
 *  `profiles` are translated to/from the shared protocol's own shapes. */
export interface GossipDigestMessage {
  type: "gossip-digest";
  canvasUpdates: GossipDigestCanvasUpdate[];
  pendingInvites: GossipDigestPendingInvite[];
  pendingKnocks: GossipDigestPendingKnock[];
  sharedCanvasIds?: string[];
  profiles?: GossipDigestProfileEntry[];
}

/** batch blob availability query - sent/received as the shared protocol's
 *  `blob-seek`, unchanged shape. */
export interface BlobSeekMessage {
  type: "blob-seek";
  needed: string[];
}

/** batch blob availability response - sent/received as `blob-offer`,
 *  unchanged shape. */
export interface BlobOfferMessage {
  type: "blob-offer";
  available: string[];
}

// ---------------------------------------------------------------------------
// event callback types
// ---------------------------------------------------------------------------

export type OnFriendRequest = (request: FriendRequestMessage, fromNodeId: string) => void;
export type OnFriendAccept = (accept: FriendAcceptMessage, fromNodeId: string) => void;
export type OnFriendReject = (reject: FriendRejectMessage, fromNodeId: string) => void;
export type OnProfileResponse = (profile: ProfileResponseMessage, fromNodeId: string) => void;
export type OnHeartbeat = (heartbeat: HeartbeatMessage, fromNodeId: string) => void;
export type OnFriendAcceptAck = (ack: FriendAcceptAckMessage, fromNodeId: string) => void;
export type OnCanvasInvite = (invite: CanvasInviteMessage, fromNodeId: string) => void;
export type OnCanvasInviteAck = (ack: CanvasInviteAckMessage, fromNodeId: string) => void;
export type OnCanvasInviteAccept = (accept: CanvasInviteAcceptMessage, fromNodeId: string) => void;
export type OnCanvasInviteDecline = (
  decline: CanvasInviteDeclineMessage,
  fromNodeId: string
) => void;
export type OnCanvasKnock = (knock: CanvasKnockMessage, fromNodeId: string) => void;
export type OnCanvasKnockAck = (ack: CanvasKnockAckMessage, fromNodeId: string) => void;
export type OnCanvasKnockApprove = (approve: CanvasKnockApproveMessage, fromNodeId: string) => void;
export type OnCanvasKnockDecline = (decline: CanvasKnockDeclineMessage, fromNodeId: string) => void;
export type OnAclChange = (change: AclChangeMessage, fromNodeId: string) => void;
export type OnCanvasUpdate = (msg: CanvasUpdateMessage, fromNodeId: string) => void;
export type OnCanvasDeleted = (msg: CanvasDeletedMessage, fromNodeId: string) => void;

// ---------------------------------------------------------------------------
// FriendzProtocol
// ---------------------------------------------------------------------------

export interface FriendzProtocolOptions {
  /** factory to get the midden node for outbound connections. */
  getMidden: () => Promise<MiddenStreamNode>;
  localNodeId: string;
  localUsername: string;
  getLocalProfile: () => {
    username: string;
    bio: string;
    avatarDataUrl: string;
    accentColor?: number;
    profileDocId?: string;
    profileUpdatedAt?: string;
  };
  isFriend: (nodeId: string) => boolean;
  profileVisibility?: "friends" | "everyone" | "nobody";
  friendRequestsFrom?: "everyone" | "nobody";
  canvasInvitesFrom?: "everyone" | "friends" | "nobody";
  getCanvasActivity?: () => CanvasActivityEntry[];
}

function coreMessage(message: CoreMessage): WireMessage {
  return { kind: "core", message };
}

function extensionMessage(messageType: string, payload: Record<string, unknown>): WireMessage {
  return { kind: "app-extension", messageType, payload };
}

/**
 * handles the shared friendz protocol (`freqhole-friendz/1`) for friend
 * requests, profile sharing, presence heartbeat, canvas knocks, acl
 * change notifications, and gossip digests - plus skein's own canvas
 * invite/update/delete notifications, carried as app-extension messages.
 *
 * usage:
 *   const friendz = new FriendzProtocol({ getMidden, localNodeId, ... });
 *   adapter.registerAlpnHandler(FRIENDZ_ALPN, (stream) => friendz.handleStream(stream));
 */
export class FriendzProtocol {
  private client: FriendzClient;
  private localNodeId: string;
  private localUsername: string;
  private getLocalProfile: FriendzProtocolOptions["getLocalProfile"];
  private isFriend: (nodeId: string) => boolean;
  private profileVisibility: "friends" | "everyone" | "nobody";
  private friendRequestsFrom: "everyone" | "nobody";
  private canvasInvitesFrom: "everyone" | "friends" | "nobody";
  private getCanvasActivity: (() => CanvasActivityEntry[]) | null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private getFriendNodeIds: (() => string[]) | null = null;

  // --- event handlers (set by the consumer) ---

  onFriendRequest: OnFriendRequest | null = null;
  onFriendAccept: OnFriendAccept | null = null;
  onFriendReject: OnFriendReject | null = null;
  onProfileResponse: OnProfileResponse | null = null;
  onHeartbeat: OnHeartbeat | null = null;
  onFriendAcceptAck: OnFriendAcceptAck | null = null;
  onCanvasInvite: OnCanvasInvite | null = null;
  onCanvasInviteAck: OnCanvasInviteAck | null = null;
  onCanvasInviteAccept: OnCanvasInviteAccept | null = null;
  onCanvasInviteDecline: OnCanvasInviteDecline | null = null;
  onCanvasKnock: OnCanvasKnock | null = null;
  onCanvasKnockAck: OnCanvasKnockAck | null = null;
  onCanvasKnockApprove: OnCanvasKnockApprove | null = null;
  onCanvasKnockDecline: OnCanvasKnockDecline | null = null;
  onAclChange: OnAclChange | null = null;
  onCanvasActivity: ((entries: CanvasActivityEntry[], fromNodeId: string) => void) | null = null;
  onPeerConnected: ((peerNodeId: string) => void) | null = null;
  onPeerBecameOnline: ((peerNodeId: string) => void) | null = null;
  onAfterHeartbeatTick: ((friendNodeIds: string[]) => void) | null = null;
  onCanvasUpdate: OnCanvasUpdate | null = null;
  onCanvasDeleted: OnCanvasDeleted | null = null;
  onGossipDigest: ((msg: GossipDigestMessage, fromNodeId: string) => void) | null = null;
  onBlobSeek: ((msg: BlobSeekMessage, fromNodeId: string) => void) | null = null;

  constructor(options: FriendzProtocolOptions) {
    this.localNodeId = options.localNodeId;
    this.localUsername = options.localUsername;
    this.getLocalProfile = options.getLocalProfile;
    this.isFriend = options.isFriend;
    this.profileVisibility = options.profileVisibility ?? "friends";
    this.friendRequestsFrom = options.friendRequestsFrom ?? "everyone";
    this.canvasInvitesFrom = options.canvasInvitesFrom ?? "everyone";
    this.getCanvasActivity = options.getCanvasActivity ?? null;

    this.client = createFriendzClient({
      getNode: options.getMidden,
      localNodeId: options.localNodeId,
      localUsername: options.localUsername,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      onMessage: (msg, fromNodeId) => this.handleWireMessage(msg, fromNodeId),
      onPeerBecameOnline: (nodeId) => {
        // fast presence ack: reply immediately so a newly-online peer
        // learns we're online too, without waiting for the next
        // heartbeat tick (up to HEARTBEAT_INTERVAL_MS later).
        this.sendHeartbeatMessage(nodeId).catch(() => {
          // silent - just a presence ack, not critical.
        });
        this.onPeerBecameOnline?.(nodeId);
      },
      onPeerWentOffline: () => {
        // no dedicated per-peer callback existed for this transition
        // before this protocol swap - `onOnlineChange` subscribers (which
        // FriendzClient already notifies internally) are the only signal
        // this app ever exposed for it.
      },
      onDecodeError: (err, fromNodeId) => {
        log.warn(TAG, "failed to decode message from:", fromNodeId.slice(0, 16) + "...", err);
      },
    });
  }

  // --- incoming stream handling (called by the ALPN router) ---

  handleStream(stream: BiStreamLike): void {
    log.debug(TAG, "incoming stream from:", stream.peer_node_id().slice(0, 16) + "...");
    this.client.handleIncomingStream(stream);
    this.onPeerConnected?.(stream.peer_node_id());
  }

  private async sendHeartbeatMessage(peerNodeId: string): Promise<void> {
    await this.client.sendMessage(peerNodeId, this.buildHeartbeatMessage());
  }

  private buildHeartbeatMessage(): WireMessage {
    const activity = this.getCanvasActivity?.() ?? [];
    return coreMessage({
      type: "heartbeat",
      v: 1,
      nodeId: this.localNodeId,
      username: this.localUsername,
      appPayload: activity.length > 0 ? activity : undefined,
    });
  }

  // --- wire message dispatch ---

  private handleWireMessage(msg: WireMessage, fromNodeId: string): void {
    if (msg.kind === "app-extension") {
      this.handleAppExtension(msg.messageType, msg.payload, fromNodeId);
      return;
    }
    this.handleCoreMessage(msg.message, fromNodeId);
  }

  private handleCoreMessage(msg: CoreMessage, fromNodeId: string): void {
    switch (msg.type) {
      case "profile-request":
        this.handleProfileRequest(fromNodeId);
        break;

      case "profile-response":
        this.onProfileResponse?.(
          {
            type: "profile-response",
            username: msg.username,
            bio: msg.bio,
            avatarDataUrl: msg.avatarDataUrl,
            ...(msg.accentColor !== undefined ? { accentColor: msg.accentColor } : {}),
            ...(msg.profileDocId ? { profileDocId: msg.profileDocId } : {}),
            ...(msg.profileUpdatedAt ? { profileUpdatedAt: msg.profileUpdatedAt } : {}),
          },
          fromNodeId
        );
        break;

      case "friend-request":
        this.handleFriendRequest(msg, fromNodeId);
        break;

      case "friend-accept":
        this.onFriendAccept?.(
          {
            type: "friend-accept",
            fromNodeId: msg.fromNodeId,
            fromUsername: msg.fromUsername,
            ...(msg.isHub !== undefined ? { isHub: msg.isHub } : {}),
          },
          fromNodeId
        );
        break;

      case "friend-reject":
        this.onFriendReject?.({ type: "friend-reject", fromNodeId: msg.fromNodeId }, fromNodeId);
        break;

      case "friend-accept-ack":
        this.onFriendAcceptAck?.(
          { type: "friend-accept-ack", fromNodeId: msg.fromNodeId },
          fromNodeId
        );
        break;

      case "heartbeat": {
        this.onHeartbeat?.(
          { type: "heartbeat", nodeId: msg.nodeId, username: msg.username },
          fromNodeId
        );
        if (Array.isArray(msg.appPayload) && msg.appPayload.length > 0) {
          this.onCanvasActivity?.(msg.appPayload as CanvasActivityEntry[], fromNodeId);
        }
        break;
      }

      case "offline-announcement":
        // FriendzClient already marks the peer offline internally before
        // this handler runs - no app-level callback existed for this
        // transition before this protocol swap either.
        break;

      case "hello":
      case "hello-ok":
        // confirmed no-op for this migration - neither this app's connect
        // flow nor FriendzClient implements a handshake; presence is
        // purely heartbeat-timeout-based on both sides.
        break;

      case "knock-request": {
        if (msg.scope.kind !== "resource") {
          log.warn(TAG, "ignoring knock-request with non-resource scope:", msg.scope.kind);
          break;
        }
        this.onCanvasKnock?.(
          {
            type: "canvas-knock",
            knockId: msg.knockId,
            canvasDocId: msg.scope.resourceId,
            requesterNodeId: msg.nodeId,
            requesterUsername: msg.username ?? "",
            message: msg.message,
          },
          fromNodeId
        );
        break;
      }

      case "knock-ack":
        this.onCanvasKnockAck?.(
          {
            type: "canvas-knock-ack",
            knockId: msg.knockId,
            canvasDocId: msg.resourceId ?? "",
            ackerNodeId: msg.ackerNodeId,
          },
          fromNodeId
        );
        break;

      case "knock-outcome":
        this.handleKnockOutcome(msg, fromNodeId);
        break;

      case "identity-update":
        // not adopted this pass - no consumer needs it yet.
        break;

      case "acl-change":
        this.onAclChange?.(
          {
            type: "acl-change",
            canvasDocId: msg.resourceId,
            canvasTitle: msg.resourceTitle ?? "",
            targetNodeId: msg.targetNodeId,
            // skein never grants "root" - the wire vocabulary's one extra
            // literal haruspex's own callers (not skein) use.
            newRole: (msg.newRole as CanvasRoleOrRemoved | undefined) ?? "removed",
            changedBy: msg.changedBy,
            changedByUsername: msg.changedByUsername,
          },
          fromNodeId
        );
        break;

      case "gossip-digest":
        this.handleGossipDigest(msg, fromNodeId);
        break;

      case "blob-seek":
        this.onBlobSeek?.({ type: "blob-seek", needed: msg.needed }, fromNodeId);
        break;

      case "blob-offer":
        // response to our own blob-seek - browser peers don't currently
        // send blob-seek, so this is a no-op placeholder, same as before
        // this protocol swap.
        log.debug(
          TAG,
          "received blob-offer from:",
          fromNodeId.slice(0, 16) + "...",
          "available:",
          msg.available.length
        );
        break;

      case "error":
        // left unused for this pass - no code path needs it yet.
        break;

      default:
        log.warn(TAG, "unhandled core message type from:", fromNodeId.slice(0, 16) + "...", msg);
    }
  }

  private handleKnockOutcome(
    msg: Extract<CoreMessage, { type: "knock-outcome" }>,
    fromNodeId: string
  ): void {
    if (msg.status === "accepted") {
      this.onCanvasKnockApprove?.(
        {
          type: "canvas-knock-approve",
          knockId: msg.knockId ?? "",
          canvasDocId: msg.grantedResourceIds[0] ?? "",
          approverNodeId: msg.byNodeId ?? fromNodeId,
          role: (msg.grantedRole as InvitableRole) ?? "viewer",
        },
        fromNodeId
      );
      return;
    }
    if (msg.status === "denied") {
      this.onCanvasKnockDecline?.(
        {
          type: "canvas-knock-decline",
          knockId: msg.knockId ?? "",
          canvasDocId: "",
          declinerNodeId: msg.byNodeId ?? fromNodeId,
        },
        fromNodeId
      );
    }
    // "pending" outcomes aren't sent/expected by skein - ignored.
  }

  private handleGossipDigest(
    msg: Extract<CoreMessage, { type: "gossip-digest" }>,
    fromNodeId: string
  ): void {
    const extra =
      msg.appPayload && typeof msg.appPayload === "object" && !Array.isArray(msg.appPayload)
        ? (msg.appPayload as {
            canvasUpdates?: GossipDigestCanvasUpdate[];
            pendingInvites?: GossipDigestPendingInvite[];
            sharedCanvasIds?: string[];
          })
        : {};

    const pendingKnocks: GossipDigestPendingKnock[] = [];
    for (const knock of msg.pendingKnocks ?? []) {
      if (knock.scope.kind !== "resource") continue;
      pendingKnocks.push({
        knockId: knock.knockId,
        canvasDocId: knock.scope.resourceId,
        requesterNodeId: knock.nodeId,
        requesterUsername: knock.username ?? "",
        message: knock.message,
        knockedAt: knock.knockedAt,
      });
    }

    this.onGossipDigest?.(
      {
        type: "gossip-digest",
        canvasUpdates: extra.canvasUpdates ?? [],
        pendingInvites: extra.pendingInvites ?? [],
        pendingKnocks,
        ...(extra.sharedCanvasIds ? { sharedCanvasIds: extra.sharedCanvasIds } : {}),
        ...(msg.profiles && msg.profiles.length > 0 ? { profiles: msg.profiles } : {}),
      },
      fromNodeId
    );
  }

  private handleAppExtension(
    messageType: string,
    payload: Record<string, unknown>,
    fromNodeId: string
  ): void {
    switch (messageType) {
      case "skein:canvas-invite":
        this.handleCanvasInvite(payload as unknown as CanvasInviteMessage, fromNodeId);
        break;
      case "skein:canvas-invite-ack":
        this.onCanvasInviteAck?.(payload as unknown as CanvasInviteAckMessage, fromNodeId);
        break;
      case "skein:canvas-invite-accept":
        this.onCanvasInviteAccept?.(payload as unknown as CanvasInviteAcceptMessage, fromNodeId);
        break;
      case "skein:canvas-invite-decline":
        this.onCanvasInviteDecline?.(payload as unknown as CanvasInviteDeclineMessage, fromNodeId);
        break;
      case "skein:canvas-update":
        this.onCanvasUpdate?.(payload as unknown as CanvasUpdateMessage, fromNodeId);
        break;
      case "skein:canvas-deleted":
        this.onCanvasDeleted?.(payload as unknown as CanvasDeletedMessage, fromNodeId);
        break;
      default:
        log.debug(TAG, "ignoring unknown app-extension type:", messageType);
    }
  }

  private handleProfileRequest(fromNodeId: string): void {
    if (this.profileVisibility === "nobody") return;
    if (this.profileVisibility === "friends" && !this.isFriend(fromNodeId)) {
      log.debug(TAG, "ignoring profile request from non-friend:", fromNodeId.slice(0, 16) + "...");
      return;
    }

    const profile = this.getLocalProfile();
    const response = coreMessage({
      type: "profile-response",
      v: 1,
      username: profile.username,
      bio: profile.bio,
      avatarDataUrl: profile.avatarDataUrl,
      ...(profile.accentColor !== undefined ? { accentColor: profile.accentColor } : {}),
      ...(profile.profileDocId ? { profileDocId: profile.profileDocId } : {}),
      ...(profile.profileUpdatedAt ? { profileUpdatedAt: profile.profileUpdatedAt } : {}),
    });
    this.client.sendMessage(fromNodeId, response).catch((err) => {
      log.warn(TAG, "failed to send profile response:", err);
    });
  }

  private handleFriendRequest(
    msg: Extract<CoreMessage, { type: "friend-request" }>,
    fromNodeId: string
  ): void {
    if (this.friendRequestsFrom === "nobody") return;
    this.onFriendRequest?.(
      {
        type: "friend-request",
        fromNodeId: msg.fromNodeId,
        fromUsername: msg.fromUsername,
        ...(msg.isHub !== undefined ? { isHub: msg.isHub } : {}),
      },
      fromNodeId
    );
  }

  private handleCanvasInvite(msg: CanvasInviteMessage, fromNodeId: string): void {
    if (this.canvasInvitesFrom === "nobody") return;
    if (this.canvasInvitesFrom === "friends" && !this.isFriend(fromNodeId)) {
      log.debug(TAG, "ignoring canvas invite from non-friend:", fromNodeId.slice(0, 16) + "...");
      return;
    }
    this.onCanvasInvite?.(msg, fromNodeId);
  }

  // --- outbound protocol actions ---

  async sendFriendRequest(peerNodeId: string): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({
        type: "friend-request",
        v: 1,
        fromNodeId: this.localNodeId,
        fromUsername: this.localUsername,
      })
    );
  }

  async sendFriendAccept(peerNodeId: string): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({
        type: "friend-accept",
        v: 1,
        fromNodeId: this.localNodeId,
        fromUsername: this.localUsername,
      })
    );
  }

  async sendFriendReject(peerNodeId: string): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({ type: "friend-reject", v: 1, fromNodeId: this.localNodeId })
    );
  }

  async requestProfile(peerNodeId: string): Promise<void> {
    await this.client.sendMessage(peerNodeId, coreMessage({ type: "profile-request", v: 1 }));
  }

  /** send a friend-accept-ack to complete the two-phase handshake. */
  async sendFriendAcceptAck(peerNodeId: string): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({ type: "friend-accept-ack", v: 1, fromNodeId: this.localNodeId })
    );
  }

  async sendCanvasInvite(
    peerNodeId: string,
    invite: Omit<CanvasInviteMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      extensionMessage("skein:canvas-invite", { type: "skein:canvas-invite", v: 1, ...invite })
    );
  }

  async sendCanvasInviteAck(
    peerNodeId: string,
    ack: Omit<CanvasInviteAckMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      extensionMessage("skein:canvas-invite-ack", {
        type: "skein:canvas-invite-ack",
        v: 1,
        ...ack,
      })
    );
  }

  async sendCanvasInviteAccept(
    peerNodeId: string,
    accept: Omit<CanvasInviteAcceptMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      extensionMessage("skein:canvas-invite-accept", {
        type: "skein:canvas-invite-accept",
        v: 1,
        ...accept,
      })
    );
  }

  async sendCanvasInviteDecline(
    peerNodeId: string,
    decline: Omit<CanvasInviteDeclineMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      extensionMessage("skein:canvas-invite-decline", {
        type: "skein:canvas-invite-decline",
        v: 1,
        ...decline,
      })
    );
  }

  /** send a canvas knock to a peer - translated to `knock-request`,
   *  `canvasDocId` becoming `scope: { kind: "resource", resourceId }`.
   *  only actually invoked from the dev p2p test harness today - no
   *  production caller sends its own knock through this class (see the
   *  E3 migration report for how this was confirmed). */
  async sendCanvasKnock(peerNodeId: string, knock: Omit<CanvasKnockMessage, "type">): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({
        type: "knock-request",
        v: 1,
        knockId: knock.knockId,
        nodeId: knock.requesterNodeId,
        username: knock.requesterUsername,
        message: knock.message,
        scope: { kind: "resource", resourceId: knock.canvasDocId },
      })
    );
  }

  async sendCanvasKnockAck(
    peerNodeId: string,
    ack: Omit<CanvasKnockAckMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({
        type: "knock-ack",
        v: 1,
        knockId: ack.knockId,
        ackerNodeId: ack.ackerNodeId,
        resourceId: ack.canvasDocId,
      })
    );
  }

  /** approve a canvas knock - translated to `knock-outcome` with
   *  `status: "accepted"`; `canvasDocId` travels as the sole entry in
   *  `grantedResourceIds` (the wire message has no dedicated field for
   *  it). */
  async sendCanvasKnockApprove(
    peerNodeId: string,
    approve: Omit<CanvasKnockApproveMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({
        type: "knock-outcome",
        v: 1,
        knockId: approve.knockId,
        status: "accepted",
        grantedRole: approve.role as WireRole,
        grantedResourceIds: [approve.canvasDocId],
        byNodeId: approve.approverNodeId,
      })
    );
  }

  /** decline a canvas knock - translated to `knock-outcome` with
   *  `status: "denied"`. `canvasDocId` is dropped (not carried by a
   *  denial on the wire) - the receiver correlates by `knockId` alone. */
  async sendCanvasKnockDecline(
    peerNodeId: string,
    decline: Omit<CanvasKnockDeclineMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({
        type: "knock-outcome",
        v: 1,
        knockId: decline.knockId,
        status: "denied",
        grantedResourceIds: [],
        byNodeId: decline.declinerNodeId,
      })
    );
  }

  /** notify a peer their acl role changed - translated to `acl-change`;
   *  `newRole: "removed"` is sent as an absent `newRole` field. */
  async sendAclChange(peerNodeId: string, change: Omit<AclChangeMessage, "type">): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({
        type: "acl-change",
        v: 1,
        resourceId: change.canvasDocId,
        resourceTitle: change.canvasTitle,
        targetNodeId: change.targetNodeId,
        ...(change.newRole !== "removed" ? { newRole: change.newRole } : {}),
        changedBy: change.changedBy,
        changedByUsername: change.changedByUsername,
      })
    );
  }

  async sendCanvasUpdate(
    peerNodeId: string,
    update: Omit<CanvasUpdateMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      extensionMessage("skein:canvas-update", { type: "skein:canvas-update", v: 1, ...update })
    );
  }

  async sendCanvasDeleted(
    peerNodeId: string,
    deleted: Omit<CanvasDeletedMessage, "type">
  ): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      extensionMessage("skein:canvas-deleted", { type: "skein:canvas-deleted", v: 1, ...deleted })
    );
  }

  /** send a gossip digest - `canvasUpdates`/`pendingInvites`/
   *  `sharedCanvasIds` ride in the wire message's generic `appPayload`
   *  field (omitted entirely when there's nothing to say); `pendingKnocks`
   *  entries are translated to the shared protocol's `knockId`/`scope`
   *  shape. */
  async sendGossipDigest(
    peerNodeId: string,
    digest: Omit<GossipDigestMessage, "type">
  ): Promise<void> {
    const appPayload =
      digest.canvasUpdates.length > 0 ||
      digest.pendingInvites.length > 0 ||
      (digest.sharedCanvasIds?.length ?? 0) > 0
        ? {
            canvasUpdates: digest.canvasUpdates,
            pendingInvites: digest.pendingInvites,
            sharedCanvasIds: digest.sharedCanvasIds ?? [],
          }
        : undefined;

    const pendingKnocks = digest.pendingKnocks.map((knock) => ({
      knockId: knock.knockId,
      nodeId: knock.requesterNodeId,
      username: knock.requesterUsername,
      message: knock.message,
      scope: { kind: "resource" as const, resourceId: knock.canvasDocId },
      knockedAt: knock.knockedAt,
    }));

    await this.client.sendMessage(
      peerNodeId,
      coreMessage({
        type: "gossip-digest",
        v: 1,
        pendingKnocks,
        profiles: digest.profiles ?? [],
        appPayload,
      })
    );
  }

  /** send a blob-offer response to a peer's blob-seek query. */
  async sendBlobOffer(peerNodeId: string, offer: Omit<BlobOfferMessage, "type">): Promise<void> {
    await this.client.sendMessage(
      peerNodeId,
      coreMessage({ type: "blob-offer", v: 1, available: offer.available })
    );
  }

  // --- heartbeat ---
  //
  // FriendzClient owns presence bookkeeping (isOnline/getOnlinePeers,
  // marking peers online/offline from received heartbeat/offline-
  // announcement messages) - this class layers its own send-scheduling on
  // top (initial announce round, onAfterHeartbeatTick, discovery sweep)
  // rather than using the client's own startHeartbeat(), since that hook
  // has no equivalent for those two callbacks.

  /**
   * start the periodic heartbeat to all connected friend peers.
   * call this after the protocol handler is set up and friends are loaded.
   */
  startHeartbeat(getFriendNodeIds: () => string[]): void {
    this.stopHeartbeat();
    this.getFriendNodeIds = getFriendNodeIds;

    // initial announce round: send to ALL friends so online peers can reply.
    const allFriends = getFriendNodeIds();
    const msg = this.buildHeartbeatMessage();
    for (const peerId of allFriends) {
      this.client.sendMessage(peerId, msg).catch((err) => {
        log.warn(TAG, "initial announce failed for:", peerId.slice(0, 16) + "...", err);
      });
    }
    this.onAfterHeartbeatTick?.(allFriends);

    // regular heartbeat: send only to online peers.
    const sendHeartbeats = async () => {
      const hbMsg = this.buildHeartbeatMessage();
      const onlinePeers = this.client.getOnlinePeers();
      for (const peerId of onlinePeers) {
        this.client.sendMessage(peerId, hbMsg).catch((err) => {
          log.warn(TAG, "heartbeat failed for:", peerId.slice(0, 16) + "...", err);
        });
      }
      this.onAfterHeartbeatTick?.(getFriendNodeIds());
    };

    this.heartbeatTimer = setInterval(() => {
      void sendHeartbeats();
    }, HEARTBEAT_INTERVAL_MS);

    // discovery sweep: periodically probe offline friends.
    this.discoveryTimer = setInterval(() => {
      const friends = this.getFriendNodeIds?.() ?? [];
      const sweepMsg = this.buildHeartbeatMessage();
      for (const peerId of friends) {
        if (this.client.isOnline(peerId)) continue; // skip already-online
        this.client.sendMessage(peerId, sweepMsg).catch(() => {
          // silent - they're probably offline
        });
      }
    }, DISCOVERY_SWEEP_MS);
  }

  /** send a one-shot heartbeat to a single peer (e.g. when viewing their
   *  profile or sharing a canvas). */
  async probePeer(nodeId: string): Promise<void> {
    await this.sendHeartbeatMessage(nodeId);
  }

  /** announce to all online peers that we're going offline. fire-and-forget. */
  announceOffline(): void {
    this.client.announceOffline();
  }

  /** stop the heartbeat interval. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  // --- online/offline status ---

  /**
   * check if a friend peer is considered online based on heartbeat.
   * a peer is online if we received a heartbeat within the timeout window.
   */
  isOnline(nodeId: string): boolean {
    return this.client.isOnline(nodeId);
  }

  /**
   * get all peer node IDs that are currently considered online.
   */
  getOnlinePeers(): string[] {
    return this.client.getOnlinePeers();
  }

  /**
   * subscribe to online/offline state changes.
   * returns an unsubscribe function.
   */
  onOnlineChange(handler: () => void): () => void {
    return this.client.onOnlineChange(handler);
  }

  /** get the current local username. */
  getLocalUsername(): string {
    return this.localUsername;
  }

  /** update the local username (e.g. when profile changes). */
  setLocalUsername(username: string): void {
    this.localUsername = username;
  }

  /** update the local node ID (e.g. after identity creation). */
  setLocalNodeId(nodeId: string): void {
    this.localNodeId = nodeId;
  }

  /** update privacy settings. */
  setProfileVisibility(visibility: "friends" | "everyone" | "nobody"): void {
    this.profileVisibility = visibility;
  }

  /** update privacy settings. */
  setFriendRequestsFrom(from: "everyone" | "nobody"): void {
    this.friendRequestsFrom = from;
  }

  /** update canvas invite privacy settings. */
  setCanvasInvitesFrom(from: "everyone" | "friends" | "nobody"): void {
    this.canvasInvitesFrom = from;
  }

  /**
   * clean up the transport, timers, and event handler references.
   */
  destroy(): void {
    this.stopHeartbeat();
    this.client.destroy();
    this.getFriendNodeIds = null;
    this.onFriendRequest = null;
    this.onFriendAccept = null;
    this.onFriendReject = null;
    this.onProfileResponse = null;
    this.onHeartbeat = null;
    this.onFriendAcceptAck = null;
    this.onCanvasInvite = null;
    this.onCanvasInviteAck = null;
    this.onCanvasInviteAccept = null;
    this.onCanvasInviteDecline = null;
    this.onCanvasKnock = null;
    this.onCanvasKnockAck = null;
    this.onCanvasKnockApprove = null;
    this.onCanvasKnockDecline = null;
    this.onAclChange = null;
    this.onCanvasActivity = null;
    this.onPeerConnected = null;
    this.onPeerBecameOnline = null;
    this.onAfterHeartbeatTick = null;
    this.onCanvasUpdate = null;
    this.onCanvasDeleted = null;
    this.onGossipDigest = null;
    this.onBlobSeek = null;
  }
}

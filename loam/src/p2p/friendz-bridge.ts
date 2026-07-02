// ---------------------------------------------------------------------------
// friendz bridge — module-level singleton for widget ↔ protocol communication
//
// the friends widget (and other UI) can't directly access the FriendzProtocol
// instance created in boot.ts. this bridge module holds a reference to the
// protocol and exposes functions that widgets can import. follows the same
// pattern as identity.ts (module-level state with exported accessors).
//
// lifecycle:
//   1. boot.ts creates FriendzProtocol and calls initBridge(protocol)
//   2. widgets import isOnline(), sendFriendRequest(), etc.
//   3. boot.ts calls destroyBridge() on teardown
// ---------------------------------------------------------------------------

import type { FriendzProtocol } from "./friends-protocol";
import type { CanvasRoleOrRemoved, InvitableRole } from "../canvas/canvas-doc";
import type { SocialDoc } from "../../widgets/narthex/social/types";

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

let protocol: FriendzProtocol | null = null;
let bridgeReadyListeners: Array<() => void> = [];
let outboundRequestHook: ((toNodeId: string) => void) | null = null;

// ---------------------------------------------------------------------------
// knock (access-request) bridge state — docs/knock-and-hub-relay-plan.md
// section 7.2/7.3. `approveKnock()`/`declineKnock()` (friendz-wiring.ts) need
// a `SocialDoc` alongside the protocol, which this bridge doesn't otherwise
// hold — `initKnockSocialDocBridge()` lets boot.ts register it once the
// social doc is ready, same lifecycle as `initBridge()` above.
// ---------------------------------------------------------------------------

let knockSocialDoc: SocialDoc | null = null;

export interface KnockAckInfo {
  knockId: string;
  canvasDocId: string;
  ackerNodeId: string;
}

export interface KnockRelayAttribution {
  canvasDocId: string;
  requesterNodeId: string;
  relayedBy: string;
}

/**
 * live-session-only knock relay attribution, keyed by `canvasDocId:requesterNodeId`.
 * `PendingCanvasKnock` (canvas-doc.ts) deliberately has no persisted
 * `relayedBy` field (see its doc comment) — this is the "good enough for a
 * future hub-relay UI" stand-in the plan doc anticipated: populated live by
 * re-invoking `wireKnockHandlers()`'s `onKnockRelayed` callback (see
 * boot.ts's `initFriendzProtocol()`), lost on reload.
 */
const knockRelayInfo = new Map<string, KnockRelayAttribution>();
let knockRelayListeners: Array<(info: KnockRelayAttribution) => void> = [];

/** canvas doc ids for which a `canvas-knock-ack` has been observed this
 *  session (requester's side) — see `onKnockAcked()`/`hasKnockAckForCanvas()`. */
const knockAckedCanvasIds = new Set<string>();
let knockAckListeners: Array<(info: KnockAckInfo) => void> = [];

function knockRelayKey(canvasDocId: string, requesterNodeId: string): string {
  return `${canvasDocId}:${requesterNodeId}`;
}

// ---------------------------------------------------------------------------
// initialization (called by boot.ts)
// ---------------------------------------------------------------------------

/**
 * set the active FriendzProtocol instance. called once from boot.ts
 * after the protocol is created and wired up. triggers any pending
 * "bridge ready" listeners.
 */
export function initBridge(p: FriendzProtocol): void {
  protocol = p;
  // notify anyone waiting for the bridge to be ready
  for (const listener of bridgeReadyListeners) {
    listener();
  }
  bridgeReadyListeners = [];
}

/**
 * tear down the bridge. called from boot.ts on disconnect/destroy.
 */
export function destroyBridge(): void {
  protocol = null;
  bridgeReadyListeners = [];
  outboundRequestHook = null;
  acceptAndJoinHandler = null;
  knockSocialDoc = null;
  knockRelayInfo.clear();
  knockRelayListeners = [];
  knockAckedCanvasIds.clear();
  knockAckListeners = [];
}

// ---------------------------------------------------------------------------
// state queries (safe to call before bridge is ready — return defaults)
// ---------------------------------------------------------------------------

/** whether the bridge has an active protocol instance. */
export function isProtocolReady(): boolean {
  return protocol !== null;
}

/**
 * check if a friend peer is considered online (heartbeat within timeout).
 * returns false if the bridge isn't ready or the peer is unknown.
 */
export function isOnline(nodeId: string): boolean {
  return protocol?.isOnline(nodeId) ?? false;
}

/**
 * get all peer node IDs currently considered online.
 * returns empty array if the bridge isn't ready.
 */
export function getOnlinePeers(): string[] {
  return protocol?.getOnlinePeers() ?? [];
}

/**
 * subscribe to online/offline state changes.
 * if the bridge isn't ready yet, the handler will be registered once it is.
 * returns an unsubscribe function.
 */
export function onOnlineChange(handler: () => void): () => void {
  if (protocol) {
    return protocol.onOnlineChange(handler);
  }

  // bridge not ready yet — defer registration
  let unsub: (() => void) | null = null;
  let cancelled = false;

  const readyListener = () => {
    if (cancelled || !protocol) return;
    unsub = protocol.onOnlineChange(handler);
  };
  bridgeReadyListeners.push(readyListener);

  return () => {
    cancelled = true;
    if (unsub) unsub();
    // remove from pending listeners if not yet fired
    const idx = bridgeReadyListeners.indexOf(readyListener);
    if (idx !== -1) bridgeReadyListeners.splice(idx, 1);
  };
}

/**
 * subscribe to be notified when the bridge becomes ready.
 * if already ready, the handler fires synchronously.
 * returns an unsubscribe function.
 */
export function onBridgeReady(handler: () => void): () => void {
  if (protocol) {
    handler();
    return () => {};
  }

  bridgeReadyListeners.push(handler);
  return () => {
    const idx = bridgeReadyListeners.indexOf(handler);
    if (idx !== -1) bridgeReadyListeners.splice(idx, 1);
  };
}

// ---------------------------------------------------------------------------
// outbound actions (require bridge to be ready)
// ---------------------------------------------------------------------------

/**
 * send a friend request to a peer.
 * throws if the bridge isn't ready.
 */
export async function sendFriendRequest(peerNodeId: string): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  await protocol.sendFriendRequest(peerNodeId);
  outboundRequestHook?.(peerNodeId);
}

/**
 * register a callback that fires whenever an outbound friend request is sent.
 * boot.ts uses this to track outbound requests in the friends doc.
 * call with null to unregister.
 */
export function setOutboundRequestHook(hook: ((toNodeId: string) => void) | null): void {
  outboundRequestHook = hook;
}

/**
 * accept an incoming friend request.
 * sends an accept message to the remote peer via the protocol.
 * the caller is responsible for updating the local friends doc
 * (moving the request to "accepted" and adding the friend entry).
 */
export async function acceptFriendRequest(fromNodeId: string): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  return protocol.sendFriendAccept(fromNodeId);
}

/**
 * reject an incoming friend request.
 * sends a reject message to the remote peer via the protocol.
 * the caller is responsible for updating the local friends doc
 * (moving the request to "rejected").
 */
export async function rejectFriendRequest(fromNodeId: string): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  return protocol.sendFriendReject(fromNodeId);
}

/**
 * request a peer's profile (username, bio, avatar).
 * the response will arrive via the protocol's onProfileResponse callback,
 * which boot.ts wires to write into the friends doc.
 */
export async function requestProfile(peerNodeId: string): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  return protocol.requestProfile(peerNodeId);
}

// ---------------------------------------------------------------------------
// canvas invite actions (require bridge to be ready)
// ---------------------------------------------------------------------------

/**
 * send a canvas invite to a peer.
 * the invite includes gossip fields (targets, acked) for relay.
 */
export async function sendCanvasInvite(
  peerNodeId: string,
  invite: {
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
): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  await protocol.sendCanvasInvite(peerNodeId, invite);
}

/**
 * acknowledge receipt of a canvas invite.
 */
export async function sendCanvasInviteAck(
  peerNodeId: string,
  ack: { inviteId: string; canvasDocId: string; ackerNodeId: string }
): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  await protocol.sendCanvasInviteAck(peerNodeId, ack);
}

/**
 * accept a canvas invite.
 */
export async function sendCanvasInviteAccept(
  peerNodeId: string,
  accept: { inviteId: string; canvasDocId: string; accepterNodeId: string }
): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  await protocol.sendCanvasInviteAccept(peerNodeId, accept);
}

/**
 * decline a canvas invite.
 */
export async function sendCanvasInviteDecline(
  peerNodeId: string,
  decline: { inviteId: string; canvasDocId: string; declinerNodeId: string }
): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  await protocol.sendCanvasInviteDecline(peerNodeId, decline);
}

/**
 * send an ACL change notification to a peer.
 */
export async function sendAclChange(
  peerNodeId: string,
  change: {
    canvasDocId: string;
    canvasTitle: string;
    targetNodeId: string;
    newRole: CanvasRoleOrRemoved;
    changedBy: string;
    changedByUsername: string;
  }
): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  await protocol.sendAclChange(peerNodeId, change);
}

/**
 * send a canvas-deleted notification to a peer.
 * called when the local user deletes a canvas they own.
 */
export async function sendCanvasDeleted(
  peerNodeId: string,
  deleted: {
    canvasDocId: string;
    canvasTitle: string;
    deletedBy: string;
    deletedByUsername: string;
    deleteMode: "soft" | "purge";
    deletedAt: string;
  }
): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  await protocol.sendCanvasDeleted(peerNodeId, deleted);
}

/**
 * send a friend-accept-ack to confirm receipt of a friend accept.
 */
export async function sendFriendAcceptAck(peerNodeId: string): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  await protocol.sendFriendAcceptAck(peerNodeId);
}

// ---------------------------------------------------------------------------
// knock (access-request) actions — docs/knock-and-hub-relay-plan.md
// ---------------------------------------------------------------------------

/**
 * the raw `FriendzProtocol` instance, for callers (the messagez widget's
 * knock row) that need to invoke `approveKnock()`/`declineKnock()`
 * (friendz-wiring.ts) directly — those take a `protocol` dependency this
 * bridge already holds but doesn't otherwise expose.
 */
export function getProtocol(): FriendzProtocol | null {
  return protocol;
}

/** register the social doc so `approveKnock()` can be called from a widget.
 *  called once boot.ts's social doc is ready — mirrors `initBridge()`'s
 *  lifecycle. pass `null` on teardown. */
export function initKnockSocialDocBridge(doc: SocialDoc | null): void {
  knockSocialDoc = doc;
}

/** the social doc registered via `initKnockSocialDocBridge()`, or null if
 *  not ready yet. */
export function getKnockSocialDoc(): SocialDoc | null {
  return knockSocialDoc;
}

/** record that `info.requesterNodeId`'s knock (on `info.canvasDocId`) was
 *  relayed to us via `info.relayedBy` this session. see `knockRelayInfo`'s
 *  doc comment for why this isn't persisted.
 *
 *  notifies subscribers (see `onKnockRelayed()`) so a currently-rendered
 *  knock row can refresh its "via hub"/"relayed" attribution immediately —
 *  this is called from `wireKnockHandlers()`'s `onCanvasKnock` handler
 *  *after* `store.recordKnock()` has already fired its own doc-change
 *  render, so without this notification the row would render once with no
 *  attribution and never update again until some unrelated change happened
 *  to redraw it. */
export function recordKnockRelay(info: KnockRelayAttribution): void {
  knockRelayInfo.set(knockRelayKey(info.canvasDocId, info.requesterNodeId), info);
  for (const listener of knockRelayListeners) listener(info);
}

/** the node id that relayed a knock to us this session, or `""` if we have
 *  no live relay attribution for it (either it arrived directly, or it was
 *  already pending before this session started — see `knockRelayInfo`'s
 *  doc comment). */
export function getKnockRelayedBy(canvasDocId: string, requesterNodeId: string): string {
  return knockRelayInfo.get(knockRelayKey(canvasDocId, requesterNodeId))?.relayedBy ?? "";
}

/** subscribe to live knock-relay-attribution events (see `recordKnockRelay()`).
 *  returns an unsubscribe function. */
export function onKnockRelayed(handler: (info: KnockRelayAttribution) => void): () => void {
  knockRelayListeners.push(handler);
  return () => {
    knockRelayListeners = knockRelayListeners.filter((h) => h !== handler);
  };
}

/** record a `canvas-knock-ack` observed this session (requester's side) and
 *  notify subscribers — see `onKnockAcked()`. */
export function recordKnockAck(info: KnockAckInfo): void {
  knockAckedCanvasIds.add(info.canvasDocId);
  for (const listener of knockAckListeners) listener(info);
}

/** subscribe to knock-ack events (requester's side, section 7.1's status
 *  view). returns an unsubscribe function. */
export function onKnockAcked(handler: (info: KnockAckInfo) => void): () => void {
  knockAckListeners.push(handler);
  return () => {
    knockAckListeners = knockAckListeners.filter((h) => h !== handler);
  };
}

/** true if a knock-ack for `canvasDocId` has been observed this session.
 *  session-only (see `knockAckedCanvasIds`'s doc comment) — persisting this
 *  across a reload (so the requester's "request received, waiting for a
 *  response" status, section 7.1, survives a page reload) is out of scope
 *  for this pass. */
export function hasKnockAckForCanvas(canvasDocId: string): boolean {
  return knockAckedCanvasIds.has(canvasDocId);
}

// ---------------------------------------------------------------------------
// privacy setting updates
// ---------------------------------------------------------------------------

/**
 * update the profile visibility setting on the protocol.
 * called when the user changes the setting in the friends widget.
 */
export function setProfileVisibility(visibility: "friends" | "everyone" | "nobody"): void {
  protocol?.setProfileVisibility(visibility);
}

/**
 * update the friend requests setting on the protocol.
 * called when the user changes the setting in the friends widget.
 */
export function setFriendRequestsFrom(from: "everyone" | "nobody"): void {
  protocol?.setFriendRequestsFrom(from);
}

/**
 * update the canvas invites privacy setting on the protocol.
 * called when the user changes the setting in the inbox widget.
 */
export function setCanvasInvitesFrom(from: "everyone" | "friends" | "nobody"): void {
  protocol?.setCanvasInvitesFrom(from);
}

// ---------------------------------------------------------------------------
// canvas accept-and-join action (wired by boot.ts)
// ---------------------------------------------------------------------------

let acceptAndJoinHandler:
  | ((detail: {
      canvasDocId: string;
      fromNodeId: string;
      canvasTitle: string;
      canvasDescription: string;
      canvasColor: number;
      canvasPreviewUrl: string;
      fromUsername: string;
    }) => Promise<void>)
  | null = null;

export function setAcceptAndJoinHandler(handler: typeof acceptAndJoinHandler): void {
  acceptAndJoinHandler = handler;
}

export async function acceptAndJoinCanvas(detail: {
  canvasDocId: string;
  fromNodeId: string;
  canvasTitle: string;
  canvasDescription: string;
  canvasColor: number;
  canvasPreviewUrl: string;
  fromUsername: string;
}): Promise<void> {
  if (!acceptAndJoinHandler) throw new Error("accept-and-join handler not registered");
  return acceptAndJoinHandler(detail);
}

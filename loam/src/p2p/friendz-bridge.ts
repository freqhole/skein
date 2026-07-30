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
import { getMiddenNode } from "./identity";
import { isTauriMode, TauriStreamNode } from "./tauri-transport";
import type { HubAdminTransport } from "./hub-admin-client";
import type { MiddenStreamNode } from "./iroh-network-adapter";

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

let protocol: FriendzProtocol | null = null;
let bridgeReadyListeners: Array<() => void> = [];
let outboundRequestHook: ((toNodeId: string, hintUsername?: string) => void) | null = null;
let gossipNowHook: (() => void) | null = null;

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

export interface HubAckInfo {
  canvasDocId: string;
  hubNodeId: string;
}

/** canvas doc ids for which a hub-side ack has been observed — a
 *  `friend-accept` arriving from a nodeId listed in that canvas's pending
 *  access-request `hubNodeIds` (see `requestCanvasAccess()`'s doc comment,
 *  boot.ts, for why a hub friend-accept is treated as an ack at all: the
 *  hub's vouched-based auto-accept means this only fires once the hub has
 *  actually put the requester on its friends-only gossip network, which is
 *  the thing that makes onward relay to the canvas owner possible). backed
 *  by the persisted `accessRequests[].hubAcked` field (messagez doc) —
 *  boot.ts backfills this set from that field at startup, so it also
 *  reflects acks observed in a previous session, unlike `knockAckedCanvasIds`
 *  above. */
const hubAckedCanvasIds = new Set<string>();
let hubAckListeners: Array<(info: HubAckInfo) => void> = [];

/** canvas doc ids whose access-request "resend" action has already been
 *  used once this session — a deliberately lightweight, session-only spam
 *  guard (see `markManuallyRetried()`/`wasManuallyRetried()`): disabled
 *  until the next full page reload, at which point the user can try again.
 *  automatic retry-on-peer-online (`onPeerBecameOnline`, friendz-wiring.ts)
 *  is unrelated to this and keeps working regardless. */
const manuallyRetriedCanvasIds = new Set<string>();

/** node ids known to be canvas-sharing hubs — populated whenever a share
 *  link or canvas-card carries `hubNodeIds` (see `canvas-card.ts`,
 *  `boot.ts`'s `joinCanvasFromNarthex()`/`requestCanvasAccess()`). used
 *  purely for a "(hub)" label on an outgoing friend request in the friends
 *  tab (`friends-tab.ts`) — session-only, not persisted. */
const knownHubNodeIds = new Set<string>();

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
  gossipNowHook = null;
  acceptAndJoinHandler = null;
  knockSocialDoc = null;
  unsubscribeFriendsChange?.();
  unsubscribeFriendsChange = null;
  knockRelayInfo.clear();
  knockRelayListeners = [];
  knockAckedCanvasIds.clear();
  knockAckListeners = [];
  hubAckedCanvasIds.clear();
  hubAckListeners = [];
  manuallyRetriedCanvasIds.clear();
  knownHubNodeIds.clear();
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
 *
 * `hintUsername`, when given, seeds the outbound-request placeholder's
 * display name (see the hook body in friendz-wiring.ts) so a fresh request
 * doesn't show as a bare/"unknown" name until the recipient's own profile
 * info comes back - e.g. requestCanvasAccess() in boot.ts passes the
 * canvas owner's username straight from the narthex card (itself
 * populated from the share link's embedded `ownerUsername`, see
 * share-string.ts) when asking to friend a canvas owner it just knocked.
 */
export async function sendFriendRequest(peerNodeId: string, hintUsername?: string): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");

  // mark the outbound request as pending, and kick off a gossip-relay
  // attempt if the peer isn't known-online, BEFORE attempting the direct
  // wire send below - a peer we've never exchanged a heartbeat with (the
  // common case for a brand-new node id) has no open stream yet, so
  // `protocol.sendFriendRequest()` has to dial them first. against a
  // genuinely offline peer that dial can take a long time to time out (or
  // reject outright with no discovery path), and the caller (friends-tab.ts)
  // treats this as fire-and-forget, only logging a warning on failure -
  // if the pending-state hook only fired on success, an offline target
  // would never get marked pending and would have nothing for gossip
  // relay to carry, defeating the entire point of that feature.
  outboundRequestHook?.(peerNodeId, hintUsername);
  if (!isOnline(peerNodeId)) {
    gossipFriendRequestsNow();
  }

  await protocol.sendFriendRequest(peerNodeId);
}

/**
 * register a callback that fires whenever an outbound friend request is sent.
 * boot.ts uses this to track outbound requests in the friends doc.
 * call with null to unregister.
 */
export function setOutboundRequestHook(
  hook: ((toNodeId: string, hintUsername?: string) => void) | null
): void {
  outboundRequestHook = hook;
}

/**
 * register a callback that, when invoked, asks every currently-online friend
 * for a fresh gossip digest right now (rather than waiting for one of them
 * to transition online). friendz-wiring.ts registers this since it's the
 * one holding the heavy iroh/canvas-store dependencies; this bridge just
 * forwards the call. call with null to unregister.
 */
export function setGossipNowHook(hook: (() => void) | null): void {
  gossipNowHook = hook;
}

/**
 * ask every currently-online friend to relay gossip right now - used after
 * sending a friend request to an offline-looking peer, and when opening the
 * profile of a friend who hasn't accepted our request yet. no-op if the
 * bridge or the hook isn't ready.
 */
export function gossipFriendRequestsNow(): void {
  gossipNowHook?.();
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

/** how long a friend-request outcome keeps getting gossiped back toward
 *  the original requester before relay holders give up on it - mirrors
 *  friendz-wiring.ts's FRIEND_REQUEST_TTL_DAYS (kept as a small local
 *  constant here rather than a shared import, to avoid pulling
 *  friendz-wiring.ts's much heavier dependency graph into widget bundles
 *  that only need this one pure helper). */
const FRIEND_REQUEST_TTL_DAYS = 60;

function addDays(iso: string, days: number): string {
  const base = iso ? new Date(iso).getTime() : Date.now();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * record that the local user accepted or rejected a pending friend
 * request, so the outcome can gossip-relay back to the requester if
 * they're offline right now. call this from wherever the accept/reject
 * decision is actually made (e.g. requests-tab.ts's button handlers)
 * alongside sending the direct `friend-accept`/`friend-reject` message -
 * this only records the relay-outcome side, it does not send anything
 * itself. friendz-wiring.ts's onGossipDigest/computeAndSendGossipDigest is
 * what actually reads and re-gossips the resulting doc entries.
 */
export function recordFriendRequestOutcome(
  sDoc: SocialDoc,
  params: {
    fromNodeId: string;
    resolverNodeId: string;
    outcome: "accepted" | "rejected";
    resolverUsername?: string;
    resolverBio?: string;
    resolverAvatarDataUrl?: string;
    resolverAccentColor?: number;
    /** carried from the resolved pendingRequests entry's own `expiresAt`
     *  when known, so every relay hop agrees on the same deadline - falls
     *  back to `now + 60 days` when the original request predates this
     *  field (or arrived before this feature existed). */
    expiresAt?: string;
  }
): void {
  const resolvedAt = new Date().toISOString();
  sDoc.change((draft: any) => {
    if (!draft.relayedFriendRequestOutcomes) draft.relayedFriendRequestOutcomes = [];
    const idx = draft.relayedFriendRequestOutcomes.findIndex(
      (o: any) => o.fromNodeId === params.fromNodeId && o.resolverNodeId === params.resolverNodeId
    );
    const entry = {
      fromNodeId: params.fromNodeId,
      resolverNodeId: params.resolverNodeId,
      outcome: params.outcome,
      resolverUsername: params.resolverUsername ?? "",
      resolverBio: params.resolverBio ?? "",
      resolverAvatarDataUrl: params.resolverAvatarDataUrl ?? "",
      ...(params.resolverAccentColor !== undefined
        ? { resolverAccentColor: params.resolverAccentColor }
        : {}),
      resolvedAt,
      expiresAt: params.expiresAt || addDays(resolvedAt, FRIEND_REQUEST_TTL_DAYS),
    };
    if (idx === -1) {
      draft.relayedFriendRequestOutcomes.push(entry);
    } else {
      draft.relayedFriendRequestOutcomes[idx] = entry;
    }
  });
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

/**
 * send a one-shot heartbeat to a peer to actively re-check their online
 * status (e.g. when opening their profile in the friends widget), rather
 * than waiting for the next periodic heartbeat tick. if the peer is
 * actually online it replies with its own heartbeat, which updates
 * presence state and fires `onOnlineChange` subscribers.
 */
export async function probePeer(peerNodeId: string): Promise<void> {
  if (!protocol) throw new Error("friendz bridge not initialized");
  return protocol.probePeer(peerNodeId);
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
    originBio?: string;
    originAvatarDataUrl?: string;
    originAccentColor?: number;
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

/**
 * build a `HubAdminTransport` (see `hub-admin-client.ts`) for use by any UI
 * that needs to talk to a hub's remote `iroh/skein-hub-admin/1` protocol —
 * e.g. `friends-tab.ts`'s hub-profile-panel wiring.
 *
 * reuses the exact same tauri-vs-browser midden-node access
 * `friendz-wiring.ts` already uses to build `FriendzProtocol`'s own
 * transport (`TauriStreamNode.create()` in tauri mode, the browser's
 * `getMiddenNode()` singleton otherwise) — not a second, parallel
 * transport-construction path. doesn't require the friendz bridge itself
 * to be initialized (`initBridge()`), since it talks directly to the
 * midden node rather than through `FriendzProtocol`.
 */
export function getHubAdminTransport(): HubAdminTransport {
  return {
    getMidden: isTauriMode()
      ? async () => (await TauriStreamNode.create()) as MiddenStreamNode
      : async () => (await getMiddenNode()) as unknown as MiddenStreamNode,
  };
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
  unsubscribeFriendsChange?.();
  unsubscribeFriendsChange = null;
  ensureFriendsChangeSubscription();
}

/** the social doc registered via `initKnockSocialDocBridge()`, or null if
 *  not ready yet. */
export function getKnockSocialDoc(): SocialDoc | null {
  return knockSocialDoc;
}

// ---------------------------------------------------------------------------
// friend status (used by the blob-fetch friend gate — see file-utils.ts's
// `BlobAccessDeniedError` and `pending-blob-access.ts`)
// ---------------------------------------------------------------------------

/** true if `nodeId` is one of our accepted friends' node ids. reads the
 *  same social doc `initKnockSocialDocBridge()` registered — friend state
 *  is synced into that doc's `friends` list in both tauri and browser
 *  mode, so this check works identically regardless of platform. */
export function isFriend(nodeId: string): boolean {
  const friends = knockSocialDoc?.current.friends ?? [];
  return friends.some((f) => f.nodeIds?.some((n) => n.nodeId === nodeId));
}

/** display info (username, avatar, bio) for a friend's node id, or null if
 *  `nodeId` isn't a known friend. reads the same social doc
 *  `initKnockSocialDocBridge()` registered, so it stays current as friend
 *  profiles update — callers building a card/badge for a friend's canvas
 *  (e.g. a share-link join) should look this up fresh rather than leaving
 *  these fields blank. */
export function getFriendInfo(
  nodeId: string
): { username?: string; avatarDataUrl?: string; bio?: string } | null {
  const friends = knockSocialDoc?.current.friends ?? [];
  for (const friend of friends) {
    for (const n of friend.nodeIds ?? []) {
      if (n.nodeId === nodeId) {
        return {
          username: friend.alias || n.username || friend.username,
          avatarDataUrl: n.avatarDataUrl,
          bio: n.bio,
        };
      }
    }
  }
  return null;
}

/** the local user's own social identity profile accent color (set on the
 *  profile tab, see profile-tab.ts's palette picker), or null if the social
 *  doc isn't registered yet. reads the same social doc
 *  `initKnockSocialDocBridge()` registered — used by widgets that want to
 *  default some cosmetic choice (e.g. a new voice-recording widget's lip
 *  color) to the user's own identity color instead of picking randomly. */
export function getLocalAccentColor(): number | null {
  return knockSocialDoc?.current.profile.accentColor ?? null;
}

let friendsChangeListeners: Array<() => void> = [];
let unsubscribeFriendsChange: (() => void) | null = null;

function ensureFriendsChangeSubscription(): void {
  if (unsubscribeFriendsChange || !knockSocialDoc) return;
  unsubscribeFriendsChange = knockSocialDoc.on("change", () => {
    for (const handler of friendsChangeListeners) handler();
  });
}

/** subscribe to be notified whenever the social doc's friends list changes
 *  (accept, remove, profile update, etc.) — used to retry a blob fetch
 *  once a pending friend request is accepted. if the social doc isn't
 *  registered yet, the subscription is (re-)attempted the next time
 *  `initKnockSocialDocBridge()` runs. returns an unsubscribe function. */
export function onFriendsChange(handler: () => void): () => void {
  friendsChangeListeners.push(handler);
  ensureFriendsChangeSubscription();
  return () => {
    friendsChangeListeners = friendsChangeListeners.filter((h) => h !== handler);
  };
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

/** record a hub-side ack (see `HubAckInfo`'s doc comment) and notify
 *  subscribers — see `onHubAcked()`. */
export function recordHubAck(info: HubAckInfo): void {
  hubAckedCanvasIds.add(info.canvasDocId);
  for (const listener of hubAckListeners) listener(info);
}

/** subscribe to hub-ack events. returns an unsubscribe function. */
export function onHubAcked(handler: (info: HubAckInfo) => void): () => void {
  hubAckListeners.push(handler);
  return () => {
    hubAckListeners = hubAckListeners.filter((h) => h !== handler);
  };
}

/** true if a hub ack for `canvasDocId` has been observed (this session, or
 *  backfilled from the persisted `accessRequests[].hubAcked` field at
 *  startup — see `hubAckedCanvasIds`'s doc comment). */
export function hasHubAckForCanvas(canvasDocId: string): boolean {
  return hubAckedCanvasIds.has(canvasDocId);
}

/** mark a canvas's access-request "resend" action as used for the rest of
 *  this session — see `manuallyRetriedCanvasIds`'s doc comment. */
export function markManuallyRetried(canvasDocId: string): void {
  manuallyRetriedCanvasIds.add(canvasDocId);
}

/** true if the "resend" action for `canvasDocId` has already been used
 *  this session (see `markManuallyRetried()`). */
export function wasManuallyRetried(canvasDocId: string): boolean {
  return manuallyRetriedCanvasIds.has(canvasDocId);
}

/** record one or more node ids as known canvas-sharing hubs — see
 *  `knownHubNodeIds`'s doc comment. safe to call repeatedly with the same
 *  ids. */
export function recordKnownHubNodeIds(nodeIds: string[]): void {
  for (const id of nodeIds) knownHubNodeIds.add(id);
}

/** true if `nodeId` is a known canvas-sharing hub (see `recordKnownHubNodeIds()`). */
export function isKnownHubNodeId(nodeId: string): boolean {
  return knownHubNodeIds.has(nodeId);
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

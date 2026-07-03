import { cbor } from "@automerge/automerge-repo";
import type { DocumentId, Repo } from "@automerge/automerge-repo";

import type { SkeinCanvas } from "../canvas/init";
import type { InvitableRole } from "../canvas/canvas-doc";
import type { CanvasStore } from "../canvas/canvas-store";
import type { FriendzProtocol } from "../p2p/friends-protocol";
import type { EndpointState, IrohNetworkAdapter } from "../p2p/iroh-network-adapter";
import {
  approveKnock,
  declineKnock,
  mergeGossipDigestKnocks,
  mergeGossipDigestProfiles,
  wireKnockHandlers,
  type KnockRelayInfo,
  type ProfileRelayInfo,
} from "../standalone/friendz-wiring";
import type { SocialDoc } from "../../widgets/narthex/social/types";
import type { SocialState } from "../../widgets/narthex/social/schema";
import type { HubProfilePanelState } from "../../widgets/narthex/social/hub-profile-panel";
import type { ProfileCanvasBinTestHooks } from "../../widgets/narthex/social/canvas-bin";
import type { ProfileCanvasEntry, ProfileStore } from "../canvas/profile-doc";
import type { FriendInfo } from "../canvas/share-dialog";
import { storeBlob, classifyDomain } from "../storage/skein-blob-store";

/**
 * ALPN for reliquary's remote hub-administration protocol
 * (`reliquary/src/protocol/hub_admin.rs`). lets an authenticated remote
 * admin peer manage the hub's friendz allow-list over the network.
 */
const HUB_ADMIN_ALPN = "iroh/skein-hub-admin/1";

/**
 * max response size to read back from a hub admin request. matches
 * reliquary's own `MAX_MESSAGE_SIZE` in `protocol/hub_admin.rs`.
 */
const DEFAULT_MAX_ADMIN_RESPONSE_BYTES = 1024 * 1024;

/**
 * request payloads for `iroh/skein-hub-admin/1`, mirroring
 * `reliquary::protocol::hub_admin::AdminRequest`.
 */
export type AdminRequest =
  | { kind: "allow"; nodeId: string }
  | { kind: "list" }
  | { kind: "remove"; nodeId: string };

/** a single friendz row, as reported by an `AdminResponse::List`. */
export interface AdminFriendSummary {
  nodeId: string;
  status: string;
  updatedAt: number;
}

/**
 * response payloads for `iroh/skein-hub-admin/1`, mirroring
 * `reliquary::protocol::hub_admin::AdminResponse`.
 */
export type AdminResponse =
  | { kind: "allowed"; nodeId: string; status: string }
  | { kind: "list"; friends: AdminFriendSummary[] }
  | { kind: "removed"; nodeId: string }
  | { kind: "notAdmin" }
  | { kind: "error"; message: string };

/**
 * build the CBOR-ready wire value for an `AdminRequest`, matching serde's
 * default externally-tagged enum representation (the shape `ciborium`
 * produces/expects on the reliquary side): a unit variant like `List`
 * encodes as just its variant name, a struct variant like `Allow { .. }`
 * encodes as a single-key map `{ Allow: { node_id: .. } }`.
 */
function toWireAdminRequest(request: AdminRequest): unknown {
  switch (request.kind) {
    case "allow":
      return { Allow: { node_id: request.nodeId } };
    case "list":
      return "List";
    case "remove":
      return { Remove: { node_id: request.nodeId } };
  }
}

/** parse the CBOR-decoded wire value for an `AdminResponse` back into our TS shape. */
function fromWireAdminResponse(wire: unknown): AdminResponse {
  if (wire === "NotAdmin") {
    return { kind: "notAdmin" };
  }
  if (wire && typeof wire === "object") {
    const obj = wire as Record<string, unknown>;
    if ("Allowed" in obj) {
      const v = obj.Allowed as { node_id: string; status: string };
      return { kind: "allowed", nodeId: v.node_id, status: v.status };
    }
    if ("List" in obj) {
      const v = obj.List as {
        friends: Array<{ node_id: string; status: string; updated_at: number }>;
      };
      return {
        kind: "list",
        friends: v.friends.map((f) => ({
          nodeId: f.node_id,
          status: f.status,
          updatedAt: f.updated_at,
        })),
      };
    }
    if ("Removed" in obj) {
      const v = obj.Removed as { node_id: string };
      return { kind: "removed", nodeId: v.node_id };
    }
    if ("Error" in obj) {
      const v = obj.Error as { message: string };
      return { kind: "error", message: v.message };
    }
  }
  throw new Error(`unrecognized AdminResponse wire shape: ${JSON.stringify(wire)}`);
}

/**
 * p2p test bridge — methods only available when the page was bootstrapped
 * with a real IrohNetworkAdapter (test-harness-p2p.html).
 */
export interface SkeinP2PBridge {
  /** this instance's iroh node ID (async — may need to wait for midden to init) */
  getNodeId(): Promise<string>;
  /** dial a peer by node ID and keep the connection alive */
  addPeer(nodeId: string): Promise<void>;
  /**
   * stop maintaining the automerge-repo-level connection to a peer added via
   * `addPeer()` — closes the existing stream and stops reconnecting.
   * delegates to `IrohNetworkAdapter.forgetPeer()`. useful for tests that
   * need to prove some *other* delivery path (e.g. the skein-friendz/1
   * gossip-digest message) works on its own, independent of ordinary
   * automerge doc-sync — severing this link means the automerge-repo
   * `Repo` genuinely has no way left to sync changes with that peer.
   */
  forgetPeer(nodeId: string): Promise<void>;
  /** read the current endpoint lifecycle state synchronously */
  getEndpointState(): EndpointState;
  /**
   * resolve once the endpoint reaches "online", or reject after timeoutMs.
   * default timeout: 30 000 ms.
   */
  waitForOnline(timeoutMs?: number): Promise<void>;
  /**
   * import raw bytes into this peer's midden iroh-blobs store AND register a
   * matching local blob record (mirrors what `widgets/file.ts`'s real upload
   * flow does via `storeBlobFromFile`). returns the blake3 hex hash — use
   * this as the canonical `blake3` field on a file widget's state doc for
   * tests that need a peer to actually have a blob available for
   * snatch/download.
   *
   * registering the local blob record matters: the file widget's own
   * `checkLocality()` looks the blob up in this peer's local blob store
   * (IndexedDB/OPFS), not midden's in-memory iroh-blobs store — if it isn't
   * found there, the widget assumes the blob is remote and strips this
   * peer's node id back out of `snatchedBy` on mount, which starves the hub
   * of any peer to probe.
   */
  importBlob(data: Uint8Array, options?: { filename?: string; mime?: string }): Promise<string>;
  /**
   * fetch a blob's bytes directly from another peer by node id + blake3
   * hash, using midden's `download_verified_with_ensure` (the same
   * verified iroh-blobs transfer `widgets/file-utils.ts` uses for full
   * blob downloads). this talks straight to the peer's raw iroh endpoint —
   * it does not go through the canvas doc or `AclFilteringNetworkAdapter`
   * at all, which is exactly what makes it useful for testing whether blob
   * access is (or isn't) gated by canvas membership.
   */
  fetchBlob(peerNodeId: string, blake3Hash: string): Promise<Uint8Array>;
  /**
   * test hook for the blob-ACL gate (see `midden::build_gated_blobs_events`
   * / `MiddenNode::restrict_blob_to_peers` in `midden/src/lib.rs`):
   * restricts a blob (by blake3 hash) on THIS peer's
   * `iroh_blobs::BlobsProtocol` so only the given peer node ids may fetch
   * it. a hash never passed to this method is unrestricted (today's
   * default, unchanged). delegates to `IrohNetworkAdapter.restrictBlobToPeers`
   * — the same production entry point `CanvasBlobAclSync`
   * (`canvas/blob-acl-sync.ts`) uses to mirror a canvas's real `.acl` onto
   * this gate, so calling it directly here is a manual stand-in for that
   * real wiring, not a separate/fake code path.
   */
  restrictBlobToPeers(blake3Hash: string, peerNodeIds: string[]): Promise<void>;
  /**
   * dial a hub's `iroh/skein-hub-admin/1` remote admin protocol and send a
   * single request, returning its parsed response. opens a raw bidirectional
   * stream via the underlying midden node (same `open_bi` mechanism
   * `importBlob`/`fetchBlob` use), writes a CBOR-encoded request terminated
   * by `finish()`, then reads the CBOR-encoded response back with
   * `read_to_end()` — mirrors reliquary's `protocol::hub_admin` framing.
   *
   * the caller is only treated as an admin if their own node id is already
   * in the hub's `hub_adminz` table (bootstrapped locally, e.g. via
   * `ReliquaryHubHandle.adminAllow()` in tests) — a non-admin caller gets
   * back a `{ kind: "notAdmin" }` response and nothing changes hub-side.
   */
  hubAdminRequest(peerNodeId: string, request: AdminRequest): Promise<AdminResponse>;
}

/**
 * friendz test bridge — methods only available when the page was
 * bootstrapped with a real FriendzProtocol instance (test-harness-p2p.html).
 *
 * this drives the `skein-friendz/1` handshake against any peer by node id —
 * another browser peer or a real reliquary hub, the protocol doesn't
 * distinguish between the two. production wiring lives in
 * `standalone/friendz-wiring.ts` and writes into the real social automerge
 * doc; this test bridge tracks accepted friends in a plain in-memory set
 * instead, since the p2p test harness has no narthex/social doc set up.
 */
export interface SkeinFriendzTestBridge {
  /** send a friend request to a peer by node id. */
  sendFriendRequest(peerNodeId: string): Promise<void>;
  /** whether a peer's friend request has been accepted (mutual friendship
   *  established locally, tracked since the harness page loaded). */
  isFriend(peerNodeId: string): boolean;
  /** all peer node ids currently recorded as accepted friends. */
  getFriends(): string[];
}

/**
 * test hooks for `friends-tab.ts`'s friend-detail view and its hub-profile-
 * panel wiring (see docs/hub-and-profile-plan.md section 5 / section 8 step
 * 7). registered via `registerSocialBridge({ friendsTab: ... })` from
 * `friends-tab.ts` itself, same pattern `profile-tab.ts` already uses for
 * `pickAvatar`.
 *
 * these call the tab's real internal handlers directly (not simulated pixi
 * pointer clicks) — same precedent as `MessagezTestHooks`'s
 * `simulateKnockAck` in `messagez-widget.ts`, since this repo has no
 * existing infrastructure for driving pixi canvas UI via real pointer
 * events in playwright.
 */
export interface FriendsTabTestHooks {
  /** the tab's current internal sub-view. */
  getViewMode(): "list" | "detail" | "add" | "hubProfile";
  /** open the friend-detail view for the given friend id, as if the row were tapped. */
  openFriendDetail(friendId: string): void;
  /** return to the friends list view, as if the detail view's back button were tapped. */
  closeFriendDetail(): void;
  /** whether the "manage hub" action is shown in the currently-open detail view. */
  hasManageHubAction(): boolean;
  /** tap the "manage hub" action — mounts the hub-profile-panel. no-op unless
   *  `hasManageHubAction()` is true. */
  openHubProfilePanel(): void;
  /** close the hub-profile-panel, returning to the friend-detail view. */
  closeHubProfilePanel(): void;
  /** whether the hub-profile-panel is currently mounted. */
  isHubProfilePanelOpen(): boolean;
  /** the mounted hub-profile-panel's current render state, or null if not open. */
  getHubProfilePanelState(): HubProfilePanelState | null;
  /** re-fetch the mounted hub-profile-panel's friendz + pending knocks. no-op if not open. */
  refreshHubProfilePanel(): Promise<void>;
  /**
   * dev/test-only: global (screen-space) center position of the mounted
   * hub-profile-panel's "allow" input field, or null if the panel isn't
   * open or isn't in its "ready" state. same `getGlobalPosition()`-based
   * precedent as `messagez-widget.ts`'s `getKnockActionGlobalPos()` — lets
   * a test drive a real `page.mouse.click()` + `page.keyboard.type()`
   * through the panel's actual DOM input overlay, not a bypass.
   */
  getHubProfileAllowInputGlobalPos(): { x: number; y: number } | null;
  /** global center position of the mounted hub-profile-panel's "allow"
   *  button, or null if not currently rendered. */
  getHubProfileAllowButtonGlobalPos(): { x: number; y: number } | null;
  /** global center position of the mounted hub-profile-panel's "remove"
   *  button for a given friend node id, or null if that row isn't
   *  currently rendered. */
  getHubProfileRemoveButtonGlobalPos(nodeId: string): { x: number; y: number } | null;
  /** the rendered node-id text in the currently-open friend-detail view
   *  (only set for a hub friend — see docs/hub-and-profile-plan.md section
   *  10.3), or null if not showing. proves the actual rendered content, not
   *  just the underlying `FriendEntry.nodeIds` data. */
  getFriendDetailNodeIdText(): string | null;
  /** global center position of the hub-profile-panel's "‹ back" button,
   *  or null if the panel isn't currently mounted. */
  getHubProfileBackButtonGlobalPos(): { x: number; y: number } | null;
}

/**
 * test hooks for `profile-tab.ts`'s "my canvases" section (see
 * docs/hub-and-profile-plan.md section 8 step 7, second half). registered
 * via `registerSocialBridge({ profileTab: ... })` from `profile-tab.ts`
 * itself, same pattern used for `pickAvatar`/`friendsTab`.
 *
 * `getCanvasEntries()` reads `ProfileStore.canvases()` directly (not just
 * pixi render state) so tests can verify the underlying doc, not only what
 * got drawn. `addCurrentCanvas()`/`removeCanvas()` call the tab's real
 * internal handlers directly, same precedent as `FriendsTabTestHooks`.
 */
export interface ProfileTabTestHooks {
  /** all canvases currently on the local peer's profile doc, per
   *  `ProfileStore.canvases()`. empty array if no profile store is mounted. */
  getCanvasEntries(): ProfileCanvasEntry[];
  /** whether "add current canvas" can act — false if this mount has no live
   *  canvasStore/profileStore (e.g. some test harnesses). */
  canAddCurrentCanvas(): boolean;
  /** add the currently-open canvas to the profile, as if the button were tapped. */
  addCurrentCanvas(): void;
  /** remove a canvas from the profile by its doc id, as if its row's remove button were tapped. */
  removeCanvas(canvasDocId: string): void;
  /** titles currently rendered in the "my canvases" list — proves the UI
   *  actually reflects the doc, not just that the doc was mutated. */
  getRenderedCanvasTitles(): string[];
  /** canvasDocIds in the "my canvases" list whose preview-image `Sprite`
   *  has actually finished loading and attached (not just that the entry
   *  has a `previewUrl` set) — lets a test (or live debugging) prove an
   *  image genuinely rendered, mirrors canvas-bin.ts's
   *  `ProfileCanvasBinTestHooks.getLoadedPreviewNodeIds()`. */
  getLoadedPreviewCanvasIds(): string[];
}

/**
 * test hooks for the canvas share dialog's invite/cancel wiring (see
 * boot.ts's `onShare` handler, `share-dialog.ts`). unlike `MessagezTestHooks`/
 * `FriendsTabTestHooks` (registered once when a persistent widget mounts),
 * the share dialog is built fresh every time the toolbar's share button is
 * pressed — so `window.__skeinTest.share` is (re)assigned fresh on each
 * open, not merged into an existing object.
 *
 * `getFriendsForInvite()` is a snapshot of the exact list passed to the
 * currently-open dialog (recompute it by re-opening the dialog — e.g. after
 * an invite/cancel — to see it reflect the new state). `getPendingInvites()`/
 * `getMessagezShares()` read live from the canvas doc / messagez outbox, so
 * they reflect the latest state without needing to reopen anything.
 * `inviteFriend()`/`cancelInvite()` call the dialog's real `onInviteFriend`/
 * `onCancelInvite` closures directly — the exact same code a real button
 * press runs, not a re-implementation.
 */
export interface ShareTestHooks {
  /** the friend-invite list passed to the currently-open share dialog
   *  (already includes each friend's `isHub` flag — see
   *  `splitFriendsForInvite()` in share-dialog.ts for the section grouping
   *  this list feeds into). */
  getFriendsForInvite(): FriendInfo[];
  /** pending invites on the current canvas doc, read live from
   *  `CanvasStore.pendingInvites()`. */
  getPendingInvites(): Array<{ targetNodeId: string; invite: Record<string, unknown> }>;
  /** raw messagez outbox `shares` entries for this canvas, read live from the
   *  messagez doc — the data that actually gates the "already invited"
   *  filter (see boot.ts's `alreadyInvited` set). */
  getMessagezShares(): Array<{
    toNodeId: string;
    canvasDocId: string;
    declined?: boolean;
    cancelled?: boolean;
  }>;
  /** invite a friend by node id + role, calling the dialog's real
   *  `onInviteFriend` handler exactly as if its "invite" button were
   *  pressed. no-op if the friend isn't in the last `getFriendsForInvite()`
   *  snapshot. */
  inviteFriend(nodeId: string, role: InvitableRole): Promise<void>;
  /** cancel a pending invite by target node id, calling the dialog's real
   *  `onCancelInvite` handler exactly as if its "cancel" button were
   *  pressed. */
  cancelInvite(nodeId: string): void;
  /** close the currently-open share dialog. */
  closeShareDialog(): void;
  /**
   * the rendered display-name text for a friend-invite row (regular or hub
   * section), by node id, or null if that friend isn't currently rendered
   * (not in the invite list, already invited, or filtered out). proves the
   * actual rendered row content reflects the right peer — not just that
   * the right `FriendInfo` was passed in, which `getFriendsForInvite()`
   * already covers (docs/hub-and-profile-plan.md section 10.3).
   */
  getFriendRowText(nodeId: string): string | null;
}

/**
 * social test bridge — present on `window.__skeinTest.social` when the full
 * boot router has initialised (i.e. the page loaded index.html, not a test
 * harness page). populated in DEV builds only.
 */
export interface SkeinTestBridgeSocial {
  /** the live standalone social doc (profile, friends, requests, etc.) */
  readonly doc: { current: Record<string, unknown> } | null;
  /** generate or restore a P2P identity. mirrors identity.ts ensureIdentity(). */
  ensureIdentity(): Promise<{ node_id: string }>;
  /** open / close the social overlay panel */
  toggleOverlay(): void;
  /**
   * send a real friend request to a node id through this page's actual
   * production `FriendzProtocol` instance — exactly what `friends-tab.ts`'s
   * "add friend" flow does. distinct from `test-harness-p2p.html`'s own
   * `SkeinFriendzTestBridge` (`window.__skeinTest.friendz`), which uses a
   * separate, in-memory-only `FriendzProtocol` instance with no narthex/
   * social doc wiring at all — this one writes into the real social doc via
   * `standalone/friendz-wiring.ts`'s handlers, so a friendship established
   * this way is visible everywhere the production app itself reads
   * `friendsState.friends` from (e.g. the share dialog's invite list).
   */
  sendFriendRequestTo?(nodeId: string): Promise<void>;
  /** trigger the avatar file picker (set by profile-tab on mount) */
  pickAvatar?(): Promise<void>;
  /** friends-tab test hooks (set by friends-tab.ts on mount) */
  friendsTab?: FriendsTabTestHooks;
  /** profile-tab "my canvases" test hooks (set by profile-tab.ts on mount) */
  profileTab?: ProfileTabTestHooks;
  /** profile canvas-bin widget test hooks (set by canvas-bin.ts on mount) */
  canvasBin?: ProfileCanvasBinTestHooks;
  /** a friend's read-only canvas-bin test hooks, mounted inside the
   *  friend-detail view once their profile+bin docs are reachable (set by
   *  friends-tab.ts). absent/undefined whenever no friend-bin section is
   *  currently mounted (no selected friend, no resolvable docs yet, etc). */
  friendCanvasBin?: ProfileCanvasBinTestHooks;
}

/**
 * the single window-level test bridge placed on `window.__skeinTest`.
 *
 * consolidates all test-time APIs into one typed, documented object — no more
 * scattered `window.__*` hooks spread across source files.
 *
 * populated in dev mode only; never present in production builds.
 */
export interface SkeinTestBridge {
  /** the running skein canvas instance */
  canvas: SkeinCanvas;
  /**
   * social helpers — present when the full boot router is running (index.html).
   * null when using test harness pages (test-harness.html etc.).
   */
  social?: SkeinTestBridgeSocial;
  /**
   * p2p helpers — present only when the page was bootstrapped via
   * test-harness-p2p.html / p2p-test-bootstrap.ts.
   * null for ordinary BroadcastChannel-only test pages.
   */
  p2p: SkeinP2PBridge | null;
  /**
   * friendz helpers — present only when the page was bootstrapped via
   * test-harness-p2p.html / p2p-test-bootstrap.ts.
   * null for ordinary BroadcastChannel-only test pages.
   */
  friendz?: SkeinFriendzTestBridge | null;
  /**
   * knock (access-request) helpers — present only when the page was
   * bootstrapped via test-harness-p2p.html / p2p-test-bootstrap.ts.
   * null for ordinary BroadcastChannel-only test pages.
   */
  knock?: SkeinKnockTestBridge | null;
  /**
   * profile-doc gossip-relay helpers (docs/hub-and-profile-plan.md section 6)
   * — present only when the page was bootstrapped via
   * test-harness-p2p.html / p2p-test-bootstrap.ts.
   * null for ordinary BroadcastChannel-only test pages.
   */
  profileGossip?: SkeinProfileGossipTestBridge | null;
  /**
   * share dialog test hooks — present once the toolbar's share button has
   * been pressed at least once for the current canvas (index.html only).
   * null/absent otherwise.
   */
  share?: ShareTestHooks | null;
  /**
   * generic per-widget-instance test hooks, keyed by widget id — for real
   * `WidgetFactory`-registered widgets placed via the palette (unlike the
   * social overlay's hand-mounted tabs, which use `registerSocialBridge()`
   * under a single well-known key). see `registerWidgetBridge()`/
   * `unregisterWidgetBridge()` in test-bridge-registry.ts. populated in DEV
   * builds only.
   */
  widgets?: Record<string, unknown>;
}

/**
 * test hooks for the "friend canvas bin" narthex widget (a real,
 * palette-placeable `WidgetFactory` — see
 * widgets/narthex/friend-canvas-bin.ts). registered per widget instance via
 * `registerWidgetBridge(widgetId, hooks)` under
 * `window.__skeinTest.widgets[widgetId]`, since (unlike the social overlay's
 * singleton tabs) more than one instance of this widget can exist on the
 * narthex at once.
 */
export interface FriendCanvasBinTestHooks {
  /** the currently-configured friend selection, or null if the widget is
   *  still in its unconfigured "pick a friend" state. */
  getSelection(): { nodeId: string; profileDocId: string; displayName: string } | null;
  /** select a friend as if their row in the picker had been tapped —
   *  same precedent as other widgets' "drive the real internal handler
   *  directly" test hooks (no infra for simulated pixi pointer taps). */
  selectFriend(nodeId: string, profileDocId: string, displayName: string): void;
  /** clear the current selection, returning to the "pick a friend" state,
   *  as if the "change friend" link had been tapped. */
  clearSelection(): void;
  /** the picker's current candidate list (best-effort read of the local
   *  peer's own friend list — see friend-directory.ts). */
  getPickerCandidates(): Array<{ nodeId: string; profileDocId: string; displayName: string }>;
  /** high-level resolution status, for asserting the "friend has no
   *  canvas-bin doc yet" / "doc unreachable" best-effort cases without an
   *  error UI. */
  getStatus(): "unconfigured" | "resolving" | "no-canvas-bin" | "ready";
  /** the mounted read-only bin's own test hooks, once `getStatus()` is
   *  `"ready"` — null otherwise. */
  getBinHooks(): ProfileCanvasBinTestHooks | null;
}

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

/**
 * build a SkeinP2PBridge from a live IrohNetworkAdapter.
 * call this from test bootstrap code after creating the adapter.
 */
export function buildP2PBridge(adapter: IrohNetworkAdapter): SkeinP2PBridge {
  return {
    async getNodeId(): Promise<string> {
      const node = await adapter.getNode();
      return node.node_id();
    },

    addPeer(nodeId: string): Promise<void> {
      return adapter.addPeer(nodeId);
    },

    async forgetPeer(nodeId: string): Promise<void> {
      adapter.forgetPeer(nodeId);
    },

    getEndpointState(): EndpointState {
      return adapter.getEndpointState();
    },

    async waitForOnline(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (adapter.getEndpointState() !== "online") {
        if (Date.now() > deadline) {
          const state = adapter.getEndpointState();
          throw new Error(
            `iroh endpoint did not reach "online" within ${timeoutMs}ms (state: "${state}")`
          );
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
    },

    async importBlob(data: Uint8Array, options?: { filename?: string; mime?: string }): Promise<string> {
      const node = await adapter.getNode();
      // the MiddenStreamNode type only declares the transport-adjacent
      // methods this adapter needs; the underlying wasm node also exposes
      // iroh-blobs helpers like `import_blob`, used here to make test blobs
      // servable without depending on the full upload/widget UI flow.
      const nodeAny = node as unknown as { import_blob(data: Uint8Array): Promise<string> };
      const blake3 = await nodeAny.import_blob(data);

      // also register a local blob record, mirroring what a real upload
      // (storeBlobFromFile) does — without this, the blob only exists in
      // midden's in-memory iroh-blobs store, and checkBlobLocality (which
      // only looks at IndexedDB/OPFS) reports it as remote.
      const mime = options?.mime ?? "application/octet-stream";
      const filename = options?.filename ?? "test-blob";
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      await storeBlob(blake3, buffer, {
        blob_id: blake3,
        sha256: "",
        blake3,
        filename,
        mime,
        size: data.byteLength,
        domain: classifyDomain(mime),
        blob_type: "original",
        parent_blob_id: null,
        metadata: {},
      });

      return blake3;
    },

    async fetchBlob(peerNodeId: string, blake3Hash: string): Promise<Uint8Array> {
      const node = await adapter.getNode();
      // same reasoning as importBlob() above: `download_verified_with_ensure`
      // is a real midden wasm export (see midden/src/lib.rs), not part of
      // the narrow MiddenStreamNode transport interface this adapter needs.
      const nodeAny = node as unknown as {
        download_verified_with_ensure(peerAddr: string, blake3: string): Promise<Uint8Array>;
      };
      return nodeAny.download_verified_with_ensure(peerNodeId, blake3Hash);
    },

    async restrictBlobToPeers(blake3Hash: string, peerNodeIds: string[]): Promise<void> {
      // delegates to the real production entry point (IrohNetworkAdapter.
      // restrictBlobToPeers, added alongside CanvasBlobAclSync) rather than
      // reaching into the wasm node directly — this test hook and real
      // canvas-ACL-driven callers now go through the exact same path.
      return adapter.restrictBlobToPeers(blake3Hash, peerNodeIds);
    },

    async hubAdminRequest(peerNodeId: string, request: AdminRequest): Promise<AdminResponse> {
      const node = await adapter.getNode();
      // `open_bi` is part of the narrow MiddenStreamNode interface already,
      // but the raw (non-length-delimited) framing methods used by
      // `skein/1`/`skein-hub-admin/1`-style protocols aren't — same pattern
      // as BiStreamLike's optional `read_to_end`/`write_raw_and_finish`.
      const stream = await node.open_bi(peerNodeId, HUB_ADMIN_ALPN);
      const streamAny = stream as unknown as {
        write_raw_and_finish(data: Uint8Array): Promise<void>;
        read_to_end(max_size: number): Promise<Uint8Array>;
        close(): void;
      };

      const wireRequest = toWireAdminRequest(request);
      const encoded = cbor.encode(wireRequest);
      await streamAny.write_raw_and_finish(encoded);
      const responseBytes = await streamAny.read_to_end(DEFAULT_MAX_ADMIN_RESPONSE_BYTES);
      streamAny.close();

      const wireResponse = cbor.decode(responseBytes);
      return fromWireAdminResponse(wireResponse);
    },
  };
}

/**
 * build a SkeinFriendzTestBridge from a live FriendzProtocol.
 *
 * wires `protocol.onFriendAccept` to record accepted friends into
 * `acceptedFriends` — the caller owns this set (and typically also passes
 * it as the `isFriend` predicate's backing store when constructing the
 * protocol itself), since the protocol constructor needs an `isFriend`
 * callback before the bridge can exist to provide one.
 */
export function buildFriendzTestBridge(
  protocol: FriendzProtocol,
  acceptedFriends: Set<string>
): SkeinFriendzTestBridge {
  protocol.onFriendAccept = (_msg, fromNodeId) => {
    acceptedFriends.add(fromNodeId);
  };

  return {
    async sendFriendRequest(peerNodeId: string): Promise<void> {
      await protocol.sendFriendRequest(peerNodeId);
    },

    isFriend(peerNodeId: string): boolean {
      return acceptedFriends.has(peerNodeId);
    },

    getFriends(): string[] {
      return [...acceptedFriends];
    },
  };
}

/**
 * knock (access-request) test bridge — methods only available when the
 * page was bootstrapped with a real FriendzProtocol + CanvasStore + Repo
 * (test-harness-p2p.html).
 *
 * wraps the real knock plumbing from `standalone/friendz-wiring.ts`
 * (`wireKnockHandlers`, `approveKnock`, `declineKnock`,
 * `mergeGossipDigestKnocks`) so e2e tests can drive the actual production
 * message flow without needing the full narthex/social/messagez setup
 * `initFriendzWiring()` normally requires — same reasoning as
 * `buildFriendzTestBridge` above.
 */
export interface SkeinKnockTestBridge {
  /** send a `canvas-knock` message directly to a peer — the low-level send
   *  a real knock-form UI (not built yet) would eventually wrap. */
  sendKnock(
    peerNodeId: string,
    knock: { knockId: string; canvasDocId: string; requesterUsername: string; message: string }
  ): Promise<void>;
  /** approve a pending knock — wraps `friendz-wiring.ts`'s `approveKnock()`. */
  approveKnock(requesterNodeId: string, role: InvitableRole): Promise<void>;
  /** decline a pending knock — wraps `friendz-wiring.ts`'s `declineKnock()`. */
  declineKnock(requesterNodeId: string): Promise<void>;
  /** relay-attribution events observed so far on this peer — see
   *  `wireKnockHandlers`'s `onKnockRelayed` and `mergeGossipDigestKnocks`. */
  getRelayedKnocks(): KnockRelayInfo[];
  /** `canvas-knock-ack` events received so far on this peer — a
   *  deterministic "the knock was actually processed by someone" signal,
   *  useful for tests that need to wait past a specific knock attempt
   *  before asserting on dedup/idempotency. */
  getReceivedKnockAcks(): Array<{ knockId: string; canvasDocId: string; ackerNodeId: string }>;
  /** manually send a gossip digest carrying this peer's own pending knocks
   *  for `canvasDocId` to another peer — lets tests trigger relay delivery
   *  deterministically instead of waiting on the real heartbeat timer. */
  sendKnocksGossipDigest(peerNodeId: string, canvasDocId: string): Promise<void>;
  /** read a node id's role from a canvas doc's `.acl`, opening/syncing the
   *  doc first if this peer doesn't already hold it. returns null if the
   *  doc can't be reached or the node has no ACL entry. */
  getCanvasAcl(canvasDocId: string, nodeId: string): Promise<string | null>;
}

/**
 * build a SkeinKnockTestBridge, wiring the real `canvas-knock*` message
 * handlers (`wireKnockHandlers`) and gossip-digest merge logic
 * (`mergeGossipDigestKnocks`) onto `protocol`.
 *
 * `getStore` is a thunk rather than a captured `CanvasStore` because the
 * p2p test harness can swap the active canvas out from under a page (see
 * `joinCanvasForTest` in `p2p-test-bootstrap.ts`, which replaces
 * `window.__skeinTest.canvas`) — resolving the store fresh on every call
 * keeps this bridge pointed at whichever canvas is actually current.
 */
export function buildKnockTestBridge(options: {
  protocol: FriendzProtocol;
  getStore: () => CanvasStore;
  repo: Repo;
  irohAdapter: IrohNetworkAdapter;
  localNodeId: string;
}): SkeinKnockTestBridge {
  const { protocol, getStore, repo, irohAdapter, localNodeId } = options;
  const relayedKnocks: KnockRelayInfo[] = [];
  const receivedAcks: Array<{ knockId: string; canvasDocId: string; ackerNodeId: string }> = [];

  wireKnockHandlers({
    protocol,
    repo,
    irohAdapter,
    localNodeId,
    onKnockRelayed: (info) => relayedKnocks.push(info),
    onKnockAcked: (info) => receivedAcks.push(info),
  });

  // the p2p test harness has no narthex/social doc for `approveKnock()`'s
  // friend-establishment step to write into (same reasoning as
  // `buildFriendzTestBridge`'s in-memory `acceptedFriends` set above) — a
  // minimal in-memory stand-in satisfying the `SocialDoc` interface is
  // enough for `approveKnock()` to run for real without throwing.
  const socialState: SocialState = { friends: [] } as unknown as SocialState;
  const socialDoc: SocialDoc = {
    get current() {
      return socialState;
    },
    change(fn) {
      fn(socialState);
    },
    on() {
      return () => {};
    },
  };

  // gossip-digest knock merging is wired separately from
  // `wireKnockHandlers` (which only sets the four `canvas-knock*` message
  // handlers) — `onGossipDigest` is a single field, and production code
  // (`initFriendzWiring`) combines its own canvas-update/invite processing
  // with this same `mergeGossipDigestKnocks` call in one handler. the test
  // harness has no canvas-update/invite gossip processing of its own, so
  // this is the entire handler here.
  protocol.onGossipDigest = (msg, fromNodeId) => {
    mergeGossipDigestKnocks(repo, msg, fromNodeId, (info) => relayedKnocks.push(info)).catch(() => {
      // best effort — logged inside mergeGossipDigestKnocks already
    });
  };

  return {
    async sendKnock(peerNodeId, knock) {
      await protocol.sendCanvasKnock(peerNodeId, {
        knockId: knock.knockId,
        canvasDocId: knock.canvasDocId,
        requesterNodeId: localNodeId,
        requesterUsername: knock.requesterUsername,
        message: knock.message,
      });
    },

    async approveKnock(requesterNodeId, role) {
      await approveKnock(
        { protocol, store: getStore(), socialDoc, localNodeId },
        requesterNodeId,
        role
      );
    },

    async declineKnock(requesterNodeId) {
      await declineKnock({ protocol, store: getStore(), localNodeId }, requesterNodeId);
    },

    getRelayedKnocks(): KnockRelayInfo[] {
      return [...relayedKnocks];
    },

    getReceivedKnockAcks() {
      return [...receivedAcks];
    },

    async sendKnocksGossipDigest(peerNodeId, canvasDocId) {
      const doc = getStore().doc();
      const knocks = Object.values(doc.pendingKnocks ?? {})
        .filter((k) => k.requesterNodeId !== peerNodeId)
        .map((k) => ({
          canvasDocId,
          requesterNodeId: k.requesterNodeId,
          requesterUsername: k.requesterUsername,
          message: k.message,
          knockedAt: k.knockedAt,
        }));
      await protocol.sendGossipDigest(peerNodeId, {
        canvasUpdates: [],
        pendingInvites: [],
        pendingKnocks: knocks,
      });
    },

    async getCanvasAcl(canvasDocId, nodeId) {
      const handle = await repo.find(canvasDocId as DocumentId);
      const doc = handle.doc() as { acl?: Record<string, { role: string }> } | undefined;
      return doc?.acl?.[nodeId]?.role ?? null;
    },
  };
}

/**
 * profile-doc gossip test bridge — methods only available when the page
 * was bootstrapped with a real `ProfileStore` + `FriendzProtocol` + `Repo`
 * (test-harness-p2p.html). exercises the real
 * `mergeGossipDigestProfiles()`/`computeAndSendGossipDigest()`-equivalent
 * relay logic from `standalone/friendz-wiring.ts` (docs/hub-and-profile-plan.md
 * section 6), same "wrap the real production function, minimal in-memory
 * stand-in for what a full narthex/social/messagez setup would otherwise
 * provide" reasoning as `buildKnockTestBridge` above — has its own
 * independent in-memory `SocialDoc` stand-in (not shared with
 * `buildKnockTestBridge`'s), since these two bridges test unrelated
 * features and a test using this one has no need for knock plumbing too.
 */
export interface SkeinProfileGossipTestBridge {
  /** this peer's own profile-doc id. */
  getMyProfileDocId(): string;
  /** update this peer's own profile content (bumps `ProfileStore.updatedAt()`). */
  setMyProfile(username: string, bio: string): void;
  /** seed a friend entry with a known node id — mirrors what a real
   *  friend-request/accept handshake would already have populated, so
   *  gossip merge has somewhere to write a relayed profile pointer into. */
  addFriend(peerNodeId: string): void;
  /** the profile-doc pointer this peer currently knows for a given peer
   *  node id (learned directly via profile-response, or relayed via
   *  gossip), or null if unknown/not yet learned. */
  getKnownProfilePointer(peerNodeId: string): { profileDocId: string; updatedAt: string } | null;
  /** profile-doc pointers merged via gossip relay so far. */
  getRelayedProfiles(): ProfileRelayInfo[];
  /** manually send a gossip digest to `peerNodeId` carrying this peer's
   *  own profile pointer plus every other known friend's pointer it's
   *  aware of — lets tests trigger relay delivery deterministically
   *  instead of waiting on the real heartbeat/peer-online timer. */
  sendProfileGossipDigest(peerNodeId: string): Promise<void>;
  /** read a profile doc's content directly, opening/syncing it first if
   *  this peer doesn't already hold it. returns null if unreachable —
   *  proves the actual doc content (not just the pointer) arrived. */
  readProfileDoc(profileDocId: string): Promise<{ username: string; bio: string } | null>;
}

/**
 * build a SkeinProfileGossipTestBridge, wiring `mergeGossipDigestProfiles()`
 * onto `protocol.onGossipDigest` and exposing a manual send method that
 * mirrors `computeAndSendGossipDigest()`'s profile-gathering logic in
 * `friendz-wiring.ts` (that function isn't exported standalone — it's a
 * closure inside `initFriendzWiring()` — so this rebuilds just the
 * profiles-array-gathering half here, same reasoning
 * `sendKnocksGossipDigest` above already established for pending knocks).
 */
export function buildProfileGossipTestBridge(options: {
  protocol: FriendzProtocol;
  repo: Repo;
  profileStore: ProfileStore;
  localNodeId: string;
}): SkeinProfileGossipTestBridge {
  const { protocol, repo, profileStore, localNodeId } = options;
  const relayedProfiles: ProfileRelayInfo[] = [];

  const socialState: SocialState = { friends: [] } as unknown as SocialState;
  const socialDoc: SocialDoc = {
    get current() {
      return socialState;
    },
    change(fn) {
      fn(socialState);
    },
    on() {
      return () => {};
    },
  };

  protocol.onGossipDigest = (msg, fromNodeId) => {
    mergeGossipDigestProfiles(repo, socialDoc, msg, fromNodeId, (info) =>
      relayedProfiles.push(info)
    ).catch(() => {
      // best effort — logged inside mergeGossipDigestProfiles already
    });
  };

  return {
    getMyProfileDocId() {
      return profileStore.handle.documentId;
    },

    setMyProfile(username, bio) {
      profileStore.setUsername(username);
      profileStore.setBio(bio);
    },

    addFriend(peerNodeId) {
      socialDoc.change((draft: any) => {
        if (!draft.friends) draft.friends = [];
        draft.friends.push({
          id: crypto.randomUUID(),
          alias: "",
          username: "",
          group: "",
          nodeIds: [
            {
              nodeId: peerNodeId,
              addedAt: new Date().toISOString(),
              lastSeenAt: "",
              username: "",
              bio: "",
              avatarDataUrl: "",
              profileDocId: "",
              profileUpdatedAt: "",
            },
          ],
          createdAt: new Date().toISOString(),
          isHub: false,
        });
      });
    },

    getKnownProfilePointer(peerNodeId) {
      for (const friend of socialState.friends ?? []) {
        for (const n of friend.nodeIds ?? []) {
          if (n.nodeId === peerNodeId && n.profileDocId) {
            return { profileDocId: n.profileDocId, updatedAt: n.profileUpdatedAt ?? "" };
          }
        }
      }
      return null;
    },

    getRelayedProfiles() {
      return [...relayedProfiles];
    },

    async sendProfileGossipDigest(peerNodeId) {
      const profiles: Array<{ peerNodeId: string; profileDocId: string; updatedAt: string }> = [];

      const myUpdatedAt = profileStore.updatedAt();
      profiles.push({
        peerNodeId: localNodeId,
        profileDocId: profileStore.handle.documentId,
        updatedAt: myUpdatedAt,
      });

      for (const friend of socialState.friends ?? []) {
        for (const n of friend.nodeIds ?? []) {
          if (!n.profileDocId) continue;
          if (n.nodeId === peerNodeId) continue;
          profiles.push({
            peerNodeId: n.nodeId,
            profileDocId: n.profileDocId,
            updatedAt: n.profileUpdatedAt ?? "",
          });
        }
      }

      await protocol.sendGossipDigest(peerNodeId, {
        canvasUpdates: [],
        pendingInvites: [],
        pendingKnocks: [],
        profiles,
      });
    },

    async readProfileDoc(profileDocId) {
      try {
        const handle = await repo.find(profileDocId as DocumentId);
        const doc = handle.doc() as { username?: string; bio?: string } | undefined;
        if (!doc) return null;
        return { username: doc.username ?? "", bio: doc.bio ?? "" };
      } catch {
        return null;
      }
    },
  };
}

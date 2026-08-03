// ---------------------------------------------------------------------------
// hub profile panel — standalone remote hub administration UI.
//
// docs/hub-and-profile-plan.md section 5: an admin friend of a hub can
// remotely view/allow/remove the hub's friendz list and view (read-only)
// its pending knocks, over the production `hub-admin-client.ts` client.
//
// deliberately standalone — does not import from or modify
// `friends-tab.ts`. wiring `mountHubProfilePanel()` into the friend-detail
// view is a small, separate follow-up step (see the plan doc's phased
// order), not done here.
//
// matches the visual conventions already established by the other narthex
// social tabs (`friends-tab.ts`, `requests-tab.ts`, `settings-tab.ts`):
// same fonts/colors/row heights from `./constants.ts`, same row/button
// building style.
// ---------------------------------------------------------------------------

import { Assets, Container, Graphics, Rectangle, Sprite, Text } from "pixi.js";
import { ScrollBox } from "@pixi/ui";
import { log } from "@freqhole/reliquary/utils";
import { formatFileSize } from "../../../src/widgets/format";
import {
  type HubAdminClient,
  type HubAdminFriendSummary,
  type HubAdminPendingKnockSummary,
  type HubAdminDiskUsage,
  type HubAdminCanvasUsageSummary,
  type HubAdminBlobUsageSummary,
  type HubAdminSoftDeletedBlob,
  type HubAdminHubProfile,
} from "../../../src/p2p/hub-admin-client";
import { createSkeinInput, type SkeinInputHandle } from "../../../src/widgets/skein-input";
import { pickImageAsDataUrl } from "@freqhole/reliquary/utils";
import { colorForName, isValidNodeId, truncate } from "./helpers";
import {
  ACCENT,
  BG,
  BORDER,
  BUTTON_RADIUS,
  COLOR_DOT_GAP,
  COLOR_DOT_RADIUS,
  COLOR_PALETTE,
  COLOR_RING_INSET,
  FIELD_HEIGHT,
  FONT,
  LABEL_COLOR,
  LABEL_SIZE,
  MUTED_TEXT,
  ONLINE_COLOR,
  PADDING_X,
  REJECT_COLOR,
  RESOLUTION,
  ROW_ALT_BG,
  ROW_AVATAR_SIZE,
  ROW_PADDING_X,
  TEXT_COLOR,
  TEXT_SIZE,
} from "./constants";

const TAG = "social.hub-profile-panel";

// ---------------------------------------------------------------------------
// local layout constants
// ---------------------------------------------------------------------------

// friend row is taller than the original 40px to fit an avatar, username,
// truncated bio, and a row of compact action buttons (block/admin/remove).
const FRIEND_ROW_HEIGHT = 84;
const KNOCK_ROW_HEIGHT = 68;
const SECTION_GAP = 18;
const REMOVE_BTN_W = 52;
const BLOCK_BTN_W = 52;
const ADMIN_BTN_W = 56;
const ACCEPT_BTN_W = 56;
const APPROVE_KNOCK_BTN_W = 60;
const DECLINE_KNOCK_BTN_W = 60;
/** role granted when a pending knock is approved from this panel — matches
 *  the default role used elsewhere for a hub-driven grant (e.g. the invite
 *  flow's default role). knocks don't carry a role request of their own, so
 *  there's nothing more specific to honor here. */
const KNOCK_APPROVE_ROLE = "member";
const ACTION_BTN_H = 20;
const ACTION_BTN_GAP = 6;
const COPY_BTN_FEEDBACK_MS = 1500;
const ALLOW_BTN_W = 70;
const CANVAS_ROW_HEIGHT = 36;
const BLOB_ROW_HEIGHT = 28;
const CONFIRM_TIMEOUT_MS = 5000;
const BLOB_PAGE_SIZE = 10;
const UNSYNC_BTN_W = 64;
const SECTION_HEADER_H = 26;
const HUB_PROFILE_AVATAR_SIZE = 28;

// ---------------------------------------------------------------------------
// section accordion
// ---------------------------------------------------------------------------

type SectionId = "profile" | "friendz" | "knocks" | "canvases" | "blobs" | "softDeleted";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface HubProfilePanelOptions {
  /** the hub's iroh node id this panel administers. */
  hubNodeId: string;
  /**
   * bound hub-admin-client — e.g.
   * `createHubAdminClient(hubAdminTransportFromAdapter(adapter))`. this
   * panel never constructs its own transport/client, so callers (and
   * tests) can inject any client implementation.
   */
  client: HubAdminClient;
  /** the canvas DOM element — needed by the "allow" field's DOM input overlay. */
  canvasElement: HTMLCanvasElement;
}

/**
 * plain-data snapshot of the panel's current render state — useful for
 * tests/introspection without reaching into pixi internals.
 */
export type HubProfilePanelState =
  | { status: "loading" }
  | { status: "notAdmin" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      friends: HubAdminFriendSummary[];
      pendingKnocks: HubAdminPendingKnockSummary[];
      diskUsage: HubAdminDiskUsage | null;
    };

/** pagination state snapshot exposed via test hooks. */
export interface HubProfilePageState {
  page: number;
  pageCount: number;
  total: number;
}

export interface HubProfilePanelHandle {
  /** the pixi container this panel's content was mounted into (same as the `container` argument). */
  container: Container;
  /** re-layout within the given content bounds (width x height). */
  layout(width: number, height: number): void;
  /** re-fetch friendz + pending knocks from the hub. called automatically on mount. */
  refresh(): Promise<void>;
  /** current render state — see `HubProfilePanelState`. */
  getState(): HubProfilePanelState;
  // -- pagination state / positions --
  getBlobPageState(): HubProfilePageState;
  getSoftDeletedPageState(): HubProfilePageState;
  getCanvasPageState(): HubProfilePageState;
  getBlobPrevButtonGlobalPos(): { x: number; y: number } | null;
  getBlobNextButtonGlobalPos(): { x: number; y: number } | null;
  getSoftDeletedPrevButtonGlobalPos(): { x: number; y: number } | null;
  getSoftDeletedNextButtonGlobalPos(): { x: number; y: number } | null;
  getCanvasPrevButtonGlobalPos(): { x: number; y: number } | null;
  getCanvasNextButtonGlobalPos(): { x: number; y: number } | null;
  // -- un-sync --
  getUnsyncButtonGlobalPos(canvasDocId: string): { x: number; y: number } | null;
  /** dev/test-only: current scroll offset + content/viewport heights — lets
   *  e2e drive a real mouse wheel over the panel and assert scrolling works. */
  getScrollState(): { scrollY: number; totalHeight: number; areaHeight: number };
  /** dev/test-only: global center position of the panel's visible area. */
  getPanelGlobalPos(): { x: number; y: number };
  /**
   * dev/test-only: global (screen-space) center position of the "allow"
   * input field, or null if the panel isn't currently in its "ready" state
   * (the allow section only renders then). lets e2e tests drive a real
   * `page.mouse.click()` + `page.keyboard.type()` through the actual DOM
   * input overlay this field creates on click — same `getGlobalPosition()`-
   * based precedent as `messagez-widget.ts`'s `getKnockActionGlobalPos()`.
   */
  getAllowInputGlobalPos(): { x: number; y: number } | null;
  /** dev/test-only: global center position of the "allow" button, or null
   *  if not currently rendered. */
  getAllowButtonGlobalPos(): { x: number; y: number } | null;
  /** dev/test-only: global center position of a friend row's "remove"
   *  button, by that friend's node id, or null if that row isn't currently
   *  rendered (not in the friendz list, or the panel isn't ready). */
  getRemoveButtonGlobalPos(nodeId: string): { x: number; y: number } | null;
  /** dev/test-only: global center position of a friend row's "block"/
   *  "unblock" button, by that friend's node id, or null if not rendered. */
  getBlockButtonGlobalPos(nodeId: string): { x: number; y: number } | null;
  /** dev/test-only: global center position of a friend row's admin
   *  toggle ("+admin"/"-admin") button, by that friend's node id, or null
   *  if not rendered. */
  getAdminButtonGlobalPos(nodeId: string): { x: number; y: number } | null;
  /** dev/test-only: global center position of a pending friend row's
   *  "accept" button, by that friend's node id, or null if not rendered
   *  (only pending-status rows render this button). */
  getAcceptFriendButtonGlobalPos(nodeId: string): { x: number; y: number } | null;
  /** dev/test-only: global center position of a pending knock row's
   *  "approve" button, keyed by canvas doc id + requester node id, or null
   *  if not rendered. */
  getApproveKnockButtonGlobalPos(canvasDocId: string, requesterNodeId: string): { x: number; y: number } | null;
  /** dev/test-only: global center position of a pending knock row's
   *  "decline" button, keyed by canvas doc id + requester node id, or null
   *  if not rendered. */
  getDeclineKnockButtonGlobalPos(canvasDocId: string, requesterNodeId: string): { x: number; y: number } | null;
  /** dev/test-only: global center position of a friend row's "copy" (node
   *  id to clipboard) button, by that friend's node id, or null if not
   *  rendered. */
  getCopyButtonGlobalPos(nodeId: string): { x: number; y: number } | null;
  /** whether a named section is currently collapsed. */
  getSectionCollapsed(sectionId: string): boolean;
  /** toggle a named section's collapsed state, triggering lazy loads if expanding. */
  toggleSection(sectionId: string): void;
  /** the hub's own profile after the hub-profile section loads, or null. */
  getHubProfileState(): HubAdminHubProfile | null;
  /** per-canvas blob data after the nested blob rows have loaded, or null. */
  getCanvasBlobsState(canvasDocId: string): { rows: HubAdminBlobUsageSummary[]; total: number; page: number } | null;
  /** tear down all resources (event listeners, DOM overlays, textures). */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

export function mountHubProfilePanel(
  container: Container,
  opts: HubProfilePanelOptions
): HubProfilePanelHandle {
  const { hubNodeId, client, canvasElement } = opts;

  let state: HubProfilePanelState = { status: "loading" };
  let destroyed = false;
  let currentWidth = 0;
  let totalHeight = 0;
  let areaHeight = 0;

  let allowInputHandle: SkeinInputHandle | null = null;
  let allowFeedback = "";
  let allowInFlight = false;
  const removeInFlight = new Set<string>();
  const blockInFlight = new Set<string>();
  const promoteInFlight = new Set<string>();
  const acceptFriendInFlight = new Set<string>();
  /** keyed by `${canvasDocId}::${requesterNodeId}` — one outstanding
   *  approve/decline at a time per pending knock. */
  const knockDecisionInFlight = new Set<string>();

  // accordion collapsed state (module-lifetime, survives refresh())
  // defaults: friendz expanded; everything else collapsed.
  const sectionCollapsed = new Map<SectionId, boolean>([
    ["profile", true],
    ["friendz", false],
    ["knocks", true],
    ["canvases", true],
    ["blobs", true],
    ["softDeleted", true],
  ]);

  // blob / soft-deleted section state (lazy-loaded on demand)
  type BlobSectionState = "idle" | "loading" | "loaded" | "error";
  let blobState: BlobSectionState = "idle";
  let blobRows: HubAdminBlobUsageSummary[] = [];
  let blobTotal = 0;
  let blobPage = 0;
  let softDeletedRows: HubAdminSoftDeletedBlob[] = [];
  let softDeletedTotal = 0;
  let softDeletedPage = 0;
  let blobErrorMsg: string | null = null;
  let blobDeleteFailures: string[] = [];
  let softDeleteInFlight = false;
  let restoreInFlight = false;
  let hardDeleteInFlight = false;
  let confirmHardDeleteAll = false;
  let confirmHardDeleteAllTimer: ReturnType<typeof setTimeout> | null = null;

  // canvas section state (lazy-loaded on demand)
  let canvasState: BlobSectionState = "idle";
  let canvasRows: HubAdminCanvasUsageSummary[] = [];
  let canvasTotal = 0;
  let canvasPage = 0;
  let canvasErrorMsg: string | null = null;

  // hub profile section state (lazy-loaded on first expand)
  type HubProfileSectionState = "idle" | "loading" | "loaded" | "error";
  let hubProfileSectionState: HubProfileSectionState = "idle";
  let hubProfileData: HubAdminHubProfile | null = null;
  let hubProfileErrorMsg: string | null = null;
  let hubProfileInFlight = false;
  let hubProfileUsernameHandle: SkeinInputHandle | null = null;
  let hubProfileBioHandle: SkeinInputHandle | null = null;

  // per-canvas blob expansion + data (keyed by canvasDocId)
  const canvasBlobsExpanded = new Set<string>();
  const canvasBlobsData = new Map<string, { rows: HubAdminBlobUsageSummary[]; total: number; page: number }>();
  const canvasBlobsState = new Map<string, "idle" | "loading" | "loaded" | "error">();

  // un-sync confirm state
  let confirmUnsyncCanvas: string | null = null;
  let confirmUnsyncTimer: ReturnType<typeof setTimeout> | null = null;
  let unsyncInFlight = false;
  let unsyncSweptMsg: string | null = null;

  // dev/test-only refs to rendered buttons
  let allowButtonRef: Container | null = null;
  const removeButtonRefs = new Map<string, Container>();
  const blockButtonRefs = new Map<string, Container>();
  const adminButtonRefs = new Map<string, Container>();
  const acceptFriendButtonRefs = new Map<string, Container>();
  const approveKnockButtonRefs = new Map<string, Container>();
  const declineKnockButtonRefs = new Map<string, Container>();
  const copyButtonRefs = new Map<string, Container>();
  let blobPrevBtnRef: Container | null = null;
  let blobNextBtnRef: Container | null = null;
  let softDeletedPrevBtnRef: Container | null = null;
  let softDeletedNextBtnRef: Container | null = null;
  let canvasPrevBtnRef: Container | null = null;
  let canvasNextBtnRef: Container | null = null;
  const unsyncButtonRefs = new Map<string, Container>();

  function globalCenter(c: Container): { x: number; y: number } {
    const pos = c.getGlobalPosition();
    return { x: pos.x + c.width / 2, y: pos.y + c.height / 2 };
  }

  // -- scaffolding: @pixi/ui ScrollBox --------------------------------------
  //
  // the panel went through THREE hand-rolled scroll attempts (pixi wheel
  // events on the container, an explicit hitArea, a native capture-phase
  // listener) and none of them scrolled reliably in production — pixi wheel
  // dispatch depends on hit-testing an interactive object under the pointer,
  // and the canvas viewport's own native wheel handler pans the world for
  // anything that falls through. ScrollBox solves the whole class of
  // problems: it listens for wheel on `document` in the CAPTURE phase (runs
  // before pixi's dispatcher and the viewport's listener), gates on its own
  // `isOver` state (tracked via its full-size background hit area), masks
  // its content, and gives drag-to-scroll for free.
  //
  // the thin canvas-level capture listener below exists ONLY to set the
  // `_skeinWidgetScroll` flag so viewport.ts skips panning while the pointer
  // is over the overflowing panel — the actual scrolling is ScrollBox's.

  // ordering matters, twice over:
  //
  // 1. the viewport's pan handler lives on the canvas ELEMENT — the wheel
  //    event's TARGET. at the target node capture-flag doesn't jump the
  //    queue (registration order rules), and the viewport registered at
  //    app boot, long before this panel mounts — so a flag-setter on the
  //    canvas element always ran too late and the world panned anyway.
  //    `document` is a genuine ancestor: its capture phase runs before ANY
  //    target listener, no ordering games.
  // 2. ScrollBox gates its own document-capture wheel handler on `isOver`,
  //    which pixi only flips on a `pointerover` crossing — when the pointer
  //    is ALREADY over the panel as it mounts (it always is: the user just
  //    clicked "manage hub" right there), the panel can stay isOver=false
  //    until the pointer leaves and re-enters (tab-away/refocus also
  //    re-arms it, which is how this bug hid). registering THIS listener
  //    BEFORE constructing the ScrollBox means it runs first within the
  //    document capture phase and primes `isOver` from real bounds before
  //    ScrollBox's handler checks it.
  let scrollBoxRef: ScrollBox | null = null;
  const onNativeWheel = (e: WheelEvent) => {
    if (destroyed || !scrollBoxRef) return;
    for (let node: Container | null = scrollBoxRef; node; node = node.parent) {
      if (!node.visible) return;
    }
    // pixi is configured with autoDensity, so global stage coords are CSS
    // pixels — clientX/Y relative to the canvas rect maps 1:1
    const rect = canvasElement.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const g = scrollBoxRef.getGlobalPosition();
    const inside = px >= g.x && px <= g.x + currentWidth && py >= g.y && py <= g.y + areaHeight;
    // prime/correct ScrollBox's isOver (its handler runs right after this
    // one in the same capture phase), and flag the event so viewport.ts's
    // pan handler leaves it alone. the flag is set for ANY wheel over the
    // visible panel — even when the content is short enough not to scroll,
    // the canvas world must not pan underneath the panel.
    (scrollBoxRef as unknown as { isOver: boolean }).isOver = inside;
    if (inside) {
      (e as { _skeinWidgetScroll?: boolean } & WheelEvent)._skeinWidgetScroll = true;
    }
  };
  document.addEventListener("wheel", onNativeWheel, { capture: true, passive: true });

  const scrollBox = new ScrollBox({
    width: 10,
    height: 10,
    background: BG,
    globalScroll: false,
    disableEasing: true,
  });
  scrollBoxRef = scrollBox;
  container.addChild(scrollBox);

  const inner = new Container();
  inner.eventMode = "static";
  // explicit sizing rect: gives `inner` real, deterministic bounds so
  // ScrollBox's List can measure it (a bounds-less container triggers its
  // "ScrollBox item should have size" warning and measures 0), and doubles
  // as the full-content hit surface for isOver/drag over text and gaps.
  // redrawn to currentWidth × contentHeight in finishLayout.
  const innerSizingRect = new Graphics();
  innerSizingRect.rect(0, 0, 1, 1);
  innerSizingRect.fill({ color: 0x000000, alpha: 0.0001 });
  inner.addChild(innerSizingRect);
  scrollBox.addItem(inner);

  // -- data fetch --------------------------------------------------------

  async function refresh(): Promise<void> {
    state = { status: "loading" };
    rebuild();

    let listResponse;
    let knocksResponse;
    let diskRes: { kind: string; usage?: HubAdminDiskUsage } | null = null;
    try {
      [listResponse, knocksResponse, diskRes] = await Promise.all([
        client.hubAdminList(hubNodeId),
        client.hubAdminListPendingKnocks(hubNodeId),
        client.hubAdminDiskUsage(hubNodeId).catch((e: unknown) => {
          log.warn(TAG, "disk usage fetch failed:", e);
          return null;
        }),
      ]);
    } catch (err) {
      log.warn(TAG, "hub admin request failed:", err);
      if (destroyed) return;
      state = { status: "error", message: (err as Error)?.message ?? String(err) };
      rebuild();
      return;
    }
    if (destroyed) return;

    // the hub-admin protocol rejects a non-admin caller with NotAdmin on
    // every request kind (see hub_admin.rs's handle_request — the adminz
    // check runs before dispatching to any variant), so either response
    // being notAdmin means the local peer just isn't a recognized admin of
    // this hub — show a simple "not an admin" state rather than rendering
    // partial/empty lists or a raw protocol error.
    if (listResponse.kind === "notAdmin" || knocksResponse.kind === "notAdmin") {
      state = { status: "notAdmin" };
      rebuild();
      return;
    }
    if (listResponse.kind === "error") {
      state = { status: "error", message: listResponse.message };
      rebuild();
      return;
    }
    if (knocksResponse.kind === "error") {
      state = { status: "error", message: knocksResponse.message };
      rebuild();
      return;
    }
    if (listResponse.kind !== "list" || knocksResponse.kind !== "pendingKnocks") {
      state = {
        status: "error",
        message: `unexpected response shape (list: ${listResponse.kind}, knocks: ${knocksResponse.kind})`,
      };
      rebuild();
      return;
    }

    state = {
      status: "ready",
      friends: listResponse.friends,
      pendingKnocks: knocksResponse.knocks,
      diskUsage: diskRes?.kind === "diskUsage" ? (diskRes.usage ?? null) : null,
    };
    // reset blob + canvas sections so they reload on the next expand
    blobState = "idle";
    blobRows = [];
    blobTotal = 0;
    blobPage = 0;
    softDeletedRows = [];
    softDeletedTotal = 0;
    softDeletedPage = 0;
    blobErrorMsg = null;
    blobDeleteFailures = [];
    canvasState = "idle";
    canvasRows = [];
    canvasTotal = 0;
    canvasPage = 0;
    canvasErrorMsg = null;
    unsyncSweptMsg = null;
    // reset hub profile section
    hubProfileSectionState = "idle";
    hubProfileData = null;
    hubProfileErrorMsg = null;
    // reset canvas blobs (per-canvas data is stale after hub data changes)
    canvasBlobsData.clear();
    canvasBlobsState.clear();
    // trigger lazy loads for any sections that are currently expanded
    if (!(sectionCollapsed.get("canvases") ?? true)) loadCanvases().catch(() => {});
    if (!(sectionCollapsed.get("blobs") ?? true) || !(sectionCollapsed.get("softDeleted") ?? true)) loadBlobs().catch(() => {});
    if (!(sectionCollapsed.get("profile") ?? true)) loadHubProfile().catch(() => {});
    rebuild();
  }

  // -- actions -------------------------------------------------------------

  async function handleAllow(nodeId: string): Promise<void> {
    if (allowInFlight) return;
    if (!isValidNodeId(nodeId)) {
      allowFeedback = "not a valid node id";
      rebuild();
      return;
    }
    allowInFlight = true;
    allowFeedback = "";
    rebuild();
    try {
      const response = await client.hubAdminAllow(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        allowFeedback = response.message;
        return;
      }
      if (allowInputHandle) allowInputHandle.value = "";
      allowFeedback = "";
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminAllow failed:", err);
      if (!destroyed) allowFeedback = (err as Error)?.message ?? String(err);
    } finally {
      allowInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  async function handleRemove(nodeId: string): Promise<void> {
    if (removeInFlight.has(nodeId)) return;
    removeInFlight.add(nodeId);
    rebuild();
    try {
      const response = await client.hubAdminRemove(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminRemove failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminRemove failed:", err);
    } finally {
      removeInFlight.delete(nodeId);
      if (!destroyed) rebuild();
    }
  }

  async function handleBlock(nodeId: string): Promise<void> {
    if (blockInFlight.has(nodeId)) return;
    blockInFlight.add(nodeId);
    rebuild();
    try {
      const response = await client.hubAdminBlock(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminBlock failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminBlock failed:", err);
    } finally {
      blockInFlight.delete(nodeId);
      if (!destroyed) rebuild();
    }
  }

  /** "unblock" is just `hubAdminAllow` again — reuses the same wire request
   *  as the manual allow-a-node-id flow, but bypasses `handleAllow()`'s
   *  input-validation/feedback-text logic (which is specific to that flow,
   *  not this one). */
  async function handleUnblock(nodeId: string): Promise<void> {
    if (blockInFlight.has(nodeId)) return;
    blockInFlight.add(nodeId);
    rebuild();
    try {
      const response = await client.hubAdminAllow(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminAllow (unblock) failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminAllow (unblock) failed:", err);
    } finally {
      blockInFlight.delete(nodeId);
      if (!destroyed) rebuild();
    }
  }

  async function handlePromoteAdmin(nodeId: string): Promise<void> {
    if (promoteInFlight.has(nodeId)) return;
    promoteInFlight.add(nodeId);
    rebuild();
    try {
      const response = await client.hubAdminPromoteAdmin(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminPromoteAdmin failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminPromoteAdmin failed:", err);
    } finally {
      promoteInFlight.delete(nodeId);
      if (!destroyed) rebuild();
    }
  }

  async function handleDemoteAdmin(nodeId: string): Promise<void> {
    if (promoteInFlight.has(nodeId)) return;
    promoteInFlight.add(nodeId);
    rebuild();
    try {
      const response = await client.hubAdminDemoteAdmin(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminDemoteAdmin failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminDemoteAdmin failed:", err);
    } finally {
      promoteInFlight.delete(nodeId);
      if (!destroyed) rebuild();
    }
  }

  /** accept an incoming friend request: a "pending" row is an inbound
   *  friend request awaiting operator action (see `FriendStatus::Pending`
   *  in `friendz.rs`) \u2014 promoting it is the exact same wire request as the
   *  manual allow/unblock flows, so this just reuses `hubAdminAllow`. */
  async function handleAcceptFriendRequest(nodeId: string): Promise<void> {
    if (acceptFriendInFlight.has(nodeId)) return;
    acceptFriendInFlight.add(nodeId);
    rebuild();
    try {
      const response = await client.hubAdminAllow(hubNodeId, nodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminAllow (accept friend request) failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminAllow (accept friend request) failed:", err);
    } finally {
      acceptFriendInFlight.delete(nodeId);
      if (!destroyed) rebuild();
    }
  }

  async function handleApproveKnock(canvasDocId: string, requesterNodeId: string): Promise<void> {
    const key = `${canvasDocId}::${requesterNodeId}`;
    if (knockDecisionInFlight.has(key)) return;
    knockDecisionInFlight.add(key);
    rebuild();
    try {
      const response = await client.hubAdminApproveKnock(
        hubNodeId,
        canvasDocId,
        requesterNodeId,
        KNOCK_APPROVE_ROLE
      );
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminApproveKnock failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminApproveKnock failed:", err);
    } finally {
      knockDecisionInFlight.delete(key);
      if (!destroyed) rebuild();
    }
  }

  async function handleDeclineKnock(canvasDocId: string, requesterNodeId: string): Promise<void> {
    const key = `${canvasDocId}::${requesterNodeId}`;
    if (knockDecisionInFlight.has(key)) return;
    knockDecisionInFlight.add(key);
    rebuild();
    try {
      const response = await client.hubAdminDeclineKnock(hubNodeId, canvasDocId, requesterNodeId);
      if (destroyed) return;
      if (response.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (response.kind === "error") {
        log.warn(TAG, "hubAdminDeclineKnock failed:", response.message);
        return;
      }
      await refresh();
    } catch (err) {
      log.warn(TAG, "hubAdminDeclineKnock failed:", err);
    } finally {
      knockDecisionInFlight.delete(key);
      if (!destroyed) rebuild();
    }
  }

  // -- hub profile section actions -------------------------------------------

  async function loadHubProfile(): Promise<void> {
    hubProfileSectionState = "loading";
    hubProfileErrorMsg = null;
    rebuild();
    try {
      const res = await client.hubAdminGetProfile(hubNodeId);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (res.kind !== "hubProfile") {
        hubProfileSectionState = "error";
        hubProfileErrorMsg = `unexpected response: ${res.kind}`;
        rebuild();
        return;
      }
      hubProfileData = res.profile;
      hubProfileSectionState = "loaded";
      rebuild();
    } catch (err) {
      log.warn(TAG, "loadHubProfile failed:", err);
      if (destroyed) return;
      hubProfileSectionState = "error";
      hubProfileErrorMsg = (err as Error)?.message ?? String(err);
      rebuild();
    }
  }

  async function handleSetHubProfile(opts: {
    username?: string | null;
    bio?: string | null;
    accentColor?: number | null;
  }): Promise<void> {
    if (hubProfileInFlight) return;
    hubProfileInFlight = true;
    rebuild();
    try {
      const res = await client.hubAdminSetProfile(hubNodeId, opts);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (res.kind === "hubProfile") {
        hubProfileData = res.profile;
        hubProfileSectionState = "loaded";
      } else {
        log.warn(TAG, "hubAdminSetProfile unexpected response:", res.kind);
      }
      rebuild();
    } catch (err) {
      log.warn(TAG, "hubAdminSetProfile failed:", err);
    } finally {
      hubProfileInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  async function handleSetHubAvatar(imageBase64: string): Promise<void> {
    if (hubProfileInFlight) return;
    hubProfileInFlight = true;
    rebuild();
    try {
      const res = await client.hubAdminSetAvatar(hubNodeId, imageBase64);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (res.kind === "hubProfile") {
        hubProfileData = res.profile;
        hubProfileSectionState = "loaded";
      } else {
        log.warn(TAG, "hubAdminSetAvatar unexpected response:", res.kind);
      }
      rebuild();
    } catch (err) {
      log.warn(TAG, "hubAdminSetAvatar failed:", err);
    } finally {
      hubProfileInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  // -- per-canvas blob actions -----------------------------------------------

  async function loadCanvasBlobs(canvasDocId: string, page = 0): Promise<void> {
    canvasBlobsState.set(canvasDocId, "loading");
    rebuild();
    try {
      const res = await client.hubAdminCanvasBlobs(hubNodeId, canvasDocId, page * BLOB_PAGE_SIZE, BLOB_PAGE_SIZE);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (res.kind !== "canvasBlobs") {
        canvasBlobsState.set(canvasDocId, "error");
        rebuild();
        return;
      }
      canvasBlobsData.set(canvasDocId, { rows: res.blobs, total: res.total, page });
      canvasBlobsState.set(canvasDocId, "loaded");
      rebuild();
    } catch (err) {
      log.warn(TAG, "loadCanvasBlobs failed:", err);
      if (destroyed) return;
      canvasBlobsState.set(canvasDocId, "error");
      rebuild();
    }
  }

  // -- accordion toggle helper -----------------------------------------------

  function toggleSectionAndLoad(sectionId: SectionId): void {
    const wasCollapsed = sectionCollapsed.get(sectionId) ?? false;
    sectionCollapsed.set(sectionId, !wasCollapsed);
    if (wasCollapsed) {
      // expanding: trigger lazy loads if state is still idle
      if (sectionId === "canvases" && canvasState === "idle") {
        loadCanvases().catch(() => {});
      } else if ((sectionId === "blobs" || sectionId === "softDeleted") && blobState === "idle") {
        loadBlobs().catch(() => {});
      } else if (sectionId === "profile" && hubProfileSectionState === "idle") {
        loadHubProfile().catch(() => {});
      }
    }
    rebuild();
  }

  // -- blob section actions --------------------------------------------------

  async function loadBlobs(): Promise<void> {
    blobState = "loading";
    blobErrorMsg = null;
    blobDeleteFailures = [];
    rebuild();
    try {
      const [blobRes, softDeletedRes] = await Promise.all([
        client.hubAdminBlobUsage(hubNodeId, blobPage * BLOB_PAGE_SIZE, BLOB_PAGE_SIZE),
        client.hubAdminListSoftDeleted(hubNodeId, softDeletedPage * BLOB_PAGE_SIZE, BLOB_PAGE_SIZE),
      ]);
      if (destroyed) return;
      if (blobRes.kind === "notAdmin" || softDeletedRes.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (blobRes.kind !== "blobUsage") {
        blobState = "error";
        blobErrorMsg = `unexpected response: ${blobRes.kind}`;
        rebuild();
        return;
      }
      if (softDeletedRes.kind !== "softDeleted") {
        blobState = "error";
        blobErrorMsg = `unexpected response: ${softDeletedRes.kind}`;
        rebuild();
        return;
      }
      blobRows = blobRes.blobs;
      blobTotal = blobRes.total;
      softDeletedRows = softDeletedRes.blobs;
      softDeletedTotal = softDeletedRes.total;
      blobState = "loaded";
      rebuild();
    } catch (err) {
      log.warn(TAG, "loadBlobs failed:", err);
      if (destroyed) return;
      blobState = "error";
      blobErrorMsg = (err as Error)?.message ?? String(err);
      rebuild();
    }
  }

  async function loadCanvases(): Promise<void> {
    canvasState = "loading";
    canvasErrorMsg = null;
    rebuild();
    try {
      const res = await client.hubAdminCanvasUsage(hubNodeId, canvasPage * BLOB_PAGE_SIZE, BLOB_PAGE_SIZE);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (res.kind !== "canvasUsage") {
        canvasState = "error";
        canvasErrorMsg = `unexpected response: ${res.kind}`;
        rebuild();
        return;
      }
      canvasRows = res.canvases;
      canvasTotal = res.total;
      canvasState = "loaded";
      rebuild();
    } catch (err) {
      log.warn(TAG, "loadCanvases failed:", err);
      if (destroyed) return;
      canvasState = "error";
      canvasErrorMsg = (err as Error)?.message ?? String(err);
      rebuild();
    }
  }

  async function refreshAfterBlobMutation(): Promise<void> {
    if (state.status === "ready") {
      try {
        const diskRes = await client.hubAdminDiskUsage(hubNodeId);
        if (!destroyed && state.status === "ready" && diskRes.kind === "diskUsage") {
          state = { ...state, diskUsage: diskRes.usage };
        }
      } catch (err) {
        log.warn(TAG, "disk usage refresh failed:", err);
      }
    }
    await Promise.all([loadBlobs(), loadCanvases()]);
  }

  function handleHardDeleteAllClick(): void {
    if (hardDeleteInFlight || softDeletedRows.length === 0) return;
    if (confirmHardDeleteAll) {
      if (confirmHardDeleteAllTimer !== null) {
        clearTimeout(confirmHardDeleteAllTimer);
        confirmHardDeleteAllTimer = null;
      }
      confirmHardDeleteAll = false;
      executeHardDeleteAll().catch(() => {});
    } else {
      confirmHardDeleteAll = true;
      rebuild();
      confirmHardDeleteAllTimer = setTimeout(() => {
        confirmHardDeleteAll = false;
        confirmHardDeleteAllTimer = null;
        if (!destroyed) rebuild();
      }, CONFIRM_TIMEOUT_MS);
    }
  }

  async function executeHardDeleteAll(): Promise<void> {
    if (hardDeleteInFlight) return;
    hardDeleteInFlight = true;
    rebuild();
    try {
      const res = await client.hubAdminHardDeleteBlobs(hubNodeId, [], true);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (res.kind === "blobsMutation") {
        blobDeleteFailures = res.failed;
      }
      await refreshAfterBlobMutation();
    } catch (err) {
      log.warn(TAG, "hardDeleteAllSoftDeleted failed:", err);
    } finally {
      hardDeleteInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  // -- per-row blob actions --

  async function handleSoftDeleteOne(blake3: string): Promise<void> {
    if (softDeleteInFlight) return;
    softDeleteInFlight = true;
    rebuild();
    try {
      const res = await client.hubAdminSoftDeleteBlobs(hubNodeId, [blake3]);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      await refreshAfterBlobMutation();
    } catch (err) {
      log.warn(TAG, "hubAdminSoftDeleteBlobs (one) failed:", err);
    } finally {
      softDeleteInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  async function handleRestoreOne(blake3: string): Promise<void> {
    if (restoreInFlight) return;
    restoreInFlight = true;
    rebuild();
    try {
      const res = await client.hubAdminRestoreBlobs(hubNodeId, [blake3]);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      await refreshAfterBlobMutation();
    } catch (err) {
      log.warn(TAG, "hubAdminRestoreBlobs (one) failed:", err);
    } finally {
      restoreInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  async function executeHardDeleteOne(blake3: string): Promise<void> {
    if (hardDeleteInFlight) return;
    hardDeleteInFlight = true;
    rebuild();
    try {
      const res = await client.hubAdminHardDeleteBlobs(hubNodeId, [blake3]);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (res.kind === "blobsMutation") {
        blobDeleteFailures = res.failed;
      }
      await refreshAfterBlobMutation();
    } catch (err) {
      log.warn(TAG, "hubAdminHardDeleteBlobs (one) failed:", err);
    } finally {
      hardDeleteInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  // -- canvas un-sync --------------------------------------------------------

  function handleUnsyncCanvasClick(canvasDocId: string): void {
    if (unsyncInFlight) return;
    if (confirmUnsyncCanvas === canvasDocId) {
      // second tap: confirm
      if (confirmUnsyncTimer !== null) {
        clearTimeout(confirmUnsyncTimer);
        confirmUnsyncTimer = null;
      }
      confirmUnsyncCanvas = null;
      executeUnsyncCanvas(canvasDocId).catch(() => {});
    } else {
      // first tap: arm
      if (confirmUnsyncTimer !== null) clearTimeout(confirmUnsyncTimer);
      confirmUnsyncCanvas = canvasDocId;
      rebuild();
      confirmUnsyncTimer = setTimeout(() => {
        confirmUnsyncCanvas = null;
        confirmUnsyncTimer = null;
        if (!destroyed) rebuild();
      }, CONFIRM_TIMEOUT_MS);
    }
  }

  async function executeUnsyncCanvas(canvasDocId: string): Promise<void> {
    if (unsyncInFlight) return;
    unsyncInFlight = true;
    rebuild();
    try {
      const res = await client.hubAdminUnsyncCanvas(hubNodeId, canvasDocId);
      if (destroyed) return;
      if (res.kind === "notAdmin") {
        state = { status: "notAdmin" };
        rebuild();
        return;
      }
      if (res.kind === "canvasUnsynced") {
        unsyncSweptMsg = `unsynced (${res.swept} blob${res.swept === 1 ? "" : "s"} swept)`;
      }
      blobPage = 0;
      softDeletedPage = 0;
      canvasPage = 0;
      await refreshAfterBlobMutation();
    } catch (err) {
      log.warn(TAG, "hubAdminUnsyncCanvas failed:", err);
    } finally {
      unsyncInFlight = false;
      if (!destroyed) rebuild();
    }
  }

  // -- pagination helpers ----------------------------------------------------

  function pageCount(total: number): number {
    return Math.max(1, Math.ceil(total / BLOB_PAGE_SIZE));
  }

  function buildPaginationRow(opts2: {
    page: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    prevRef: (c: Container | null) => void;
    nextRef: (c: Container | null) => void;
  }): { row: Container; height: number } {
    const pc = pageCount(opts2.total);
    const row = new Container();
    row.eventMode = "static";

    const PILL_W = 36;
    const PILL_H = 18;
    const GAP = 6;

    const prevBtn = buildOutlinedButton({
      label: "prev",
      width: PILL_W,
      height: PILL_H,
      color: ACCENT,
      disabled: opts2.page <= 0,
      onTap: opts2.onPrev,
    });
    opts2.prevRef(prevBtn);
    row.addChild(prevBtn);

    const label = new Text({
      text: `page ${opts2.page + 1}/${pc} (${opts2.total} total)`,
      style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    label.eventMode = "none";
    label.x = PILL_W + GAP;
    label.y = (PILL_H - label.height) / 2;
    row.addChild(label);

    const nextBtn = buildOutlinedButton({
      label: "next",
      width: PILL_W,
      height: PILL_H,
      color: ACCENT,
      disabled: opts2.page >= pc - 1,
      onTap: opts2.onNext,
    });
    nextBtn.x = PILL_W + GAP + label.width + GAP;
    opts2.nextRef(nextBtn);
    row.addChild(nextBtn);

    return { row, height: PILL_H + 4 };
  }

  // -- small button builder --------------------------------------------------

  function buildOutlinedButton(opts2: {
    label: string;
    width: number;
    height: number;
    color: number;
    disabled?: boolean;
    fillColor?: number;
    onTap: () => void;
  }): Container {
    const btn = new Container();
    btn.eventMode = opts2.disabled ? "none" : "static";
    btn.cursor = opts2.disabled ? "default" : "pointer";
    btn.hitArea = new Rectangle(0, 0, opts2.width, opts2.height);

    const bg = new Graphics();
    bg.eventMode = "none";
    bg.roundRect(0, 0, opts2.width, opts2.height, BUTTON_RADIUS);
    bg.fill({ color: opts2.fillColor ?? 0x111118 });
    bg.stroke({ color: opts2.fillColor ?? opts2.color, width: 1.5, alpha: opts2.disabled ? 0.4 : 1 });
    btn.addChild(bg);

    const label = new Text({
      text: opts2.label,
      style: { fontFamily: FONT, fontSize: 10, fill: opts2.fillColor !== undefined ? 0xffffff : opts2.color },
      resolution: RESOLUTION,
    });
    label.alpha = opts2.disabled ? 0.5 : 1;
    label.eventMode = "none";
    label.anchor.set(0.5);
    label.x = opts2.width / 2;
    label.y = opts2.height / 2;
    btn.addChild(label);

    if (!opts2.disabled) {
      btn.on("pointertap", (e) => {
        e.stopPropagation();
        opts2.onTap();
      });
    }

    return btn;
  }

  // -- rebuild ---------------------------------------------------------------

  function rebuild(): void {
    if (destroyed) return;

    allowButtonRef = null;
    removeButtonRefs.clear();
    blockButtonRefs.clear();
    adminButtonRefs.clear();
    copyButtonRefs.clear();
    acceptFriendButtonRefs.clear();
    approveKnockButtonRefs.clear();
    declineKnockButtonRefs.clear();
    unsyncButtonRefs.clear();
    blobPrevBtnRef = null;
    blobNextBtnRef = null;
    softDeletedPrevBtnRef = null;
    softDeletedNextBtnRef = null;
    canvasPrevBtnRef = null;
    canvasNextBtnRef = null;

    if (allowInputHandle) {
      allowInputHandle.destroy();
      allowInputHandle = null;
    }
    if (hubProfileUsernameHandle) {
      hubProfileUsernameHandle.destroy();
      hubProfileUsernameHandle = null;
    }
    if (hubProfileBioHandle) {
      hubProfileBioHandle.destroy();
      hubProfileBioHandle = null;
    }
    // clear everything EXCEPT the sizing rect (child 0) — it must survive
    // rebuilds so ScrollBox always has a measurable, hit-testable item
    while (inner.children.length > 1) {
      inner.removeChildAt(1).destroy({ children: true });
    }

    let dy = 0;

    // no header: the "hub friendz" title + hub node id line were dropped to
    // reclaim vertical space — the friend detail view the user came from
    // already identifies the hub, and the node id is copyable there.

    if (state.status === "loading") {
      const loadingText = new Text({
        text: "loading\u2026",
        style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      loadingText.eventMode = "none";
      loadingText.x = PADDING_X;
      loadingText.y = dy;
      inner.addChild(loadingText);
      dy += loadingText.height + SECTION_GAP;
      finishLayout(dy);
      return;
    }

    if (state.status === "notAdmin") {
      const notAdminText = new Text({
        text: "you're not an admin of this hub",
        style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      notAdminText.eventMode = "none";
      notAdminText.x = PADDING_X;
      notAdminText.y = dy;
      inner.addChild(notAdminText);
      dy += notAdminText.height + SECTION_GAP;
      finishLayout(dy);
      return;
    }

    if (state.status === "error") {
      const errorText = new Text({
        text: `couldn't reach the hub: ${state.message}`,
        style: {
          fontFamily: FONT,
          fontSize: TEXT_SIZE,
          fill: REJECT_COLOR,
          wordWrap: true,
          wordWrapWidth: Math.max(80, currentWidth - PADDING_X * 2),
        },
        resolution: RESOLUTION,
      });
      errorText.eventMode = "none";
      errorText.x = PADDING_X;
      errorText.y = dy;
      inner.addChild(errorText);
      dy += errorText.height + 10;

      const retryBtn = buildOutlinedButton({
        label: "retry",
        width: 60,
        height: 24,
        color: ACCENT,
        onTap: () => {
          refresh().catch(() => {});
        },
      });
      retryBtn.x = PADDING_X;
      retryBtn.y = dy;
      inner.addChild(retryBtn);
      dy += 24 + SECTION_GAP;
      finishLayout(dy);
      return;
    }

    // status === "ready" ------------------------------------------------

    const contentW = Math.max(0, currentWidth);

    // section header helper: adds a full-width ▸/▾ row to inner, advances dy
    function addSectionHeader(sectionId: SectionId, title: string, count: number | null): void {
      const collapsed = sectionCollapsed.get(sectionId) ?? false;
      const tri = collapsed ? "\u25b8" : "\u25be";
      const countSuffix = count !== null ? ` (${count})` : "";
      const hdr = new Container();
      hdr.eventMode = "static";
      hdr.cursor = "pointer";
      hdr.hitArea = new Rectangle(0, 0, contentW, SECTION_HEADER_H);
      hdr.y = dy;

      const triText = new Text({
        text: tri,
        style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: ACCENT },
        resolution: RESOLUTION,
      });
      triText.eventMode = "none";
      triText.x = PADDING_X;
      triText.y = Math.round((SECTION_HEADER_H - triText.height) / 2);
      hdr.addChild(triText);

      const titleText = new Text({
        text: `${title}${countSuffix}`,
        style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR, fontWeight: "bold" },
        resolution: RESOLUTION,
      });
      titleText.eventMode = "none";
      titleText.x = PADDING_X + triText.width + 5;
      titleText.y = Math.round((SECTION_HEADER_H - titleText.height) / 2);
      hdr.addChild(titleText);

      hdr.on("pointertap", (e) => {
        e.stopPropagation();
        toggleSectionAndLoad(sectionId);
      });
      inner.addChild(hdr);
      dy += SECTION_HEADER_H;
    }

    // ---- 1. hub profile section -----------------------------------------
    addSectionHeader("profile", "hub profile", null);
    if (!(sectionCollapsed.get("profile") ?? true)) {
      if (hubProfileSectionState === "idle" || hubProfileSectionState === "loading") {
        const t = new Text({
          text: "loading profile\u2026",
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        t.eventMode = "none";
        t.x = PADDING_X;
        t.y = dy;
        inner.addChild(t);
        dy += t.height + SECTION_GAP;
      } else if (hubProfileSectionState === "error") {
        const errText = new Text({
          text: hubProfileErrorMsg ? `profile load failed: ${hubProfileErrorMsg}` : "hub offline?",
          style: {
            fontFamily: FONT,
            fontSize: TEXT_SIZE,
            fill: REJECT_COLOR,
            wordWrap: true,
            wordWrapWidth: Math.max(80, contentW - PADDING_X * 2),
          },
          resolution: RESOLUTION,
        });
        errText.eventMode = "none";
        errText.x = PADDING_X;
        errText.y = dy;
        inner.addChild(errText);
        dy += errText.height + 6;
        const profRetryBtn = buildOutlinedButton({
          label: "retry",
          width: 60,
          height: 24,
          color: ACCENT,
          onTap: () => { loadHubProfile().catch(() => {}); },
        });
        profRetryBtn.x = PADDING_X;
        profRetryBtn.y = dy;
        inner.addChild(profRetryBtn);
        dy += 24 + SECTION_GAP;
      } else if (hubProfileData) {
        const pd = hubProfileData;

        // avatar (small circle with sprite if avatarDataUrl is set)
        const avSize = HUB_PROFILE_AVATAR_SIZE;
        const avCx = PADDING_X + avSize / 2;
        const avCy = dy + avSize / 2;
        const avColor = pd.accentColor || ACCENT;

        const avCircle = new Graphics();
        avCircle.circle(avCx, avCy, avSize / 2);
        avCircle.fill({ color: avColor });
        avCircle.eventMode = "none";
        inner.addChild(avCircle);

        const avInitial = (pd.username || "h").charAt(0).toUpperCase();
        const avLetter = new Text({
          text: avInitial,
          style: { fontFamily: FONT, fontSize: 11, fontWeight: "bold", fill: 0xffffff },
          resolution: RESOLUTION,
        });
        avLetter.eventMode = "none";
        avLetter.anchor.set(0.5);
        avLetter.x = avCx;
        avLetter.y = avCy;
        inner.addChild(avLetter);

        if (pd.avatarDataUrl) {
          Assets.load(pd.avatarDataUrl)
            .then((texture) => {
              if (avCircle.destroyed) return;
              const sprite = new Sprite(texture);
              sprite.eventMode = "none";
              sprite.width = avSize;
              sprite.height = avSize;
              sprite.x = avCx - avSize / 2;
              sprite.y = avCy - avSize / 2;
              const spriteMask = new Graphics();
              spriteMask.circle(avCx, avCy, avSize / 2);
              spriteMask.fill({ color: 0xffffff });
              inner.addChild(spriteMask);
              sprite.mask = spriteMask;
              inner.addChild(sprite);
              avCircle.visible = false;
              avLetter.visible = false;
            })
            .catch(() => {});
        }

        dy += avSize + 8;

        // username
        const usernameLabel = new Text({
          text: "username",
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
          resolution: RESOLUTION,
        });
        usernameLabel.eventMode = "none";
        usernameLabel.x = PADDING_X;
        usernameLabel.y = dy;
        inner.addChild(usernameLabel);
        dy += LABEL_SIZE + 4;

        const profInputW = Math.max(60, contentW - PADDING_X * 2);
        hubProfileUsernameHandle = createSkeinInput({
          canvasElement,
          width: profInputW,
          height: FIELD_HEIGHT,
          placeholder: "hub display name",
          value: pd.username,
          onEnter: (val) => {
            if (val !== pd.username) {
              handleSetHubProfile({ username: val }).catch(() => {});
            }
          },
        });
        hubProfileUsernameHandle.input.x = PADDING_X;
        hubProfileUsernameHandle.input.y = dy;
        inner.addChild(hubProfileUsernameHandle.input);
        dy += FIELD_HEIGHT + 8;

        // bio
        const bioLabel = new Text({
          text: "bio",
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
          resolution: RESOLUTION,
        });
        bioLabel.eventMode = "none";
        bioLabel.x = PADDING_X;
        bioLabel.y = dy;
        inner.addChild(bioLabel);
        dy += LABEL_SIZE + 4;

        hubProfileBioHandle = createSkeinInput({
          canvasElement,
          width: profInputW,
          height: FIELD_HEIGHT,
          placeholder: "about this hub",
          value: pd.bio,
          onEnter: (val) => {
            if (val !== pd.bio) {
              handleSetHubProfile({ bio: val }).catch(() => {});
            }
          },
        });
        hubProfileBioHandle.input.x = PADDING_X;
        hubProfileBioHandle.input.y = dy;
        inner.addChild(hubProfileBioHandle.input);
        dy += FIELD_HEIGHT + 8;

        // accent color
        const colorLabel = new Text({
          text: "accent color",
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
          resolution: RESOLUTION,
        });
        colorLabel.eventMode = "none";
        colorLabel.x = PADDING_X;
        colorLabel.y = dy;
        inner.addChild(colorLabel);
        dy += LABEL_SIZE + 6;

        const dotRowY = dy;
        for (let ci = 0; ci < COLOR_PALETTE.length; ci++) {
          const dot = new Graphics();
          dot.eventMode = hubProfileInFlight ? "none" : "static";
          dot.cursor = hubProfileInFlight ? "default" : "pointer";
          dot.circle(0, 0, COLOR_DOT_RADIUS);
          dot.fill({ color: COLOR_PALETTE[ci] });
          dot.x = PADDING_X + COLOR_RING_INSET + COLOR_DOT_RADIUS + ci * (COLOR_DOT_RADIUS * 2 + COLOR_DOT_GAP);
          dot.y = dotRowY + COLOR_DOT_RADIUS;
          inner.addChild(dot);

          if (pd.accentColor === COLOR_PALETTE[ci]) {
            const ring = new Graphics();
            ring.circle(dot.x, dot.y, COLOR_DOT_RADIUS + 3);
            ring.stroke({ color: 0xffffff, width: 2 });
            ring.eventMode = "none";
            inner.addChild(ring);
          }

          if (!hubProfileInFlight) {
            const colorIdx = ci;
            dot.on("pointertap", (e) => {
              e.stopPropagation();
              handleSetHubProfile({ accentColor: COLOR_PALETTE[colorIdx] }).catch(() => {});
            });
          }
        }
        dy += COLOR_DOT_RADIUS * 2 + 10;

        // change avatar button
        const AVATAR_BTN_W = 110;
        const AVATAR_BTN_H = 22;
        const avatarBtn = buildOutlinedButton({
          label: hubProfileInFlight ? "\u2026" : "change avatar",
          width: AVATAR_BTN_W,
          height: AVATAR_BTN_H,
          color: ACCENT,
          disabled: hubProfileInFlight,
          onTap: () => {
            pickImageAsDataUrl({ maxWidth: 256, maxHeight: 256, quality: 0.8, cropSquare: true })
              .then((dataUrl) => {
                if (!dataUrl) return;
                const commaIdx = dataUrl.indexOf(",");
                if (commaIdx === -1) return;
                const imageBase64 = dataUrl.slice(commaIdx + 1);
                return handleSetHubAvatar(imageBase64);
              })
              .catch(() => {});
          },
        });
        avatarBtn.x = PADDING_X;
        avatarBtn.y = dy;
        inner.addChild(avatarBtn);
        dy += AVATAR_BTN_H + SECTION_GAP;
      }
    }

    // ---- 2. friendz section ---------------------------------------------
    addSectionHeader("friendz", "friendz", state.friends.length);
    if (!(sectionCollapsed.get("friendz") ?? false)) {
      // -- allow section --
      const allowLabel = new Text({
        text: "allow a peer",
        style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: LABEL_COLOR },
        resolution: RESOLUTION,
      });
      allowLabel.eventMode = "none";
      allowLabel.x = PADDING_X;
      allowLabel.y = dy;
      inner.addChild(allowLabel);
      dy += LABEL_SIZE + 6;

      const allowRow = new Container();
      allowRow.x = PADDING_X;
      allowRow.y = dy;
      inner.addChild(allowRow);

      const inputW = Math.max(60, contentW - PADDING_X * 2 - ALLOW_BTN_W - 8);
      allowInputHandle = createSkeinInput({
        canvasElement,
        width: inputW,
        height: FIELD_HEIGHT,
        placeholder: "node id to allow",
        onEnter: (value) => {
          handleAllow(value.trim()).catch(() => {});
        },
      });
      allowRow.addChild(allowInputHandle.input);

      const allowBtn = buildOutlinedButton({
        label: allowInFlight ? "\u2026" : "allow",
        width: ALLOW_BTN_W,
        height: FIELD_HEIGHT,
        color: ACCENT,
        disabled: allowInFlight,
        onTap: () => {
          handleAllow(allowInputHandle?.value.trim() ?? "").catch(() => {});
        },
      });
      allowBtn.x = inputW + 8;
      allowRow.addChild(allowBtn);
      allowButtonRef = allowBtn;
      dy += FIELD_HEIGHT + 4;

      if (allowFeedback) {
        const feedbackText = new Text({
          text: allowFeedback,
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: REJECT_COLOR },
          resolution: RESOLUTION,
        });
        feedbackText.eventMode = "none";
        feedbackText.x = PADDING_X;
        feedbackText.y = dy;
        inner.addChild(feedbackText);
        dy += feedbackText.height + 6;
      }

      dy += SECTION_GAP - 4;

      // -- friendz list --
      if (state.friends.length === 0) {
        const emptyText = new Text({
          text: "no friendz yet",
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        emptyText.eventMode = "none";
        emptyText.x = PADDING_X;
        emptyText.y = dy;
        inner.addChild(emptyText);
        dy += emptyText.height + SECTION_GAP;
      } else {
        for (let i = 0; i < state.friends.length; i++) {
          const friend = state.friends[i];
          const rowY = dy;

          const row = new Container();
          row.eventMode = "static";
          row.y = rowY;
          inner.addChild(row);

          if (i % 2 === 1) {
            const rowBg = new Graphics();
            rowBg.eventMode = "none";
            rowBg.rect(0, 0, contentW, FRIEND_ROW_HEIGHT);
            rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
            row.addChild(rowBg);
          }

          const displayName = friend.username || truncate(friend.nodeId, 16);

          const avatarX = ROW_PADDING_X + ROW_AVATAR_SIZE / 2;
          const avatarY = 6 + ROW_AVATAR_SIZE / 2;
          const avatarColor = colorForName(displayName, i);

          const avatar = new Graphics();
          avatar.eventMode = "none";
          avatar.circle(avatarX, avatarY, ROW_AVATAR_SIZE / 2);
          avatar.fill({ color: avatarColor });
          row.addChild(avatar);

          const initial = displayName.charAt(0).toUpperCase() || "?";
          const avatarLetter = new Text({
            text: initial,
            style: { fontFamily: FONT, fontSize: 11, fontWeight: "bold", fill: 0xffffff },
            resolution: RESOLUTION,
          });
          avatarLetter.eventMode = "none";
          avatarLetter.anchor.set(0.5);
          avatarLetter.x = avatarX;
          avatarLetter.y = avatarY;
          row.addChild(avatarLetter);

          if (friend.avatarDataUrl) {
            const cacheKey = `hub-admin-friend-avatar-${friend.nodeId}`;
            Assets.load({ src: friend.avatarDataUrl, alias: cacheKey })
              .then((texture) => {
                if (row.destroyed) return;
                const sprite = new Sprite(texture);
                sprite.eventMode = "none";
                sprite.width = ROW_AVATAR_SIZE;
                sprite.height = ROW_AVATAR_SIZE;
                sprite.x = avatarX - ROW_AVATAR_SIZE / 2;
                sprite.y = avatarY - ROW_AVATAR_SIZE / 2;

                const spriteMask = new Graphics();
                spriteMask.circle(avatarX, avatarY, ROW_AVATAR_SIZE / 2);
                spriteMask.fill({ color: 0xffffff });
                row.addChild(spriteMask);
                sprite.mask = spriteMask;
                row.addChild(sprite);

                avatar.visible = false;
                avatarLetter.visible = false;
              })
              .catch(() => {});
          }

          const textX = ROW_PADDING_X + ROW_AVATAR_SIZE + 8;

          const nameText = new Text({
            text: displayName,
            style: { fontFamily: FONT, fontSize: TEXT_SIZE, fontWeight: "bold", fill: TEXT_COLOR },
            resolution: RESOLUTION,
          });
          nameText.eventMode = "none";
          nameText.x = textX;
          nameText.y = 2;
          row.addChild(nameText);

          const nodeIdText = new Text({
            text: truncate(friend.nodeId, 18),
            style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          nodeIdText.eventMode = "none";
          nodeIdText.x = textX;
          nodeIdText.y = 18;
          row.addChild(nodeIdText);

          const copyBtn = new Container();
          copyBtn.eventMode = "static";
          copyBtn.cursor = "pointer";
          copyBtn.x = textX + nodeIdText.width + 6;
          copyBtn.y = 17;
          const copyLabelStyle = { fontFamily: FONT, fontSize: 8, fill: ACCENT };
          const copyLabel = new Text({
            text: "copy",
            style: copyLabelStyle,
            resolution: RESOLUTION,
          });
          copyLabel.eventMode = "none";
          const copyPadX = 5;
          const copyPadY = 2;
          // size the button for whichever label ("copy" / "copied!") is wider, so it
          // never needs to resize (and never overflows) when the label swaps in.
          const copiedLabelWidth = new Text({ text: "copied!", style: copyLabelStyle, resolution: RESOLUTION }).width;
          const copyW = Math.max(copyLabel.width, copiedLabelWidth) + copyPadX * 2;
          const copyH = copyLabel.height + copyPadY * 2;
          const copyBg = new Graphics();
          copyBg.eventMode = "none";
          copyBg.roundRect(0, 0, copyW, copyH, 3);
          copyBg.fill({ color: 0x111118 });
          copyBg.stroke({ color: BORDER, width: 1 });
          copyBtn.addChild(copyBg);
          copyLabel.x = copyPadX;
          copyLabel.y = copyPadY;
          copyBtn.addChild(copyLabel);
          copyBtn.hitArea = new Rectangle(0, 0, copyW, copyH);
          const fullNodeId = friend.nodeId;
          copyBtn.on("pointertap", (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(fullNodeId).then(
              () => {
                copyLabel.text = "copied!";
                setTimeout(() => {
                  if (row.destroyed) return;
                  copyLabel.text = "copy";
                }, COPY_BTN_FEEDBACK_MS);
              },
              () => {}
            );
          });
          row.addChild(copyBtn);
          copyButtonRefs.set(friend.nodeId, copyBtn);

          if (friend.bio) {
            const bioText = new Text({
              text: truncate(friend.bio, 48),
              style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
              resolution: RESOLUTION,
            });
            bioText.eventMode = "none";
            bioText.x = textX;
            bioText.y = 32;
            row.addChild(bioText);
          }

          const statusText = new Text({
            text: friend.isAdmin ? `${friend.status} \u00b7 admin` : friend.status,
            style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          statusText.eventMode = "none";
          statusText.x = textX;
          statusText.y = 42;
          row.addChild(statusText);

          const promoting = promoteInFlight.has(friend.nodeId);
          const blocking = blockInFlight.has(friend.nodeId);
          const removing = removeInFlight.has(friend.nodeId);
          const accepting = acceptFriendInFlight.has(friend.nodeId);
          const isBlocked = friend.status === "blocked";
          const isPending = friend.status === "pending";

          const acceptBtn = isPending
            ? buildOutlinedButton({
                label: accepting ? "\u2026" : "accept",
                width: ACCEPT_BTN_W,
                height: ACTION_BTN_H,
                color: ONLINE_COLOR,
                disabled: accepting,
                onTap: () => {
                  handleAcceptFriendRequest(friend.nodeId).catch(() => {});
                },
              })
            : null;

          const adminBtn = buildOutlinedButton({
            label: promoting ? "\u2026" : friend.isAdmin ? "-admin" : "+admin",
            width: ADMIN_BTN_W,
            height: ACTION_BTN_H,
            color: friend.isAdmin ? ACCENT : MUTED_TEXT,
            disabled: promoting,
            onTap: () => {
              if (friend.isAdmin) {
                handleDemoteAdmin(friend.nodeId).catch(() => {});
              } else {
                handlePromoteAdmin(friend.nodeId).catch(() => {});
              }
            },
          });
          const blockBtn = buildOutlinedButton({
            label: blocking ? "\u2026" : isBlocked ? "unblock" : "block",
            width: BLOCK_BTN_W,
            height: ACTION_BTN_H,
            color: isBlocked ? ONLINE_COLOR : REJECT_COLOR,
            disabled: blocking,
            onTap: () => {
              if (isBlocked) {
                handleUnblock(friend.nodeId).catch(() => {});
              } else {
                handleBlock(friend.nodeId).catch(() => {});
              }
            },
          });
          const removeBtn = buildOutlinedButton({
            label: removing ? "\u2026" : "remove",
            width: REMOVE_BTN_W,
            height: ACTION_BTN_H,
            color: REJECT_COLOR,
            disabled: removing,
            onTap: () => {
              handleRemove(friend.nodeId).catch(() => {});
            },
          });

          const actionsY = FRIEND_ROW_HEIGHT - ACTION_BTN_H - 6;
          removeBtn.x = contentW - REMOVE_BTN_W - ROW_PADDING_X;
          removeBtn.y = actionsY;
          blockBtn.x = removeBtn.x - BLOCK_BTN_W - ACTION_BTN_GAP;
          blockBtn.y = actionsY;
          adminBtn.x = blockBtn.x - ADMIN_BTN_W - ACTION_BTN_GAP;
          adminBtn.y = actionsY;

          if (acceptBtn) {
            acceptBtn.x = adminBtn.x - ACCEPT_BTN_W - ACTION_BTN_GAP;
            acceptBtn.y = actionsY;
            row.addChild(acceptBtn);
            acceptFriendButtonRefs.set(friend.nodeId, acceptBtn);
          }

          row.addChild(adminBtn);
          row.addChild(blockBtn);
          row.addChild(removeBtn);
          adminButtonRefs.set(friend.nodeId, adminBtn);
          blockButtonRefs.set(friend.nodeId, blockBtn);
          removeButtonRefs.set(friend.nodeId, removeBtn);

          dy += FRIEND_ROW_HEIGHT;
        }
        dy += SECTION_GAP - 8;
      }
    }

    // ---- 3. pending knocks section --------------------------------------
    addSectionHeader("knocks", "pending knocks", state.pendingKnocks.length);
    if (!(sectionCollapsed.get("knocks") ?? true)) {
      const knocksHint = new Text({
        text: "approve grants access on the canvas; decline just records the decision",
        style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
        resolution: RESOLUTION,
      });
      knocksHint.eventMode = "none";
      knocksHint.x = PADDING_X;
      knocksHint.y = dy;
      inner.addChild(knocksHint);
      dy += knocksHint.height + 8;

      if (state.pendingKnocks.length === 0) {
        const emptyKnocksText = new Text({
          text: "no pending knocks",
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        emptyKnocksText.eventMode = "none";
        emptyKnocksText.x = PADDING_X;
        emptyKnocksText.y = dy;
        inner.addChild(emptyKnocksText);
        dy += emptyKnocksText.height + SECTION_GAP;
      } else {
        for (let i = 0; i < state.pendingKnocks.length; i++) {
          const knock = state.pendingKnocks[i];
          const row = new Container();
          row.eventMode = "static";
          row.y = dy;
          inner.addChild(row);

          if (i % 2 === 1) {
            const rowBg = new Graphics();
            rowBg.eventMode = "none";
            rowBg.rect(0, 0, contentW, KNOCK_ROW_HEIGHT);
            rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
            row.addChild(rowBg);
          }

          const usernameText = new Text({
            text: knock.requesterUsername || truncate(knock.requesterNodeId, 20),
            style: { fontFamily: FONT, fontSize: TEXT_SIZE, fontWeight: "bold", fill: TEXT_COLOR },
            resolution: RESOLUTION,
          });
          usernameText.eventMode = "none";
          usernameText.x = ROW_PADDING_X;
          usernameText.y = 4;
          row.addChild(usernameText);

          const canvasText = new Text({
            text: `canvas: ${truncate(knock.canvasDocId, 24)}`,
            style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          canvasText.eventMode = "none";
          canvasText.x = ROW_PADDING_X;
          canvasText.y = 20;
          row.addChild(canvasText);

          const messageText = new Text({
            text: truncate(knock.message, 60),
            style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          messageText.eventMode = "none";
          messageText.x = ROW_PADDING_X;
          messageText.y = 34;
          row.addChild(messageText);

          const knockedAtText = new Text({
            text: new Date(knock.knockedAt * 1000).toLocaleString(),
            style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          knockedAtText.eventMode = "none";
          knockedAtText.x = ROW_PADDING_X;
          knockedAtText.y = 50;
          row.addChild(knockedAtText);

          const knockKey = `${knock.canvasDocId}::${knock.requesterNodeId}`;
          const deciding = knockDecisionInFlight.has(knockKey);

          const declineKnockBtn = buildOutlinedButton({
            label: deciding ? "\u2026" : "decline",
            width: DECLINE_KNOCK_BTN_W,
            height: ACTION_BTN_H,
            color: REJECT_COLOR,
            disabled: deciding,
            onTap: () => {
              handleDeclineKnock(knock.canvasDocId, knock.requesterNodeId).catch(() => {});
            },
          });
          const approveKnockBtn = buildOutlinedButton({
            label: deciding ? "\u2026" : "approve",
            width: APPROVE_KNOCK_BTN_W,
            height: ACTION_BTN_H,
            color: ONLINE_COLOR,
            disabled: deciding,
            onTap: () => {
              handleApproveKnock(knock.canvasDocId, knock.requesterNodeId).catch(() => {});
            },
          });

          const knockActionsY = KNOCK_ROW_HEIGHT - ACTION_BTN_H - 6;
          declineKnockBtn.x = contentW - DECLINE_KNOCK_BTN_W - ROW_PADDING_X;
          declineKnockBtn.y = knockActionsY;
          approveKnockBtn.x = declineKnockBtn.x - APPROVE_KNOCK_BTN_W - ACTION_BTN_GAP;
          approveKnockBtn.y = knockActionsY;

          row.addChild(approveKnockBtn);
          row.addChild(declineKnockBtn);
          approveKnockButtonRefs.set(knockKey, approveKnockBtn);
          declineKnockButtonRefs.set(knockKey, declineKnockBtn);

          dy += KNOCK_ROW_HEIGHT;
        }
      }
    }

    // ---- 4. canvases section --------------------------------------------
    addSectionHeader("canvases", "canvases", canvasState === "loaded" ? canvasTotal : null);
    if (!(sectionCollapsed.get("canvases") ?? true)) {
      if (unsyncSweptMsg) {
        const sweptText = new Text({
          text: unsyncSweptMsg,
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: ONLINE_COLOR },
          resolution: RESOLUTION,
        });
        sweptText.eventMode = "none";
        sweptText.x = PADDING_X;
        sweptText.y = dy;
        inner.addChild(sweptText);
        dy += sweptText.height + 4;
      }

      if (canvasState === "idle" || canvasState === "loading") {
        const canvasLoadingText = new Text({
          text: "loading canvases\u2026",
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        canvasLoadingText.eventMode = "none";
        canvasLoadingText.x = PADDING_X;
        canvasLoadingText.y = dy;
        inner.addChild(canvasLoadingText);
        dy += canvasLoadingText.height + SECTION_GAP;
      } else if (canvasState === "error") {
        const canvasErrText = new Text({
          text: canvasErrorMsg ? `canvas load failed: ${canvasErrorMsg}` : "hub offline?",
          style: {
            fontFamily: FONT,
            fontSize: TEXT_SIZE,
            fill: REJECT_COLOR,
            wordWrap: true,
            wordWrapWidth: Math.max(80, currentWidth - PADDING_X * 2),
          },
          resolution: RESOLUTION,
        });
        canvasErrText.eventMode = "none";
        canvasErrText.x = PADDING_X;
        canvasErrText.y = dy;
        inner.addChild(canvasErrText);
        dy += canvasErrText.height + 6;
        const canvasRetryBtn = buildOutlinedButton({
          label: "retry",
          width: 60,
          height: 24,
          color: ACCENT,
          onTap: () => { loadCanvases().catch(() => {}); },
        });
        canvasRetryBtn.x = PADDING_X;
        canvasRetryBtn.y = dy;
        inner.addChild(canvasRetryBtn);
        dy += 24 + SECTION_GAP;
      } else if (canvasRows.length === 0) {
        const emptyCanvasText = new Text({
          text: "no canvases",
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        emptyCanvasText.eventMode = "none";
        emptyCanvasText.x = PADDING_X;
        emptyCanvasText.y = dy;
        inner.addChild(emptyCanvasText);
        dy += emptyCanvasText.height + 8;
      } else {
        for (let i = 0; i < canvasRows.length; i++) {
          const canvas = canvasRows[i];
          const rowY = dy;
          const row = new Container();
          row.eventMode = "static";
          row.y = rowY;
          if (i % 2 === 1) {
            const rowBg = new Graphics();
            rowBg.eventMode = "none";
            rowBg.rect(0, 0, contentW, CANVAS_ROW_HEIGHT);
            rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
            row.addChild(rowBg);
          }
          inner.addChild(row);

          // per-canvas blob expansion toggle (▸/▾)
          const cbExpanded = canvasBlobsExpanded.has(canvas.canvasDocId);
          const expandTriText = new Text({
            text: cbExpanded ? "\u25be" : "\u25b8",
            style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          expandTriText.eventMode = "static";
          expandTriText.cursor = "pointer";
          expandTriText.x = ROW_PADDING_X;
          expandTriText.y = Math.round((CANVAS_ROW_HEIGHT - expandTriText.height) / 2);
          expandTriText.on("pointertap", (e) => {
            e.stopPropagation();
            const cid = canvas.canvasDocId;
            if (canvasBlobsExpanded.has(cid)) {
              canvasBlobsExpanded.delete(cid);
            } else {
              canvasBlobsExpanded.add(cid);
              const cbSt = canvasBlobsState.get(cid);
              if (!cbSt || cbSt === "idle") {
                loadCanvasBlobs(cid).catch(() => {});
              }
            }
            rebuild();
          });
          row.addChild(expandTriText);

          // canvas doc id as a link (ACCENT color, tap sets window.location.hash)
          const canvasIdText = new Text({
            text: truncate(canvas.canvasDocId, 24),
            style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: ACCENT },
            resolution: RESOLUTION,
          });
          canvasIdText.eventMode = "static";
          canvasIdText.cursor = "pointer";
          canvasIdText.x = ROW_PADDING_X + expandTriText.width + 5;
          canvasIdText.y = 4;
          canvasIdText.on("pointertap", (e) => {
            e.stopPropagation();
            window.location.hash = canvas.canvasDocId;
          });
          row.addChild(canvasIdText);

          const canvasStatsText = new Text({
            text: `${canvas.blobCount} blobs \u00b7 ${formatFileSize(canvas.totalBytes)}`,
            style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          canvasStatsText.eventMode = "none";
          canvasStatsText.x = canvasIdText.x;
          canvasStatsText.y = canvasIdText.y + LABEL_SIZE + 2;
          row.addChild(canvasStatsText);

          const isArmed = confirmUnsyncCanvas === canvas.canvasDocId;
          const unsyncBtn = buildOutlinedButton({
            label: unsyncInFlight ? "\u2026" : isArmed ? "really un-sync?" : "un-sync",
            width: UNSYNC_BTN_W,
            height: ACTION_BTN_H,
            color: isArmed ? REJECT_COLOR : MUTED_TEXT,
            fillColor: isArmed ? REJECT_COLOR : undefined,
            disabled: unsyncInFlight,
            onTap: () => { handleUnsyncCanvasClick(canvas.canvasDocId); },
          });
          unsyncBtn.x = contentW - UNSYNC_BTN_W - ROW_PADDING_X;
          unsyncBtn.y = (CANVAS_ROW_HEIGHT - ACTION_BTN_H) / 2;
          row.addChild(unsyncBtn);
          unsyncButtonRefs.set(canvas.canvasDocId, unsyncBtn);

          dy += CANVAS_ROW_HEIGHT;

          // -- nested canvas blobs (when this canvas row is expanded) --
          if (cbExpanded) {
            const cbSt = canvasBlobsState.get(canvas.canvasDocId) ?? "idle";
            const cbData = canvasBlobsData.get(canvas.canvasDocId);
            const INDENT = PADDING_X + 12;

            if (cbSt === "idle" || cbSt === "loading") {
              const t = new Text({
                text: "loading blobs\u2026",
                style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
                resolution: RESOLUTION,
              });
              t.eventMode = "none";
              t.x = INDENT;
              t.y = dy;
              inner.addChild(t);
              dy += t.height + 8;
            } else if (cbSt === "error") {
              const t = new Text({
                text: "blob load failed",
                style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: REJECT_COLOR },
                resolution: RESOLUTION,
              });
              t.eventMode = "none";
              t.x = INDENT;
              t.y = dy;
              inner.addChild(t);
              dy += t.height + 4;
              const cbRetryBtn = buildOutlinedButton({
                label: "retry",
                width: 48,
                height: 18,
                color: ACCENT,
                onTap: () => { loadCanvasBlobs(canvas.canvasDocId).catch(() => {}); },
              });
              cbRetryBtn.x = INDENT;
              cbRetryBtn.y = dy;
              inner.addChild(cbRetryBtn);
              dy += 18 + 8;
            } else if (cbData) {
              if (cbData.rows.length === 0) {
                const t = new Text({
                  text: "no blobs",
                  style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
                  resolution: RESOLUTION,
                });
                t.eventMode = "none";
                t.x = INDENT;
                t.y = dy;
                inner.addChild(t);
                dy += t.height + 8;
              } else {
                const cbSoftDelBtnW = 68;
                for (let bi = 0; bi < cbData.rows.length; bi++) {
                  const blob = cbData.rows[bi];
                  const brow = new Container();
                  brow.eventMode = "none";
                  brow.y = dy;
                  if (bi % 2 === 1) {
                    const rbg = new Graphics();
                    rbg.eventMode = "none";
                    rbg.rect(0, 0, contentW, BLOB_ROW_HEIGHT);
                    rbg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
                    brow.addChild(rbg);
                  }
                  inner.addChild(brow);

                  const blobName = blob.filename ?? `${blob.blake3.slice(0, 16)}\u2026`;
                  const bnText = new Text({
                    text: blobName,
                    style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: TEXT_COLOR },
                    resolution: RESOLUTION,
                  });
                  bnText.eventMode = "none";
                  bnText.x = INDENT;
                  bnText.y = (BLOB_ROW_HEIGHT - bnText.height * 2 - 2) / 2;
                  brow.addChild(bnText);

                  const bSizeText = new Text({
                    text: formatFileSize(blob.size),
                    style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
                    resolution: RESOLUTION,
                  });
                  bSizeText.eventMode = "none";
                  bSizeText.x = INDENT;
                  bSizeText.y = bnText.y + bnText.height + 2;
                  brow.addChild(bSizeText);

                  if (!blob.softDeleted) {
                    const sdBtn = buildOutlinedButton({
                      label: softDeleteInFlight ? "\u2026" : "soft delete",
                      width: cbSoftDelBtnW,
                      height: ACTION_BTN_H,
                      color: REJECT_COLOR,
                      disabled: softDeleteInFlight,
                      onTap: () => { handleSoftDeleteOne(blob.blake3).catch(() => {}); },
                    });
                    sdBtn.x = contentW - cbSoftDelBtnW - ROW_PADDING_X;
                    sdBtn.y = (BLOB_ROW_HEIGHT - ACTION_BTN_H) / 2;
                    brow.addChild(sdBtn);
                  }

                  dy += BLOB_ROW_HEIGHT;
                }

                // nested pagination
                if (cbData.total > BLOB_PAGE_SIZE) {
                  const cid = canvas.canvasDocId;
                  const pc = pageCount(cbData.total);
                  const cbPage = cbData.page;
                  const { row: pagRow, height: pagH } = buildPaginationRow({
                    page: cbPage,
                    total: cbData.total,
                    onPrev: () => {
                      if (cbPage > 0) loadCanvasBlobs(cid, cbPage - 1).catch(() => {});
                    },
                    onNext: () => {
                      if (cbPage < pc - 1) loadCanvasBlobs(cid, cbPage + 1).catch(() => {});
                    },
                    prevRef: (_c) => {},
                    nextRef: (_c) => {},
                  });
                  pagRow.x = INDENT;
                  pagRow.y = dy;
                  inner.addChild(pagRow);
                  dy += pagH + 4;
                }
              }
            }
          }
        }

        // canvas list pagination
        if (canvasTotal > BLOB_PAGE_SIZE) {
          const { row: pagRow, height: pagH } = buildPaginationRow({
            page: canvasPage,
            total: canvasTotal,
            onPrev: () => {
              if (canvasPage > 0) { canvasPage--; loadCanvases().catch(() => {}); }
            },
            onNext: () => {
              if (canvasPage < pageCount(canvasTotal) - 1) { canvasPage++; loadCanvases().catch(() => {}); }
            },
            prevRef: (c) => { canvasPrevBtnRef = c; },
            nextRef: (c) => { canvasNextBtnRef = c; },
          });
          pagRow.x = PADDING_X;
          pagRow.y = dy;
          inner.addChild(pagRow);
          dy += pagH;
        }
      }

      dy += 4;
    }

    // ---- 5. blobs section -----------------------------------------------
    addSectionHeader("blobs", "blobs", blobState === "loaded" ? blobTotal : null);
    if (!(sectionCollapsed.get("blobs") ?? true)) {
      // disk usage summary (already available from initial refresh)
      if (state.diskUsage !== null) {
        const du = state.diskUsage;
        const diskSummary =
          `${du.blobCount} blobs \u00b7 ${formatFileSize(du.totalBlobBytes)}` +
          (du.softDeletedBlobCount > 0
            ? ` \u00b7 ${du.softDeletedBlobCount} soft-deleted (${formatFileSize(du.softDeletedBlobBytes)})`
            : "");
        const diskText = new Text({
          text: diskSummary,
          style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        diskText.eventMode = "none";
        diskText.x = PADDING_X;
        diskText.y = dy;
        inner.addChild(diskText);
        dy += diskText.height + 3;

        if (du.diskAvailableBytes !== null && du.diskTotalBytes !== null) {
          const freeText = new Text({
            text: `${formatFileSize(du.diskAvailableBytes)} free of ${formatFileSize(du.diskTotalBytes)} disk`,
            style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          freeText.eventMode = "none";
          freeText.x = PADDING_X;
          freeText.y = dy;
          inner.addChild(freeText);
          dy += freeText.height + 3;
        }
        dy += 4;
      }

      if (blobState === "idle" || blobState === "loading") {
        const blobLoadingText = new Text({
          text: "loading blobs\u2026",
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        blobLoadingText.eventMode = "none";
        blobLoadingText.x = PADDING_X;
        blobLoadingText.y = dy;
        inner.addChild(blobLoadingText);
        dy += blobLoadingText.height + SECTION_GAP;
      } else if (blobState === "error") {
        const blobErrText = new Text({
          text: blobErrorMsg ? `blob load failed: ${blobErrorMsg}` : "hub offline?",
          style: {
            fontFamily: FONT,
            fontSize: TEXT_SIZE,
            fill: REJECT_COLOR,
            wordWrap: true,
            wordWrapWidth: Math.max(80, currentWidth - PADDING_X * 2),
          },
          resolution: RESOLUTION,
        });
        blobErrText.eventMode = "none";
        blobErrText.x = PADDING_X;
        blobErrText.y = dy;
        inner.addChild(blobErrText);
        dy += blobErrText.height + 6;
        const blobRetryBtn = buildOutlinedButton({
          label: "retry",
          width: 60,
          height: 24,
          color: ACCENT,
          onTap: () => { loadBlobs().catch(() => {}); },
        });
        blobRetryBtn.x = PADDING_X;
        blobRetryBtn.y = dy;
        inner.addChild(blobRetryBtn);
        dy += 24 + SECTION_GAP;
      } else {
        if (blobRows.length === 0) {
          const emptyBlobsText = new Text({
            text: "no blobs",
            style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          emptyBlobsText.eventMode = "none";
          emptyBlobsText.x = PADDING_X;
          emptyBlobsText.y = dy;
          inner.addChild(emptyBlobsText);
          dy += emptyBlobsText.height + 8;
        } else {
          const softDelBtnW = 68;
          for (let i = 0; i < blobRows.length; i++) {
            const blob = blobRows[i];
            const row = new Container();
            row.eventMode = "none";
            row.y = dy;
            if (i % 2 === 1) {
              const rowBg = new Graphics();
              rowBg.eventMode = "none";
              rowBg.rect(0, 0, contentW, BLOB_ROW_HEIGHT);
              rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
              row.addChild(rowBg);
            }
            inner.addChild(row);

            const blobName = blob.filename ?? `${blob.blake3.slice(0, 16)}\u2026`;
            const nameText = new Text({
              text: blobName,
              style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: TEXT_COLOR },
              resolution: RESOLUTION,
            });
            nameText.eventMode = "none";
            nameText.x = ROW_PADDING_X;
            nameText.y = (BLOB_ROW_HEIGHT - nameText.height * 2 - 2) / 2;
            row.addChild(nameText);

            const sizeText = new Text({
              text: formatFileSize(blob.size),
              style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
              resolution: RESOLUTION,
            });
            sizeText.eventMode = "none";
            sizeText.x = ROW_PADDING_X;
            sizeText.y = nameText.y + nameText.height + 2;
            row.addChild(sizeText);

            const softDelBtn = buildOutlinedButton({
              label: softDeleteInFlight ? "\u2026" : "soft delete",
              width: softDelBtnW,
              height: ACTION_BTN_H,
              color: REJECT_COLOR,
              disabled: softDeleteInFlight,
              onTap: () => { handleSoftDeleteOne(blob.blake3).catch(() => {}); },
            });
            softDelBtn.x = contentW - softDelBtnW - ROW_PADDING_X;
            softDelBtn.y = (BLOB_ROW_HEIGHT - ACTION_BTN_H) / 2;
            row.addChild(softDelBtn);

            dy += BLOB_ROW_HEIGHT;
          }

          if (blobTotal > BLOB_PAGE_SIZE) {
            const { row: pagRow, height: pagH } = buildPaginationRow({
              page: blobPage,
              total: blobTotal,
              onPrev: () => {
                if (blobPage > 0) { blobPage--; loadBlobs().catch(() => {}); }
              },
              onNext: () => {
                if (blobPage < pageCount(blobTotal) - 1) { blobPage++; loadBlobs().catch(() => {}); }
              },
              prevRef: (c) => { blobPrevBtnRef = c; },
              nextRef: (c) => { blobNextBtnRef = c; },
            });
            pagRow.x = PADDING_X;
            pagRow.y = dy;
            inner.addChild(pagRow);
            dy += pagH;
          }
        }
      }

      dy += 8;
    }

    // ---- 6. soft-deleted section ----------------------------------------
    addSectionHeader("softDeleted", "soft-deleted", blobState === "loaded" ? softDeletedTotal : null);
    if (!(sectionCollapsed.get("softDeleted") ?? true)) {
      if (blobState === "idle" || blobState === "loading") {
        const t = new Text({
          text: "loading\u2026",
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        t.eventMode = "none";
        t.x = PADDING_X;
        t.y = dy;
        inner.addChild(t);
        dy += t.height + SECTION_GAP;
      } else if (blobState === "error") {
        const sdErrText = new Text({
          text: blobErrorMsg ? `load failed: ${blobErrorMsg}` : "hub offline?",
          style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: REJECT_COLOR },
          resolution: RESOLUTION,
        });
        sdErrText.eventMode = "none";
        sdErrText.x = PADDING_X;
        sdErrText.y = dy;
        inner.addChild(sdErrText);
        dy += sdErrText.height + 6;
        const sdRetryBtn = buildOutlinedButton({
          label: "retry",
          width: 60,
          height: 24,
          color: ACCENT,
          onTap: () => { loadBlobs().catch(() => {}); },
        });
        sdRetryBtn.x = PADDING_X;
        sdRetryBtn.y = dy;
        inner.addChild(sdRetryBtn);
        dy += 24 + SECTION_GAP;
      } else {
        // header row with "hard delete all" button
        const sdHeaderRow = new Container();
        sdHeaderRow.eventMode = "static";
        sdHeaderRow.y = dy;
        inner.addChild(sdHeaderRow);

        if (softDeletedRows.length > 0) {
          const hardDelAllBtnW = 108;
          const hardDelAllLbl = confirmHardDeleteAll ? "really delete all?" : "hard delete all";
          const hardDelAllBtn = buildOutlinedButton({
            label: hardDeleteInFlight ? "\u2026" : hardDelAllLbl,
            width: hardDelAllBtnW,
            height: ACTION_BTN_H,
            color: REJECT_COLOR,
            fillColor: confirmHardDeleteAll ? REJECT_COLOR : undefined,
            disabled: hardDeleteInFlight,
            onTap: () => { handleHardDeleteAllClick(); },
          });
          hardDelAllBtn.x = contentW - hardDelAllBtnW - ROW_PADDING_X;
          hardDelAllBtn.y = 0;
          sdHeaderRow.addChild(hardDelAllBtn);
        }
        dy += ACTION_BTN_H + 4;

        if (blobDeleteFailures.length > 0) {
          const failText = new Text({
            text: `failed to delete ${blobDeleteFailures.length} blob(s)`,
            style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: REJECT_COLOR },
            resolution: RESOLUTION,
          });
          failText.eventMode = "none";
          failText.x = PADDING_X;
          failText.y = dy;
          inner.addChild(failText);
          dy += failText.height + 4;
        }

        if (softDeletedRows.length === 0) {
          const emptySoftDelText = new Text({
            text: "no soft-deleted blobs",
            style: { fontFamily: FONT, fontSize: TEXT_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          emptySoftDelText.eventMode = "none";
          emptySoftDelText.x = PADDING_X;
          emptySoftDelText.y = dy;
          inner.addChild(emptySoftDelText);
          dy += emptySoftDelText.height + 8;
        } else {
          const SDH = BLOB_ROW_HEIGHT + 10;
          const restoreBtnW = 52;
          const hardDelOneBtnW = 60;
          for (let i = 0; i < softDeletedRows.length; i++) {
            const blob = softDeletedRows[i];
            const row = new Container();
            row.eventMode = "none";
            row.y = dy;
            if (i % 2 === 1) {
              const rowBg = new Graphics();
              rowBg.eventMode = "none";
              rowBg.rect(0, 0, contentW, SDH);
              rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
              row.addChild(rowBg);
            }
            inner.addChild(row);

            const blobName = blob.filename ?? `${blob.blake3.slice(0, 16)}\u2026`;
            const sdNameText = new Text({
              text: blobName,
              style: { fontFamily: FONT, fontSize: LABEL_SIZE, fill: TEXT_COLOR },
              resolution: RESOLUTION,
            });
            sdNameText.eventMode = "none";
            sdNameText.x = ROW_PADDING_X;
            sdNameText.y = 3;
            row.addChild(sdNameText);

            const deletedBy = truncate(blob.softDeletedBy, 12);
            const deletedWhen = new Date(blob.softDeletedAt * 1000).toLocaleString();
            const sdMetaText = new Text({
              text: `${formatFileSize(blob.size)} \u00b7 by ${deletedBy} \u00b7 ${deletedWhen}`,
              style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
              resolution: RESOLUTION,
            });
            sdMetaText.eventMode = "none";
            sdMetaText.x = ROW_PADDING_X;
            sdMetaText.y = sdNameText.y + sdNameText.height + 2;
            row.addChild(sdMetaText);

            const restoreBtn = buildOutlinedButton({
              label: restoreInFlight ? "\u2026" : "restore",
              width: restoreBtnW,
              height: ACTION_BTN_H,
              color: ONLINE_COLOR,
              disabled: restoreInFlight,
              onTap: () => { handleRestoreOne(blob.blake3).catch(() => {}); },
            });
            const hardDelOneBtn = buildOutlinedButton({
              label: hardDeleteInFlight ? "\u2026" : "hard delete",
              width: hardDelOneBtnW,
              height: ACTION_BTN_H,
              color: REJECT_COLOR,
              disabled: hardDeleteInFlight,
              onTap: () => { executeHardDeleteOne(blob.blake3).catch(() => {}); },
            });
            restoreBtn.x = contentW - restoreBtnW - ROW_PADDING_X;
            restoreBtn.y = (SDH - ACTION_BTN_H) / 2;
            hardDelOneBtn.x = restoreBtn.x - hardDelOneBtnW - ACTION_BTN_GAP;
            hardDelOneBtn.y = restoreBtn.y;
            row.addChild(hardDelOneBtn);
            row.addChild(restoreBtn);

            dy += SDH;
          }

          if (softDeletedTotal > BLOB_PAGE_SIZE) {
            const { row: pagRow, height: pagH } = buildPaginationRow({
              page: softDeletedPage,
              total: softDeletedTotal,
              onPrev: () => {
                if (softDeletedPage > 0) { softDeletedPage--; loadBlobs().catch(() => {}); }
              },
              onNext: () => {
                if (softDeletedPage < pageCount(softDeletedTotal) - 1) { softDeletedPage++; loadBlobs().catch(() => {}); }
              },
              prevRef: (c) => { softDeletedPrevBtnRef = c; },
              nextRef: (c) => { softDeletedNextBtnRef = c; },
            });
            pagRow.x = PADDING_X;
            pagRow.y = dy;
            inner.addChild(pagRow);
            dy += pagH;
          }
          dy += 4;
        }
      }
    }

    finishLayout(dy);
  }

  function finishLayout(contentHeight: number): void {
    totalHeight = contentHeight;
    // redraw the sizing rect to span the full content: deterministic bounds
    // for ScrollBox's List measurement AND the hit surface for isOver/drag
    // over text (eventMode "none") and empty gaps
    innerSizingRect.clear();
    innerSizingRect.rect(0, 0, Math.max(1, currentWidth), Math.max(1, contentHeight));
    innerSizingRect.fill({ color: 0x000000, alpha: 0.0001 });
    // ScrollBox caches item measurements — force a re-measure + re-clamp
    scrollBox.resize(true);
  }

  // -- public interface -----------------------------------------------------

  function layout(width: number, height: number): void {
    currentWidth = width;
    areaHeight = height;
    scrollBox.setSize(width, height);
    rebuild();
  }

  function getState(): HubProfilePanelState {
    return state;
  }

  function getAllowInputGlobalPos(): { x: number; y: number } | null {
    if (!allowInputHandle) return null;
    return globalCenter(allowInputHandle.input);
  }

  function getAllowButtonGlobalPos(): { x: number; y: number } | null {
    if (!allowButtonRef) return null;
    return globalCenter(allowButtonRef);
  }

  function getRemoveButtonGlobalPos(nodeId: string): { x: number; y: number } | null {
    const btn = removeButtonRefs.get(nodeId);
    if (!btn) return null;
    return globalCenter(btn);
  }

  function getBlockButtonGlobalPos(nodeId: string): { x: number; y: number } | null {
    const btn = blockButtonRefs.get(nodeId);
    if (!btn) return null;
    return globalCenter(btn);
  }

  function getAdminButtonGlobalPos(nodeId: string): { x: number; y: number } | null {
    const btn = adminButtonRefs.get(nodeId);
    if (!btn) return null;
    return globalCenter(btn);
  }

  function getAcceptFriendButtonGlobalPos(nodeId: string): { x: number; y: number } | null {
    const btn = acceptFriendButtonRefs.get(nodeId);
    if (!btn) return null;
    return globalCenter(btn);
  }

  function getApproveKnockButtonGlobalPos(
    canvasDocId: string,
    requesterNodeId: string
  ): { x: number; y: number } | null {
    const btn = approveKnockButtonRefs.get(`${canvasDocId}::${requesterNodeId}`);
    if (!btn) return null;
    return globalCenter(btn);
  }

  function getDeclineKnockButtonGlobalPos(
    canvasDocId: string,
    requesterNodeId: string
  ): { x: number; y: number } | null {
    const btn = declineKnockButtonRefs.get(`${canvasDocId}::${requesterNodeId}`);
    if (!btn) return null;
    return globalCenter(btn);
  }

  function getCopyButtonGlobalPos(nodeId: string): { x: number; y: number } | null {
    const btn = copyButtonRefs.get(nodeId);
    if (!btn) return null;
    return globalCenter(btn);
  }

  function destroy(): void {
    destroyed = true;
    document.removeEventListener("wheel", onNativeWheel, { capture: true } as EventListenerOptions);
    if (confirmHardDeleteAllTimer !== null) {
      clearTimeout(confirmHardDeleteAllTimer);
    }
    if (confirmUnsyncTimer !== null) {
      clearTimeout(confirmUnsyncTimer);
    }
    if (allowInputHandle) {
      allowInputHandle.destroy();
      allowInputHandle = null;
    }
    if (hubProfileUsernameHandle) {
      hubProfileUsernameHandle.destroy();
      hubProfileUsernameHandle = null;
    }
    if (hubProfileBioHandle) {
      hubProfileBioHandle.destroy();
      hubProfileBioHandle = null;
    }
    // removes ScrollBox's document-level capture wheel listener too
    scrollBox.destroy({ children: true });
  }

  refresh().catch((err) => {
    log.warn(TAG, "initial refresh failed:", err);
  });

  return {
    container,
    layout,
    refresh,
    getState,
    getBlobPageState(): HubProfilePageState {
      return { page: blobPage, pageCount: pageCount(blobTotal), total: blobTotal };
    },
    getSoftDeletedPageState(): HubProfilePageState {
      return { page: softDeletedPage, pageCount: pageCount(softDeletedTotal), total: softDeletedTotal };
    },
    getCanvasPageState(): HubProfilePageState {
      return { page: canvasPage, pageCount: pageCount(canvasTotal), total: canvasTotal };
    },
    getBlobPrevButtonGlobalPos(): { x: number; y: number } | null {
      return blobPrevBtnRef ? globalCenter(blobPrevBtnRef) : null;
    },
    getBlobNextButtonGlobalPos(): { x: number; y: number } | null {
      return blobNextBtnRef ? globalCenter(blobNextBtnRef) : null;
    },
    getSoftDeletedPrevButtonGlobalPos(): { x: number; y: number } | null {
      return softDeletedPrevBtnRef ? globalCenter(softDeletedPrevBtnRef) : null;
    },
    getSoftDeletedNextButtonGlobalPos(): { x: number; y: number } | null {
      return softDeletedNextBtnRef ? globalCenter(softDeletedNextBtnRef) : null;
    },
    getCanvasPrevButtonGlobalPos(): { x: number; y: number } | null {
      return canvasPrevBtnRef ? globalCenter(canvasPrevBtnRef) : null;
    },
    getCanvasNextButtonGlobalPos(): { x: number; y: number } | null {
      return canvasNextBtnRef ? globalCenter(canvasNextBtnRef) : null;
    },
    getUnsyncButtonGlobalPos(canvasDocId: string): { x: number; y: number } | null {
      const btn = unsyncButtonRefs.get(canvasDocId);
      return btn ? globalCenter(btn) : null;
    },
    getScrollState(): { scrollY: number; totalHeight: number; areaHeight: number } {
      // ScrollBox's raw value is negated (0 at top, negative scrolled down)
      return { scrollY: -scrollBox.scrollY, totalHeight, areaHeight };
    },
    getPanelGlobalPos(): { x: number; y: number } {
      const p = scrollBox.getGlobalPosition();
      return { x: p.x + currentWidth / 2, y: p.y + areaHeight / 2 };
    },
    getAllowInputGlobalPos,
    getAllowButtonGlobalPos,
    getRemoveButtonGlobalPos,
    getBlockButtonGlobalPos,
    getAdminButtonGlobalPos,
    getAcceptFriendButtonGlobalPos,
    getApproveKnockButtonGlobalPos,
    getDeclineKnockButtonGlobalPos,
    getCopyButtonGlobalPos,
    getSectionCollapsed(sectionId: string): boolean {
      return sectionCollapsed.get(sectionId as SectionId) ?? false;
    },
    toggleSection(sectionId: string): void {
      toggleSectionAndLoad(sectionId as SectionId);
    },
    getHubProfileState(): HubAdminHubProfile | null {
      return hubProfileData;
    },
    getCanvasBlobsState(canvasDocId: string) {
      return canvasBlobsData.get(canvasDocId) ?? null;
    },
    destroy,
  };
}

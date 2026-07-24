import { Assets, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import { z } from "zod";
import {
  getKnockRelayedBy,
  getKnockSocialDoc,
  getProtocol,
  onKnockAcked,
  onKnockRelayed,
  recordKnockAck,
  recordKnockRelay,
  sendCanvasInviteAccept,
  sendCanvasInviteDecline,
} from "../../src/p2p/friendz-bridge";
import { getStoredIdentity } from "../../src/p2p/identity";
import { approveKnock, declineKnock } from "../../src/standalone/friendz-wiring";
import { invitableRoleSchema, type InvitableRole, type PendingCanvasKnock } from "../../src/canvas/canvas-doc";
import type { CanvasStore } from "../../src/canvas/canvas-store";
import { defaultTheme } from "../../src/theme/skein-theme";
import {
  isTransparent,
  safeColor,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../../src/widgets/widget-types";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const canvasInviteSchema = z.object({
  id: z.string(),
  canvasDocId: z.string(),
  canvasTitle: z.string().default(""),
  canvasDescription: z.string().default(""),
  canvasColor: z.number().catch(0),
  canvasPreviewUrl: z.string().default(""),
  fromNodeId: z.string(),
  fromUsername: z.string().default(""),
  relayedBy: z.string().catch(""),
  // the role actually offered by the invite — falls back to "member" for
  // any already-persisted invite written before this field existed, not as
  // a design default (see boot.ts's acceptCanvasInvite, which used to
  // hardcode "member" unconditionally on the resulting canvas-card; a real,
  // now-fixed bug — see docs comment there).
  role: invitableRoleSchema.catch("member"),
  receivedAt: z.string(),
  status: z.enum(["pending", "accepted", "declined"]).default("pending"),
});

const canvasShareSchema = z.object({
  id: z.string(),
  canvasDocId: z.string(),
  canvasTitle: z.string().default(""),
  canvasDescription: z.string().default(""),
  canvasColor: z.number().default(0),
  canvasPreviewUrl: z.string().default(""),
  toNodeId: z.string(),
  toUsername: z.string().default(""),
  sentAt: z.string(),
  delivered: z.boolean().default(false),
  accepted: z.boolean().default(false),
  declined: z.boolean().default(false),
});

const canvasDeletedNotifSchema = z.object({
  id: z.string(),
  canvasDocId: z.string(),
  canvasTitle: z.string().default(""),
  canvasColor: z.number().catch(0),
  deletedBy: z.string(),
  deletedByUsername: z.string().default(""),
  deleteMode: z.string().default("soft"),
  deletedAt: z.string(),
  status: z.enum(["unread", "dismissed"]).default("unread"),
});

export const messagezSchema = z.object({
  invites: z.array(canvasInviteSchema).default([]),
  shares: z.array(canvasShareSchema).default([]),
  deletions: z.array(canvasDeletedNotifSchema).default([]),
  canvasInvitesFrom: z.enum(["everyone", "friends", "nobody"]).default("everyone"),
});

export type CanvasInvite = z.infer<typeof canvasInviteSchema>;
export type CanvasShare = z.infer<typeof canvasShareSchema>;
export type CanvasDeletedNotif = z.infer<typeof canvasDeletedNotifSchema>;
export type MessagezState = z.infer<typeof messagezSchema>;

/**
 * pixi container refs for a rendered knock row's action controls — kept
 * around (per requester node id, rebuilt every render) purely so the
 * dev-only test bridge (see `testHooks` in `create()`) can compute real
 * screen positions to click for e2e coverage, without hardcoding layout
 * math that would silently drift out of sync with the actual rendering.
 */
interface KnockRowRefs {
  roleToggleBtn: Container;
  approveBtn: Container;
  rejectBtn: Container;
  ignoreBtn: Container;
}

/**
 * dev-only hooks exposed on the widget controller (see boot.ts's
 * `mountMessagesOverlay()`, which copies this onto `window.__skeinTest.messagez`
 * under a DEV guard) so e2e tests can drive the knock row without brittle,
 * hand-computed pixel math.
 */
export interface MessagezTestHooks {
  /** global (screen-space) center position of a knock row's action button,
   *  or null if that knock isn't currently rendered. */
  getKnockActionGlobalPos(
    requesterNodeId: string,
    action: "roleToggle" | "approve" | "reject" | "ignore"
  ): { x: number; y: number } | null;
  /** requester node ids of every currently-visible pending-knock row. */
  getVisibleKnockRequesterIds(): string[];
  /** the rendered metadata line's text + hub-relay flag for a knock row,
   *  alongside the row's title ("{username} wants access") and free-text
   *  message — everything an e2e test needs to assert on rendered row
   *  content without reaching into pixi internals. */
  getKnockMetaInfo(
    requesterNodeId: string
  ): { text: string; isHub: boolean; title: string; message: string } | null;
  /** the currently-displayed late-admin-conflict notice text for a knock row
   *  (section 3.1/5.3), or null if no notice is showing. */
  getKnockNoticeText(requesterNodeId: string): string | null;
  /** the role currently selected in a knock row's member/viewer picker,
   *  or null if that knock isn't currently rendered. */
  getKnockRole(requesterNodeId: string): InvitableRole | null;
  /** simulate a `canvas-knock-ack` arriving this session (bypasses the real
   *  wire protocol) — used to test the requester's status banner. */
  simulateKnockAck(canvasDocId: string): void;
  /** simulate a knock having been relayed to us by `relayedBy` this session
   *  (bypasses the real wire protocol) — used to test the "via hub" vs.
   *  plain "relayed" attribution styling deterministically, without needing
   *  a real second relay peer. */
  simulateKnockRelay(canvasDocId: string, requesterNodeId: string, relayedBy: string): void;
}

// ---------------------------------------------------------------------------
// visual constants
// ---------------------------------------------------------------------------

const BG = 0x1a1a24;
const BORDER = 0x2a2a3e;
const TEXT_COLOR = 0xf0f0ff;
const MUTED_TEXT = 0x666678;
const ACCEPT_COLOR = 0x10b981;
const DECLINE_COLOR = 0xef4444;
const DELIVERED_COLOR = 0x3b82f6;
const CARD_RADIUS = 6;
const PADDING_X = 16;
const PADDING_Y = 14;
const TAB_HEIGHT = 28;
const TAB_FONT_SIZE = 11;
const TAB_ACTIVE_COLOR = 0xf0f0ff;
const TAB_INACTIVE_COLOR = 0x666678;
const ROW_HEIGHT = 80;
const ROW_PADDING_X = 10;

const THUMB_SIZE = 44;
const THUMB_RADIUS = 4;
const THUMB_MARGIN = 10;
const COLOR_STRIPE_WIDTH = 3;
const ROW_NAME_SIZE = 11;
const ROW_SUB_SIZE = 9;
const ROW_ALT_BG = 0x1f1f2c;
const SCROLL_SPEED = 30;
const ACTION_BTN_SIZE = 22;
const FONT = "system-ui, sans-serif";
const RESOLUTION = 3;

// knock (access-request) row — docs/knock-and-hub-relay-plan.md section 7.2.
// a distinct accent (violet, not reused from anywhere else in this file)
// keeps a knock row visually distinguishable from a canvas-invite row at a
// glance, even though it's structurally the same template.
const KNOCK_ACCENT = 0x8b5cf6;
const KNOCK_ROW_HEIGHT = 108;
// "via hub" attribution — section 7.3. reuses the theme's warning amber
// (see theme/skein-theme.ts's `hubRelayed` token doc comment for why).
const HUB_RELAYED_COLOR = defaultTheme.hubRelayed;
// how long a late-admin-conflict notice ("already approved/declined by...")
// stays on screen before the row is re-evaluated and (usually) disappears.
const KNOCK_NOTICE_DURATION_MS = 5000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "\u2026" : str;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// ignore (local-only dismissal) — docs/knock-and-hub-relay-plan.md section
// 3.1a. purely client-side: does NOT write to the canvas doc at all, just
// hides a knock from THIS admin's own view of the pending list, persisted
// across reloads via localStorage. no existing localStorage-wrapper utility
// in this codebase to reuse (checked — only utils/log.ts touches
// localStorage directly, with the same plain get/set-item style used here).
// ---------------------------------------------------------------------------

function dismissedKnocksKey(canvasDocId: string): string {
  return `skein.dismissedKnocks.${canvasDocId}`;
}

function getDismissedKnocks(canvasDocId: string): Set<string> {
  try {
    const raw = localStorage.getItem(dismissedKnocksKey(canvasDocId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function addDismissedKnock(canvasDocId: string, requesterNodeId: string): void {
  const dismissed = getDismissedKnocks(canvasDocId);
  dismissed.add(requesterNodeId);
  try {
    localStorage.setItem(dismissedKnocksKey(canvasDocId), JSON.stringify([...dismissed]));
  } catch {
    // best effort — if localStorage is unavailable or full, the knock just
    // won't stay dismissed across a reload, a safe fallback either way.
  }
}

// ---------------------------------------------------------------------------
// knock actions — call through the friendz bridge (friendz-bridge.ts) to
// reach approveKnock()/declineKnock() (standalone/friendz-wiring.ts, phase
// 2, not modified here). exported for a later UI task originally; this is
// the first real caller.
// ---------------------------------------------------------------------------

async function callApproveKnock(
  store: CanvasStore,
  requesterNodeId: string,
  role: InvitableRole,
  localNodeId: string
): Promise<void> {
  const protocol = getProtocol();
  const socialDoc = getKnockSocialDoc();
  if (!protocol || !socialDoc) {
    console.warn("[messagez] cannot approve knock — friendz bridge not ready yet");
    return;
  }
  await approveKnock({ protocol, store, socialDoc, localNodeId }, requesterNodeId, role);
}

async function callDeclineKnock(
  store: CanvasStore,
  requesterNodeId: string,
  localNodeId: string
): Promise<void> {
  const protocol = getProtocol();
  if (!protocol) {
    console.warn("[messagez] cannot decline knock — friendz bridge not ready yet");
    return;
  }
  await declineKnock({ protocol, store, localNodeId }, requesterNodeId);
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

export const messagezWidget: WidgetFactory<typeof messagezSchema> = {
  type: "messagez",
  metadata: {
    name: "messagez",
    description: "canvas invites and share activity",
    version: "0.1.0",
    category: "narthex",
    hidden: true,
    singleton: true,
    singletonId: "skein-messagez",
    defaultWidth: 560,
    defaultHeight: 280,
  },
  schema: messagezSchema,
  editableProps: [],

  create(ctx: WidgetMountContext<typeof messagezSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;

    // current view mode
    let viewMode: "inbox" | "outbox" = "inbox";

    // scroll state
    let scrollY = 0;

    // whether to show resolved (delivered/accepted/declined) items in outbox
    let showResolved = false;

    // whether to show accepted/declined invites in inbox
    let showAccepted = false;

    // invite ids accepted during the *current* time the messages panel has
    // been open — kept visible regardless of `showAccepted` so the user
    // gets a chance to actually open the newly-joined canvas (via the
    // "open" button below) instead of the row vanishing the instant
    // acceptance completes. cleared when the panel closes (onVisibilityChange
    // below) or when "open" is clicked, so hiding resumes as normal
    // (governed by `showAccepted`) the next time the panel is opened.
    const recentlyAcceptedIds = new Set<string>();

    // cache the local node id (resolved async)
    let localNodeId = "";
    getStoredIdentity().then((id) => {
      if (id) localNodeId = id.node_id;
    });

    // -----------------------------------------------------------------------
    // knock (access-request) row state — docs/knock-and-hub-relay-plan.md
    // section 7.2/7.3.
    // -----------------------------------------------------------------------

    // button refs per requester node id, rebuilt on every rebuildKnockRows()
    // call — used by the dev-only test bridge (see `testHooks` below) to
    // compute real screen positions to click.
    const knockRowRefs = new Map<string, KnockRowRefs>();
    // requester node id -> the role currently selected in that row's
    // member/viewer picker — read by the test bridge (`getKnockRole()`) so
    // e2e tests can verify the picker renders/toggles correctly.
    const knockRowRoles = new Map<string, InvitableRole>();
    // requester node id -> current row's metadata line text/hub-ness, for
    // the test bridge to assert on without re-deriving the same logic.
    const knockMetaInfo = new Map<
      string,
      { text: string; isHub: boolean; title: string; message: string }
    >();
    // late-admin-conflict notices (section 3.1/5.3), keyed by requester node
    // id — displayed in place of the action row for a few seconds, see
    // `setKnockNotice()`.
    const activeKnockNotices = new Map<string, string>();
    const knockNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function setKnockNotice(requesterNodeId: string, text: string): void {
      const existingTimer = knockNoticeTimers.get(requesterNodeId);
      if (existingTimer) clearTimeout(existingTimer);
      activeKnockNotices.set(requesterNodeId, text);
      const timer = setTimeout(() => {
        activeKnockNotices.delete(requesterNodeId);
        knockNoticeTimers.delete(requesterNodeId);
        layout(currentWidth, currentHeight);
      }, KNOCK_NOTICE_DURATION_MS);
      knockNoticeTimers.set(requesterNodeId, timer);
      layout(currentWidth, currentHeight);
    }

    // requester's own status view (section 7.1) — canvas doc ids for which a
    // canvas-knock-ack has arrived this session (live-only, see
    // friendz-bridge.ts's `hasKnockAckForCanvas()` doc comment). rendered as
    // a small banner in the outbox tab, reusing the outbox's existing
    // "delivered" visual language per the plan doc's guidance.
    const ackedKnockCanvasIds = new Set<string>();
    const unsubKnockAcked = onKnockAcked((info) => {
      if (!ackedKnockCanvasIds.has(info.canvasDocId)) {
        ackedKnockCanvasIds.add(info.canvasDocId);
        layout(currentWidth, currentHeight);
      }
    });

    // live "via hub"/"relayed" attribution (section 7.3) — relay info arrives
    // via `recordKnockRelay()` *after* the knock itself was already recorded
    // (and already triggered its own doc-change render, see
    // `wireKnockHandlers()`'s `onCanvasKnock` handler in friendz-wiring.ts),
    // so without this subscription a relayed knock's row would render once
    // with no attribution and never refresh to show it.
    const unsubKnockRelayed = onKnockRelayed(() => {
      layout(currentWidth, currentHeight);
    });

    // re-render whenever the currently-open canvas's own doc changes —
    // pendingKnocks lives there, not in the messagez doc this widget's
    // `ctx.doc` wraps (see docs/knock-and-hub-relay-plan.md section 1's
    // table for the asymmetry), so the existing `ctx.doc.on("change", ...)`
    // subscription below doesn't cover it.
    const unsubCanvasStore = ctx.canvasStore?.onChange(() => {
      layout(currentWidth, currentHeight);
    });

    // -----------------------------------------------------------------------
    // background card
    // -----------------------------------------------------------------------

    const cardBg = new Graphics();
    container.addChild(cardBg);

    const drawCard = (w: number, h: number) => {
      cardBg.clear();
      cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
      cardBg.fill({ color: BG });
      cardBg.stroke({ color: BORDER, width: 1 });
    };

    // -----------------------------------------------------------------------
    // tab bar
    // -----------------------------------------------------------------------

    const tabInboxText = new Text({
      text: "inbox",
      style: { fontFamily: FONT, fontSize: TAB_FONT_SIZE, fill: TAB_ACTIVE_COLOR },
      resolution: RESOLUTION,
    });
    tabInboxText.eventMode = "static";
    tabInboxText.cursor = "pointer";
    container.addChild(tabInboxText);

    const tabOutboxText = new Text({
      text: "outbox",
      style: { fontFamily: FONT, fontSize: TAB_FONT_SIZE, fill: TAB_INACTIVE_COLOR },
      resolution: RESOLUTION,
    });
    tabOutboxText.eventMode = "static";
    tabOutboxText.cursor = "pointer";
    container.addChild(tabOutboxText);

    const tabUnderline = new Graphics();
    container.addChild(tabUnderline);

    // "clear all" button — right side of tab bar
    const clearAllText = new Text({
      text: "clear all",
      style: { fontFamily: FONT, fontSize: TAB_FONT_SIZE - 1, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    clearAllText.eventMode = "static";
    clearAllText.cursor = "pointer";
    clearAllText.visible = false;
    container.addChild(clearAllText);

    clearAllText.on("pointertap", (e) => {
      e.stopPropagation();
      ctx.doc.change((draft) => {
        if (viewMode === "inbox") {
          draft.invites = [];
        } else {
          draft.shares = [];
        }
      });
    });

    // "show resolved" / "hide resolved" toggle — outbox only
    const toggleResolvedText = new Text({
      text: "show resolved",
      style: { fontFamily: FONT, fontSize: TAB_FONT_SIZE - 1, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    toggleResolvedText.eventMode = "static";
    toggleResolvedText.cursor = "pointer";
    toggleResolvedText.visible = false;
    container.addChild(toggleResolvedText);

    toggleResolvedText.on("pointertap", (e) => {
      e.stopPropagation();
      showResolved = !showResolved;
      scrollY = 0;
      layout(currentWidth, currentHeight);
    });

    // "show accepted" / "hide accepted" toggle — inbox only
    const toggleAcceptedText = new Text({
      text: "show accepted",
      style: { fontFamily: FONT, fontSize: TAB_FONT_SIZE - 1, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    toggleAcceptedText.eventMode = "static";
    toggleAcceptedText.cursor = "pointer";
    toggleAcceptedText.visible = false;
    container.addChild(toggleAcceptedText);

    toggleAcceptedText.on("pointertap", (e) => {
      e.stopPropagation();
      showAccepted = !showAccepted;
      scrollY = 0;
      layout(currentWidth, currentHeight);
    });

    tabInboxText.on("pointertap", (e) => {
      e.stopPropagation();
      viewMode = "inbox";
      scrollY = 0;
      layout(currentWidth, currentHeight);
    });

    tabOutboxText.on("pointertap", (e) => {
      e.stopPropagation();
      viewMode = "outbox";
      scrollY = 0;
      layout(currentWidth, currentHeight);
    });

    const drawTabBar = (y: number, pendingCount: number) => {
      tabInboxText.text = pendingCount > 0 ? `inbox (${pendingCount})` : "inbox";

      tabInboxText.style.fill = viewMode === "inbox" ? TAB_ACTIVE_COLOR : TAB_INACTIVE_COLOR;
      tabOutboxText.style.fill = viewMode === "outbox" ? TAB_ACTIVE_COLOR : TAB_INACTIVE_COLOR;

      const tabGap = 16;
      tabInboxText.x = PADDING_X;
      tabInboxText.y = y + (TAB_HEIGHT - TAB_FONT_SIZE) / 2;

      tabOutboxText.x = tabInboxText.x + tabInboxText.width + tabGap;
      tabOutboxText.y = y + (TAB_HEIGHT - TAB_FONT_SIZE) / 2;

      tabUnderline.clear();
      let underX: number;
      let underW: number;
      if (viewMode === "inbox") {
        underX = tabInboxText.x;
        underW = tabInboxText.width;
      } else {
        underX = tabOutboxText.x;
        underW = tabOutboxText.width;
      }
      tabUnderline.moveTo(underX, y + TAB_HEIGHT - 2);
      tabUnderline.lineTo(underX + underW, y + TAB_HEIGHT - 2);
      tabUnderline.stroke({ color: TAB_ACTIVE_COLOR, width: 2 });

      tabInboxText.visible = true;
      tabOutboxText.visible = true;
      tabUnderline.visible = true;
    };

    // -----------------------------------------------------------------------
    // inbox list area (scrollable, masked)
    // -----------------------------------------------------------------------

    const inboxListContainer = new Container();
    inboxListContainer.eventMode = "static";
    container.addChild(inboxListContainer);

    const inboxListMask = new Graphics();
    container.addChild(inboxListMask);
    inboxListContainer.mask = inboxListMask;

    const inboxListInner = new Container();
    inboxListInner.eventMode = "static";
    inboxListContainer.addChild(inboxListInner);

    const inboxEmptyText = new Text({
      text: "no invites yet",
      style: { fontFamily: FONT, fontSize: 11, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    inboxEmptyText.eventMode = "none";
    container.addChild(inboxEmptyText);

    inboxListContainer.on("wheel", (e: WheelEvent) => {
      const canScroll = totalInboxHeight > inboxAreaHeight;
      if (!canScroll) return; // let the event pass through to the canvas viewport

      e.stopPropagation();
      // claim the native event so the viewport doesn't also pan
      if ((e as any).nativeEvent) (e as any).nativeEvent._skeinWidgetScroll = true;
      scrollY += e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED;
      clampInboxScroll();
      inboxListInner.y = -scrollY;
    });

    let inboxAreaY = 0;
    let inboxAreaHeight = 0;
    let totalInboxHeight = 0;

    const clampInboxScroll = () => {
      const maxScroll = Math.max(0, totalInboxHeight - inboxAreaHeight);
      scrollY = Math.max(0, Math.min(scrollY, maxScroll));
    };

    // -----------------------------------------------------------------------
    // outbox list area (scrollable, masked)
    // -----------------------------------------------------------------------

    const outboxListContainer = new Container();
    outboxListContainer.eventMode = "static";
    container.addChild(outboxListContainer);

    const outboxListMask = new Graphics();
    container.addChild(outboxListMask);
    outboxListContainer.mask = outboxListMask;

    const outboxListInner = new Container();
    outboxListInner.eventMode = "static";
    outboxListContainer.addChild(outboxListInner);

    const outboxEmptyText = new Text({
      text: "no shares yet",
      style: { fontFamily: FONT, fontSize: 11, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    outboxEmptyText.eventMode = "none";
    container.addChild(outboxEmptyText);

    // requester's own knock status view (section 7.1) — a small banner
    // shown once a canvas-knock-ack arrives, reusing the outbox's existing
    // "delivered" visual language (per the plan doc's guidance) rather than
    // inventing a new status state. per the silent-rejection policy, this
    // never distinguishes "declined" from "still pending" — an ack just
    // means "your request was received," nothing more.
    const knockAckBannerText = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: DELIVERED_COLOR },
      resolution: RESOLUTION,
    });
    knockAckBannerText.eventMode = "none";
    knockAckBannerText.visible = false;
    container.addChild(knockAckBannerText);

    outboxListContainer.on("wheel", (e: WheelEvent) => {
      const canScroll = totalOutboxHeight > outboxAreaHeight;
      if (!canScroll) return; // let the event pass through to the canvas viewport

      e.stopPropagation();
      // claim the native event so the viewport doesn't also pan
      if ((e as any).nativeEvent) (e as any).nativeEvent._skeinWidgetScroll = true;
      scrollY += e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED;
      clampOutboxScroll();
      outboxListInner.y = -scrollY;
    });

    let outboxAreaY = 0;
    let outboxAreaHeight = 0;
    let totalOutboxHeight = 0;

    const clampOutboxScroll = () => {
      const maxScroll = Math.max(0, totalOutboxHeight - outboxAreaHeight);
      scrollY = Math.max(0, Math.min(scrollY, maxScroll));
    };

    // -----------------------------------------------------------------------
    // rebuild inbox rows
    // -----------------------------------------------------------------------

    const rebuildInboxRows = (invites: CanvasInvite[], contentW: number) => {
      while (inboxListInner.children.length > 0) {
        inboxListInner.removeChildAt(0).destroy({ children: true });
      }

      // sort: pending first, then by receivedAt descending
      const sorted = [...invites].sort((a, b) => {
        if (a.status === "pending" && b.status !== "pending") return -1;
        if (a.status !== "pending" && b.status === "pending") return 1;
        return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
      });

      const leftW = COLOR_STRIPE_WIDTH + 4 + THUMB_SIZE + THUMB_MARGIN;
      const maxNameChars = Math.max(
        6,
        Math.floor((contentW - leftW - ACTION_BTN_SIZE * 2 - 40) / (ROW_NAME_SIZE * 0.55))
      );

      for (let i = 0; i < sorted.length; i++) {
        const invite = sorted[i];
        const rowY = i * ROW_HEIGHT;

        const rowContainer = new Container();
        rowContainer.eventMode = "static";
        rowContainer.y = rowY;
        inboxListInner.addChild(rowContainer);

        // alternating row background
        const rowBg = new Graphics();
        rowBg.eventMode = "none";
        if (i % 2 === 1) {
          rowBg.rect(0, 0, contentW, ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
        }
        rowContainer.addChild(rowBg);

        // thumbnail area
        const thumbColor = isTransparent(invite.canvasColor)
          ? BORDER
          : safeColor(invite.canvasColor);
        const thumbX = COLOR_STRIPE_WIDTH + 4;
        const thumbY = (ROW_HEIGHT - THUMB_SIZE) / 2;

        // color stripe on left edge
        const stripe = new Graphics();
        stripe.eventMode = "none";
        stripe.rect(0, 0, COLOR_STRIPE_WIDTH, ROW_HEIGHT);
        stripe.fill({ color: thumbColor });
        rowContainer.addChild(stripe);

        if (invite.canvasPreviewUrl) {
          // placeholder bg while loading
          const thumbBg = new Graphics();
          thumbBg.eventMode = "none";
          thumbBg.roundRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, THUMB_RADIUS);
          thumbBg.fill({ color: thumbColor, alpha: 0.15 });
          rowContainer.addChild(thumbBg);

          // async load — fire and forget, will render when ready
          Assets.load<Texture>(invite.canvasPreviewUrl)
            .then((texture) => {
              if (!rowContainer.destroyed) {
                const sprite = new Sprite(texture);
                const scale = Math.max(THUMB_SIZE / texture.width, THUMB_SIZE / texture.height);
                sprite.width = texture.width * scale;
                sprite.height = texture.height * scale;
                sprite.x = thumbX + (THUMB_SIZE - sprite.width) / 2;
                sprite.y = thumbY + (THUMB_SIZE - sprite.height) / 2;
                sprite.eventMode = "none";
                // clip to rounded rect
                const mask = new Graphics();
                mask.roundRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, THUMB_RADIUS);
                mask.fill({ color: 0xffffff });
                rowContainer.addChild(mask);
                sprite.mask = mask;
                rowContainer.addChild(sprite);
              }
            })
            .catch(() => {});
        } else {
          // solid color thumbnail with canvas title initial
          const thumbBg = new Graphics();
          thumbBg.eventMode = "none";
          thumbBg.roundRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, THUMB_RADIUS);
          thumbBg.fill({ color: thumbColor, alpha: 0.25 });
          rowContainer.addChild(thumbBg);

          const titleInitial = (invite.canvasTitle || "?").charAt(0).toUpperCase();
          const thumbLetter = new Text({
            text: titleInitial,
            style: {
              fontFamily: FONT,
              fontSize: 14,
              fontWeight: "bold",
              fill: thumbColor,
              align: "center",
            },
            resolution: RESOLUTION,
          });
          thumbLetter.eventMode = "none";
          thumbLetter.anchor.set(0.5);
          thumbLetter.x = thumbX + THUMB_SIZE / 2;
          thumbLetter.y = thumbY + THUMB_SIZE / 2;
          rowContainer.addChild(thumbLetter);
        }

        // text content
        const textX = leftW;
        const hasDesc = !!invite.canvasDescription;

        // line 1: canvas title (bold)
        const titleLabel = invite.canvasTitle
          ? truncate(invite.canvasTitle, maxNameChars)
          : "untitled canvas";

        const titleText = new Text({
          text: titleLabel,
          style: {
            fontFamily: FONT,
            fontSize: ROW_NAME_SIZE,
            fontWeight: "bold",
            fill: TEXT_COLOR,
          },
          resolution: RESOLUTION,
        });
        titleText.eventMode = "none";
        titleText.x = textX;
        titleText.y = hasDesc ? 12 : 22;
        rowContainer.addChild(titleText);

        // line 2: description (only if present)
        if (hasDesc) {
          const descText = new Text({
            text: truncate(invite.canvasDescription, maxNameChars),
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          descText.eventMode = "none";
          descText.x = textX;
          descText.y = 30;
          rowContainer.addChild(descText);
        }

        // line 3: from: username  ·  time  ·  relayed/via hub
        const displayName = invite.fromUsername || invite.fromNodeId.slice(0, 8);
        // hub-ness (section 7.3) is only knowable for the currently-open
        // canvas's own CanvasStore (`hubNodeIds` lives per-canvas-doc) — an
        // invite for a different canvas than the one currently open falls
        // back to the plain "relayed" suffix, same as before this feature.
        const isHubInvite =
          !!invite.relayedBy &&
          !!ctx.canvasStore &&
          ctx.canvasStore.handle.documentId === invite.canvasDocId &&
          ctx.canvasStore.isHubNode(invite.relayedBy);
        let metaLabel = `from: ${displayName}  \u00b7  ${relativeTime(invite.receivedAt)}`;
        if (isHubInvite) metaLabel += " \u00b7 via hub";
        else if (invite.relayedBy) metaLabel += " \u00b7 relayed";

        const metaText = new Text({
          text: metaLabel,
          style: {
            fontFamily: FONT,
            fontSize: ROW_SUB_SIZE,
            fill: isHubInvite ? HUB_RELAYED_COLOR : MUTED_TEXT,
          },
          resolution: RESOLUTION,
        });
        metaText.eventMode = "none";
        metaText.x = textX;
        metaText.y = hasDesc ? 47 : 42;
        rowContainer.addChild(metaText);

        // right side — depends on status
        if (invite.status === "pending") {
          // accept button (outlined rounded rect with text label)
          const acceptBtn = new Container();
          acceptBtn.eventMode = "static";
          acceptBtn.cursor = "pointer";
          const acceptW = 52;
          const acceptH = 22;
          acceptBtn.hitArea = new Rectangle(0, 0, acceptW, acceptH);
          acceptBtn.x = contentW - acceptW - 52 - ROW_PADDING_X - 16;
          acceptBtn.y = (ROW_HEIGHT - acceptH) / 2;

          const acceptBg = new Graphics();
          acceptBg.eventMode = "none";
          acceptBg.roundRect(0, 0, acceptW, acceptH, 4);
          acceptBg.fill({ color: 0x111118 });
          acceptBg.stroke({ color: ACCEPT_COLOR, width: 1.5 });
          acceptBtn.addChild(acceptBg);

          const acceptLabel = new Text({
            text: "accept",
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: ACCEPT_COLOR },
            resolution: RESOLUTION,
          });
          acceptLabel.eventMode = "none";
          acceptLabel.anchor.set(0.5);
          acceptLabel.x = acceptW / 2;
          acceptLabel.y = acceptH / 2;
          acceptBtn.addChild(acceptLabel);

          acceptBtn.on("pointertap", (e) => {
            e.stopPropagation();

            // never accept through an implicitly-generated identity - the
            // user must set one up first (profile widget's "generate
            // identity"/"import" actions). `localNodeId` is resolved once
            // at mount from getStoredIdentity() (see above), so an empty
            // value here means no identity exists yet.
            if (!localNodeId) {
              acceptLabel.text = "no identity";
              acceptLabel.x = acceptW / 2;
              return;
            }

            // immediate visual feedback — pulsing animation
            acceptBtn.eventMode = "none";
            acceptBtn.cursor = "default";
            acceptLabel.text = "joining...";
            acceptLabel.x = acceptW / 2;

            // pulse opacity animation
            let pulseUp = false;
            const pulseTimer = setInterval(() => {
              if (pulseUp) {
                acceptBtn.alpha = Math.min(acceptBtn.alpha + 0.05, 1.0);
                if (acceptBtn.alpha >= 1.0) pulseUp = false;
              } else {
                acceptBtn.alpha = Math.max(acceptBtn.alpha - 0.05, 0.3);
                if (acceptBtn.alpha <= 0.3) pulseUp = true;
              }
            }, 50);

            const inviteId = invite.id;
            const canvasDocId = invite.canvasDocId;
            const fromNode = invite.fromNodeId;

            // send accept notification to the peer (fire-and-forget)
            sendCanvasInviteAccept(fromNode, {
              inviteId,
              canvasDocId,
              accepterNodeId: localNodeId,
            }).catch((err) => {
              console.warn("[inbox] failed to send accept message:", err);
            });

            // listen for confirmation from boot.ts
            const cleanup = () => {
              clearInterval(pulseTimer);
              acceptBtn.alpha = 1.0;
              window.removeEventListener(
                "skein:accept-canvas-invite-done",
                onDone as EventListener
              );
              clearTimeout(timeout);
            };

            const onDone = (evt: CustomEvent) => {
              if (evt.detail?.canvasDocId !== canvasDocId) return;
              cleanup();
              // NOW change invite status
              ctx.doc.change((draft) => {
                const inv = draft.invites.find(
                  (r: CanvasInvite) => r.id === inviteId && r.status === "pending"
                );
                if (inv) inv.status = "accepted";
              });
              // keep this row visible (with an "open" button) even though
              // `showAccepted` may be off — see recentlyAcceptedIds' doc
              // comment above.
              recentlyAcceptedIds.add(inviteId);
              layout(currentWidth, currentHeight);
            };

            const timeout = setTimeout(() => {
              cleanup();
              // timeout — re-enable button so user can retry
              acceptBtn.eventMode = "static";
              acceptBtn.cursor = "pointer";
              acceptLabel.text = "retry";
              acceptLabel.x = acceptW / 2;
              console.warn("[inbox] accept timed out for canvas:", canvasDocId);
            }, 15000);

            window.addEventListener("skein:accept-canvas-invite-done", onDone as EventListener);

            // dispatch the accept event to boot.ts. `relayedBy` (the hub
            // that relayed this invite, if any — see canvasInviteSchema) is
            // included so boot.ts can fall back to connecting through the
            // hub when the original inviter (`fromNodeId`) is still offline
            // — otherwise a hub-relayed invite's accept can never durably
            // record itself anywhere (see boot.ts's acceptCanvasInvite doc
            // comment for the full "stuck pending forever" bug this fixes).
            window.dispatchEvent(
              new CustomEvent("skein:accept-canvas-invite", {
                detail: {
                  canvasDocId: invite.canvasDocId,
                  fromNodeId: invite.fromNodeId,
                  canvasTitle: invite.canvasTitle,
                  canvasDescription: invite.canvasDescription ?? "",
                  canvasColor: invite.canvasColor ?? 0,
                  canvasPreviewUrl: invite.canvasPreviewUrl ?? "",
                  fromUsername: invite.fromUsername ?? "",
                  relayedBy: invite.relayedBy || "",
                  role: invite.role,
                },
              })
            );
          });
          rowContainer.addChild(acceptBtn);

          // decline button (outlined rounded rect with text label)
          const declineW = 52;
          const declineH = 22;
          const declineBtn = new Container();
          declineBtn.eventMode = "static";
          declineBtn.cursor = "pointer";
          declineBtn.hitArea = new Rectangle(0, 0, declineW, declineH);
          declineBtn.x = contentW - declineW - ROW_PADDING_X;
          declineBtn.y = (ROW_HEIGHT - declineH) / 2;

          const declineBg = new Graphics();
          declineBg.eventMode = "none";
          declineBg.roundRect(0, 0, declineW, declineH, 4);
          declineBg.fill({ color: 0x111118 });
          declineBg.stroke({ color: DECLINE_COLOR, width: 1.5 });
          declineBtn.addChild(declineBg);

          const declineLabel = new Text({
            text: "decline",
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: DECLINE_COLOR },
            resolution: RESOLUTION,
          });
          declineLabel.eventMode = "none";
          declineLabel.anchor.set(0.5);
          declineLabel.x = declineW / 2;
          declineLabel.y = declineH / 2;
          declineBtn.addChild(declineLabel);

          declineBtn.on("pointertap", (e) => {
            e.stopPropagation();
            const inviteId = invite.id;
            const canvasDocId = invite.canvasDocId;
            const fromNode = invite.fromNodeId;
            sendCanvasInviteDecline(fromNode, {
              inviteId,
              canvasDocId,
              declinerNodeId: localNodeId,
            }).catch((err) => {
              console.warn("[inbox] failed to decline canvas invite:", err);
            });
            ctx.doc.change((draft) => {
              const inv = draft.invites.find(
                (r: CanvasInvite) => r.id === inviteId && r.status === "pending"
              );
              if (inv) inv.status = "declined";
            });
          });
          rowContainer.addChild(declineBtn);
        } else if (invite.status === "accepted") {
          const statusIcon = new Text({
            text: "\u2713",
            style: { fontFamily: FONT, fontSize: 12, fontWeight: "bold", fill: ACCEPT_COLOR },
            resolution: RESOLUTION,
          });
          statusIcon.eventMode = "none";
          statusIcon.x = contentW - ROW_PADDING_X - 70;
          statusIcon.y = (ROW_HEIGHT - 12) / 2;
          rowContainer.addChild(statusIcon);

          const statusLabel = new Text({
            text: "accepted",
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          statusLabel.eventMode = "none";
          statusLabel.x = statusIcon.x + 16;
          statusLabel.y = (ROW_HEIGHT - ROW_SUB_SIZE) / 2;
          rowContainer.addChild(statusLabel);

          // re-add button: an already-accepted invite's canvas-card can
          // still be deleted from the narthex later (a normal, separate
          // action) — `acceptCanvasInvite()` (boot.ts) is idempotent (it
          // checks whether a card for this canvasDocId already exists), so
          // re-running the exact same accept flow is a safe, correct way
          // to restore the card without needing a whole separate
          // "re-invite" round trip from the original sender.
          const reAddW = 52;
          const reAddH = 20;
          const reAddBtn = new Container();
          reAddBtn.eventMode = "static";
          reAddBtn.cursor = "pointer";
          reAddBtn.hitArea = new Rectangle(0, 0, reAddW, reAddH);
          reAddBtn.x = contentW - reAddW - ROW_PADDING_X;
          reAddBtn.y = ROW_HEIGHT - reAddH - 4;

          const reAddBg = new Graphics();
          reAddBg.eventMode = "none";
          reAddBg.roundRect(0, 0, reAddW, reAddH, 4);
          reAddBg.fill({ color: 0x111118 });
          reAddBg.stroke({ color: ACCEPT_COLOR, width: 1.5 });
          reAddBtn.addChild(reAddBg);

          const reAddLabel = new Text({
            text: "re-add",
            style: { fontFamily: FONT, fontSize: 9, fill: ACCEPT_COLOR },
            resolution: RESOLUTION,
          });
          reAddLabel.eventMode = "none";
          reAddLabel.anchor.set(0.5);
          reAddLabel.x = reAddW / 2;
          reAddLabel.y = reAddH / 2;
          reAddBtn.addChild(reAddLabel);

          reAddBtn.on("pointertap", (e) => {
            e.stopPropagation();
            reAddBtn.eventMode = "none";
            reAddBtn.cursor = "default";
            reAddLabel.text = "\u2026";

            const cleanup = () => {
              window.removeEventListener("skein:accept-canvas-invite-done", onDone as EventListener);
              clearTimeout(timeout);
            };
            const onDone = (evt: CustomEvent) => {
              if (evt.detail?.canvasDocId !== invite.canvasDocId) return;
              cleanup();
              if (!reAddBtn.destroyed) {
                reAddBtn.eventMode = "static";
                reAddBtn.cursor = "pointer";
                reAddLabel.text = "re-add";
              }
            };
            const timeout = setTimeout(() => {
              cleanup();
              if (!reAddBtn.destroyed) {
                reAddBtn.eventMode = "static";
                reAddBtn.cursor = "pointer";
                reAddLabel.text = "re-add";
              }
            }, 15000);
            window.addEventListener("skein:accept-canvas-invite-done", onDone as EventListener);

            window.dispatchEvent(
              new CustomEvent("skein:accept-canvas-invite", {
                detail: {
                  canvasDocId: invite.canvasDocId,
                  fromNodeId: invite.fromNodeId,
                  canvasTitle: invite.canvasTitle,
                  canvasDescription: invite.canvasDescription ?? "",
                  canvasColor: invite.canvasColor ?? 0,
                  canvasPreviewUrl: invite.canvasPreviewUrl ?? "",
                  fromUsername: invite.fromUsername ?? "",
                  relayedBy: invite.relayedBy || "",
                  role: invite.role,
                },
              })
            );
          });
          rowContainer.addChild(reAddBtn);

          // open button — lets the user actually navigate to the just-
          // joined canvas while its row is still forced-visible (see
          // recentlyAcceptedIds above), instead of having to hunt for its
          // narthex canvas-card. real hash navigation, same mechanism
          // clicking a canvas-card itself uses (SkeinRouter.onHashChange()
          // in boot.ts).
          const openW = 52;
          const openH = 20;
          const openBtn = new Container();
          openBtn.eventMode = "static";
          openBtn.cursor = "pointer";
          openBtn.hitArea = new Rectangle(0, 0, openW, openH);
          openBtn.x = reAddBtn.x - openW - 6;
          openBtn.y = ROW_HEIGHT - openH - 4;

          const openBg = new Graphics();
          openBg.eventMode = "none";
          openBg.roundRect(0, 0, openW, openH, 4);
          openBg.fill({ color: 0x111118 });
          openBg.stroke({ color: MUTED_TEXT, width: 1.5 });
          openBtn.addChild(openBg);

          const openLabel = new Text({
            text: "open",
            style: { fontFamily: FONT, fontSize: 9, fill: TEXT_COLOR },
            resolution: RESOLUTION,
          });
          openLabel.eventMode = "none";
          openLabel.anchor.set(0.5);
          openLabel.x = openW / 2;
          openLabel.y = openH / 2;
          openBtn.addChild(openLabel);

          openBtn.on("pointertap", (e) => {
            e.stopPropagation();
            recentlyAcceptedIds.delete(invite.id);
            window.location.hash = invite.canvasDocId;
          });
          rowContainer.addChild(openBtn);
        } else if (invite.status === "declined") {
          const statusIcon = new Text({
            text: "\u00d7",
            style: { fontFamily: FONT, fontSize: 13, fontWeight: "bold", fill: DECLINE_COLOR },
            resolution: RESOLUTION,
          });
          statusIcon.eventMode = "none";
          statusIcon.x = contentW - ROW_PADDING_X - 65;
          statusIcon.y = (ROW_HEIGHT - 13) / 2;
          rowContainer.addChild(statusIcon);

          const statusLabel = new Text({
            text: "declined",
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          statusLabel.eventMode = "none";
          statusLabel.x = statusIcon.x + 16;
          statusLabel.y = (ROW_HEIGHT - ROW_SUB_SIZE) / 2;
          rowContainer.addChild(statusLabel);
        }
      }

      totalInboxHeight = sorted.length * ROW_HEIGHT;
    };

    // -----------------------------------------------------------------------
    // rebuild pending-knock rows (docs/knock-and-hub-relay-plan.md section 7.2)
    //
    // structurally the same template as an invite row (identity area, a
    // metadata line, action buttons) but reads from the currently-open
    // canvas's own `CanvasStore` rather than this widget's own `ctx.doc` —
    // see the asymmetry note above `visibleKnocks` in layout().
    // -----------------------------------------------------------------------

    const rebuildKnockRows = (
      knocks: PendingCanvasKnock[],
      contentW: number,
      startY: number
    ): number => {
      const store = ctx.canvasStore;
      knockRowRefs.clear();
      knockMetaInfo.clear();
      knockRowRoles.clear();
      if (!store) return 0;
      const canvasDocId = store.handle.documentId;

      // newest first
      const sorted = [...knocks].sort(
        (a, b) => new Date(b.knockedAt).getTime() - new Date(a.knockedAt).getTime()
      );

      const leftW = COLOR_STRIPE_WIDTH + 4 + THUMB_SIZE + THUMB_MARGIN;
      const textX = leftW;
      const maxMsgChars = Math.max(10, Math.floor((contentW - leftW - 20) / (ROW_SUB_SIZE * 0.55)));

      for (let i = 0; i < sorted.length; i++) {
        const knock = sorted[i];
        const rowY = startY + i * KNOCK_ROW_HEIGHT;

        const rowContainer = new Container();
        rowContainer.eventMode = "static";
        rowContainer.y = rowY;
        inboxListInner.addChild(rowContainer);

        const rowBg = new Graphics();
        rowBg.eventMode = "none";
        if (i % 2 === 1) {
          rowBg.rect(0, 0, contentW, KNOCK_ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
        }
        rowContainer.addChild(rowBg);

        // color stripe — a distinct accent (not reused elsewhere in this
        // file) so a knock row reads as visually different from a
        // canvas-invite row at a glance.
        const stripe = new Graphics();
        stripe.eventMode = "none";
        stripe.rect(0, 0, COLOR_STRIPE_WIDTH, KNOCK_ROW_HEIGHT);
        stripe.fill({ color: KNOCK_ACCENT });
        rowContainer.addChild(stripe);

        // identity area — no canvas thumbnail makes sense here (a knock has
        // no canvas preview to show), so this slot shows the requester's
        // own identity instead: an initial-letter avatar.
        const displayName = knock.requesterUsername || knock.requesterNodeId.slice(0, 8);
        const avatarX = COLOR_STRIPE_WIDTH + 4;
        const avatarY = (KNOCK_ROW_HEIGHT - THUMB_SIZE) / 2;

        const avatarBg = new Graphics();
        avatarBg.eventMode = "none";
        avatarBg.circle(avatarX + THUMB_SIZE / 2, avatarY + THUMB_SIZE / 2, THUMB_SIZE / 2);
        avatarBg.fill({ color: KNOCK_ACCENT, alpha: 0.25 });
        rowContainer.addChild(avatarBg);

        const avatarLetter = new Text({
          text: (displayName.charAt(0) || "?").toUpperCase(),
          style: {
            fontFamily: FONT,
            fontSize: 14,
            fontWeight: "bold",
            fill: KNOCK_ACCENT,
            align: "center",
          },
          resolution: RESOLUTION,
        });
        avatarLetter.eventMode = "none";
        avatarLetter.anchor.set(0.5);
        avatarLetter.x = avatarX + THUMB_SIZE / 2;
        avatarLetter.y = avatarY + THUMB_SIZE / 2;
        rowContainer.addChild(avatarLetter);

        // line 1: "{username} wants access"
        const titleText = new Text({
          text: `${displayName} wants access`,
          style: {
            fontFamily: FONT,
            fontSize: ROW_NAME_SIZE,
            fontWeight: "bold",
            fill: TEXT_COLOR,
          },
          resolution: RESOLUTION,
        });
        titleText.eventMode = "none";
        titleText.x = textX;
        titleText.y = 8;
        rowContainer.addChild(titleText);

        // line 2: the knock's free-text message — new content, no existing
        // row shows a message body today.
        const msgText = new Text({
          text: truncate(knock.message, maxMsgChars),
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        msgText.eventMode = "none";
        msgText.x = textX;
        msgText.y = 25;
        rowContainer.addChild(msgText);

        // line 3: from: username · time · relayed/via hub (section 7.3)
        const relayedBy = getKnockRelayedBy(canvasDocId, knock.requesterNodeId);
        const isHub = !!relayedBy && store.isHubNode(relayedBy);
        let metaLabel = `from: ${displayName}  \u00b7  ${relativeTime(knock.knockedAt)}`;
        if (isHub) metaLabel += " \u00b7 via hub";
        else if (relayedBy) metaLabel += " \u00b7 relayed";
        knockMetaInfo.set(knock.requesterNodeId, {
          text: metaLabel,
          isHub,
          title: titleText.text,
          message: msgText.text,
        });

        const metaText = new Text({
          text: metaLabel,
          style: {
            fontFamily: FONT,
            fontSize: ROW_SUB_SIZE,
            fill: isHub ? HUB_RELAYED_COLOR : MUTED_TEXT,
          },
          resolution: RESOLUTION,
        });
        metaText.eventMode = "none";
        metaText.x = textX;
        metaText.y = 41;
        rowContainer.addChild(metaText);

        const actionsY = KNOCK_ROW_HEIGHT - 30;

        // late-admin conflict notice (section 3.1/5.3) — shown in place of
        // the action row for a few seconds instead of the buttons.
        const notice = activeKnockNotices.get(knock.requesterNodeId);
        if (notice) {
          const noticeText = new Text({
            text: notice,
            style: {
              fontFamily: FONT,
              fontSize: ROW_SUB_SIZE,
              fontWeight: "bold",
              fill: defaultTheme.warning,
            },
            resolution: RESOLUTION,
          });
          noticeText.eventMode = "none";
          noticeText.x = textX;
          noticeText.y = actionsY + 4;
          rowContainer.addChild(noticeText);
          continue;
        }

        let currentRole: InvitableRole = "member";
        knockRowRoles.set(knock.requesterNodeId, currentRole);
        const btnH = 22;
        const gap = 8;

        // only the canvas's admin may approve/reject a knock (previously
        // unenforced anywhere — any peer viewing the canvas could grant a
        // stranger access). "ignore" stays available to everyone since
        // it's a purely local dismissal, not a real decision — see its own
        // comment below. defense in depth: `friendz-wiring.ts`'s
        // `approveKnock()`/`declineKnock()` also enforce this — this is
        // just the UI-level gate so a non-admin doesn't see buttons that
        // would fail anyway.
        const isAdminHere = store.isAdmin(localNodeId);

        if (!isAdminHere) {
          const adminOnlyLabel = new Text({
            text: "only the canvas admin can decide",
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          adminOnlyLabel.eventMode = "none";
          adminOnlyLabel.x = textX;
          adminOnlyLabel.y = actionsY + (btnH - ROW_SUB_SIZE) / 2;
          rowContainer.addChild(adminOnlyLabel);
        }

        // role picker — member <-> viewer, same idea as share-dialog.ts's
        // invite-friend role toggle (buildRoleToggle()); reimplemented
        // locally since that helper isn't exported from that file.
        const roleToggleW = 52;
        const roleToggleBtn = new Container();
        roleToggleBtn.eventMode = "static";
        roleToggleBtn.cursor = "pointer";
        roleToggleBtn.hitArea = new Rectangle(0, 0, roleToggleW, btnH);
        roleToggleBtn.x = textX;
        roleToggleBtn.y = actionsY;

        const roleToggleBg = new Graphics();
        const roleToggleLabel = new Text({
          text: currentRole,
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: 0xcbd5e1 },
          resolution: RESOLUTION,
        });
        roleToggleLabel.eventMode = "none";
        const drawRoleToggle = () => {
          roleToggleBg.clear();
          roleToggleBg.roundRect(0, 0, roleToggleW, btnH, 4);
          roleToggleBg.fill({ color: 0x27272a });
          roleToggleBg.stroke({ color: 0x3f3f46, width: 1 });
          roleToggleLabel.text = currentRole;
          roleToggleLabel.x = (roleToggleW - roleToggleLabel.width) / 2;
          roleToggleLabel.y = (btnH - roleToggleLabel.height) / 2;
        };
        drawRoleToggle();
        roleToggleBtn.addChild(roleToggleBg);
        roleToggleBtn.addChild(roleToggleLabel);
        roleToggleBtn.on("pointertap", (e) => {
          e.stopPropagation();
          currentRole = currentRole === "member" ? "viewer" : "member";
          knockRowRoles.set(knock.requesterNodeId, currentRole);
          drawRoleToggle();
        });
        if (isAdminHere) rowContainer.addChild(roleToggleBtn);

        // approve button
        const approveW = 56;
        const approveBtn = new Container();
        approveBtn.eventMode = "static";
        approveBtn.cursor = "pointer";
        approveBtn.hitArea = new Rectangle(0, 0, approveW, btnH);
        approveBtn.x = roleToggleBtn.x + roleToggleW + gap;
        approveBtn.y = actionsY;

        const approveBg = new Graphics();
        approveBg.roundRect(0, 0, approveW, btnH, 4);
        approveBg.fill({ color: 0x111118 });
        approveBg.stroke({ color: ACCEPT_COLOR, width: 1.5 });
        approveBtn.addChild(approveBg);

        const approveLabel = new Text({
          text: "approve",
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: ACCEPT_COLOR },
          resolution: RESOLUTION,
        });
        approveLabel.eventMode = "none";
        approveLabel.anchor.set(0.5);
        approveLabel.x = approveW / 2;
        approveLabel.y = btnH / 2;
        approveBtn.addChild(approveLabel);
        if (isAdminHere) rowContainer.addChild(approveBtn);

        // reject button — a real, synced decline (section 3.1a), distinct
        // from "ignore" below.
        const rejectW = 52;
        const rejectBtn = new Container();
        rejectBtn.eventMode = "static";
        rejectBtn.cursor = "pointer";
        rejectBtn.hitArea = new Rectangle(0, 0, rejectW, btnH);
        rejectBtn.x = approveBtn.x + approveW + gap;
        rejectBtn.y = actionsY;

        const rejectBg = new Graphics();
        rejectBg.roundRect(0, 0, rejectW, btnH, 4);
        rejectBg.fill({ color: 0x111118 });
        rejectBg.stroke({ color: DECLINE_COLOR, width: 1.5 });
        rejectBtn.addChild(rejectBg);

        const rejectLabel = new Text({
          text: "reject",
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: DECLINE_COLOR },
          resolution: RESOLUTION,
        });
        rejectLabel.eventMode = "none";
        rejectLabel.anchor.set(0.5);
        rejectLabel.x = rejectW / 2;
        rejectLabel.y = btnH / 2;
        rejectBtn.addChild(rejectLabel);
        if (isAdminHere) rowContainer.addChild(rejectBtn);

        // ignore button — purely local dismissal (section 3.1a): does NOT
        // call CanvasStore/the protocol at all, just hides this knock from
        // this admin's own view (see getDismissedKnocks()/addDismissedKnock()).
        // available to everyone (not just the canvas admin) since it has no
        // effect on the actual knock decision, just this viewer's own list.
        const ignoreW = 52;
        const ignoreBtn = new Container();
        ignoreBtn.eventMode = "static";
        ignoreBtn.cursor = "pointer";
        ignoreBtn.hitArea = new Rectangle(0, 0, ignoreW, btnH);
        ignoreBtn.x = isAdminHere ? rejectBtn.x + rejectW + gap : textX;
        ignoreBtn.y = actionsY;

        const ignoreBg = new Graphics();
        ignoreBg.roundRect(0, 0, ignoreW, btnH, 4);
        ignoreBg.fill({ color: 0x111118 });
        ignoreBg.stroke({ color: MUTED_TEXT, width: 1.5 });
        ignoreBtn.addChild(ignoreBg);

        const ignoreLabel = new Text({
          text: "ignore",
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        ignoreLabel.eventMode = "none";
        ignoreLabel.anchor.set(0.5);
        ignoreLabel.x = ignoreW / 2;
        ignoreLabel.y = btnH / 2;
        ignoreBtn.addChild(ignoreLabel);
        rowContainer.addChild(ignoreBtn);

        knockRowRefs.set(knock.requesterNodeId, {
          roleToggleBtn,
          approveBtn,
          rejectBtn,
          ignoreBtn,
        });

        const disableActions = () => {
          roleToggleBtn.eventMode = "none";
          approveBtn.eventMode = "none";
          rejectBtn.eventMode = "none";
          ignoreBtn.eventMode = "none";
        };

        const requesterNodeId = knock.requesterNodeId;

        approveBtn.on("pointertap", (e) => {
          e.stopPropagation();
          disableActions();
          approveLabel.text = "approving\u2026";
          approveLabel.x = approveW / 2;
          const chosenRole = currentRole;
          (async () => {
            await callApproveKnock(store, requesterNodeId, chosenRole, localNodeId);
            const updated = store.doc().pendingKnocks?.[requesterNodeId];
            if (updated) {
              const resolved = store.resolveKnockDecision(updated);
              if (resolved.outcome !== "approved" || resolved.decidedBy !== localNodeId) {
                const verb = resolved.outcome === "approved" ? "approved" : "declined";
                const decidedBy = resolved.decidedBy
                  ? resolved.decidedBy.slice(0, 10)
                  : "another admin";
                setKnockNotice(requesterNodeId, `already ${verb} by ${decidedBy}`);
                return;
              }
            }
            layout(currentWidth, currentHeight);
          })().catch((err) => {
            console.warn("[messagez] approveKnock failed:", err);
          });
        });

        rejectBtn.on("pointertap", (e) => {
          e.stopPropagation();
          disableActions();
          rejectLabel.text = "rejecting\u2026";
          rejectLabel.x = rejectW / 2;
          (async () => {
            await callDeclineKnock(store, requesterNodeId, localNodeId);
            const updated = store.doc().pendingKnocks?.[requesterNodeId];
            if (updated) {
              const resolved = store.resolveKnockDecision(updated);
              if (resolved.outcome !== "declined" || resolved.decidedBy !== localNodeId) {
                const verb = resolved.outcome === "approved" ? "approved" : "declined";
                const decidedBy = resolved.decidedBy
                  ? resolved.decidedBy.slice(0, 10)
                  : "another admin";
                setKnockNotice(requesterNodeId, `already ${verb} by ${decidedBy}`);
                return;
              }
            }
            layout(currentWidth, currentHeight);
          })().catch((err) => {
            console.warn("[messagez] declineKnock failed:", err);
          });
        });

        ignoreBtn.on("pointertap", (e) => {
          e.stopPropagation();
          addDismissedKnock(canvasDocId, requesterNodeId);
          layout(currentWidth, currentHeight);
        });
      }

      return sorted.length * KNOCK_ROW_HEIGHT;
    };

    // -----------------------------------------------------------------------
    // rebuild outbox rows
    // -----------------------------------------------------------------------

    const rebuildOutboxRows = (shares: CanvasShare[], contentW: number) => {
      while (outboxListInner.children.length > 0) {
        outboxListInner.removeChildAt(0).destroy({ children: true });
      }

      // filter out resolved items unless toggle is on
      const visible = showResolved
        ? shares
        : shares.filter((s) => !s.delivered && !s.accepted && !s.declined);

      // sort: undelivered first, then by sentAt descending
      const sorted = [...visible].sort((a, b) => {
        const aResolved = a.delivered || a.accepted || a.declined;
        const bResolved = b.delivered || b.accepted || b.declined;
        if (!aResolved && bResolved) return -1;
        if (aResolved && !bResolved) return 1;
        return new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime();
      });

      const leftW = COLOR_STRIPE_WIDTH + 4 + THUMB_SIZE + THUMB_MARGIN;
      const maxNameChars = Math.max(
        6,
        Math.floor((contentW - leftW - 80) / (ROW_NAME_SIZE * 0.55))
      );

      for (let i = 0; i < sorted.length; i++) {
        const share = sorted[i];
        const rowY = i * ROW_HEIGHT;

        const rowContainer = new Container();
        rowContainer.eventMode = "static";
        rowContainer.y = rowY;
        outboxListInner.addChild(rowContainer);

        // alternating row background
        const rowBg = new Graphics();
        rowBg.eventMode = "none";
        if (i % 2 === 1) {
          rowBg.rect(0, 0, contentW, ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
        }
        rowContainer.addChild(rowBg);

        // thumbnail area
        const thumbColor = isTransparent(share.canvasColor) ? BORDER : safeColor(share.canvasColor);
        const thumbX = COLOR_STRIPE_WIDTH + 4;
        const thumbY = (ROW_HEIGHT - THUMB_SIZE) / 2;

        // color stripe on left edge
        const stripe = new Graphics();
        stripe.eventMode = "none";
        stripe.rect(0, 0, COLOR_STRIPE_WIDTH, ROW_HEIGHT);
        stripe.fill({ color: thumbColor });
        rowContainer.addChild(stripe);

        if (share.canvasPreviewUrl) {
          // placeholder bg while loading
          const thumbBg = new Graphics();
          thumbBg.eventMode = "none";
          thumbBg.roundRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, THUMB_RADIUS);
          thumbBg.fill({ color: thumbColor, alpha: 0.15 });
          rowContainer.addChild(thumbBg);

          // async load — fire and forget, will render when ready
          Assets.load<Texture>(share.canvasPreviewUrl)
            .then((texture) => {
              if (!rowContainer.destroyed) {
                const sprite = new Sprite(texture);
                const scale = Math.max(THUMB_SIZE / texture.width, THUMB_SIZE / texture.height);
                sprite.width = texture.width * scale;
                sprite.height = texture.height * scale;
                sprite.x = thumbX + (THUMB_SIZE - sprite.width) / 2;
                sprite.y = thumbY + (THUMB_SIZE - sprite.height) / 2;
                sprite.eventMode = "none";
                // clip to rounded rect
                const mask = new Graphics();
                mask.roundRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, THUMB_RADIUS);
                mask.fill({ color: 0xffffff });
                rowContainer.addChild(mask);
                sprite.mask = mask;
                rowContainer.addChild(sprite);
              }
            })
            .catch(() => {});
        } else {
          // solid color thumbnail with canvas title initial
          const thumbBg = new Graphics();
          thumbBg.eventMode = "none";
          thumbBg.roundRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, THUMB_RADIUS);
          thumbBg.fill({ color: thumbColor, alpha: 0.25 });
          rowContainer.addChild(thumbBg);

          const titleInitial = (share.canvasTitle || "?").charAt(0).toUpperCase();
          const thumbLetter = new Text({
            text: titleInitial,
            style: {
              fontFamily: FONT,
              fontSize: 14,
              fontWeight: "bold",
              fill: thumbColor,
              align: "center",
            },
            resolution: RESOLUTION,
          });
          thumbLetter.eventMode = "none";
          thumbLetter.anchor.set(0.5);
          thumbLetter.x = thumbX + THUMB_SIZE / 2;
          thumbLetter.y = thumbY + THUMB_SIZE / 2;
          rowContainer.addChild(thumbLetter);
        }

        // text content
        const textX = leftW;
        const hasDesc = !!share.canvasDescription;

        // line 1: canvas title (bold)
        const titleLabel = share.canvasTitle
          ? truncate(share.canvasTitle, maxNameChars)
          : "untitled canvas";

        const titleText = new Text({
          text: titleLabel,
          style: {
            fontFamily: FONT,
            fontSize: ROW_NAME_SIZE,
            fontWeight: "bold",
            fill: TEXT_COLOR,
          },
          resolution: RESOLUTION,
        });
        titleText.eventMode = "none";
        titleText.x = textX;
        titleText.y = hasDesc ? 12 : 22;
        rowContainer.addChild(titleText);

        // line 2: description (only if present)
        if (hasDesc) {
          const descText = new Text({
            text: truncate(share.canvasDescription, maxNameChars),
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          descText.eventMode = "none";
          descText.x = textX;
          descText.y = 30;
          rowContainer.addChild(descText);
        }

        // line 3: to: username  ·  time
        const displayName = share.toUsername || share.toNodeId.slice(0, 8);
        const metaLabel = `to: ${displayName}  \u00b7  ${relativeTime(share.sentAt)}`;

        const metaText = new Text({
          text: metaLabel,
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        metaText.eventMode = "none";
        metaText.x = textX;
        metaText.y = hasDesc ? 47 : 42;
        rowContainer.addChild(metaText);

        // right side — status indicator
        let statusIconChar = "";
        let statusIconColor = MUTED_TEXT;
        let statusLabelText = "";

        if (share.accepted) {
          statusIconChar = "\u2713";
          statusIconColor = ACCEPT_COLOR;
          statusLabelText = "accepted";
        } else if (share.declined) {
          statusIconChar = "\u00d7";
          statusIconColor = DECLINE_COLOR;
          statusLabelText = "declined";
        } else if (share.delivered) {
          statusIconChar = "\u2713";
          statusIconColor = DELIVERED_COLOR;
          statusLabelText = "delivered";
        } else {
          statusLabelText = "sending\u2026";
        }

        if (statusIconChar) {
          const sIcon = new Text({
            text: statusIconChar,
            style: { fontFamily: FONT, fontSize: 12, fontWeight: "bold", fill: statusIconColor },
            resolution: RESOLUTION,
          });
          sIcon.eventMode = "none";
          sIcon.x = contentW - ROW_PADDING_X - 70;
          sIcon.y = (ROW_HEIGHT - 12) / 2;
          rowContainer.addChild(sIcon);

          const sLabel = new Text({
            text: statusLabelText,
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          sLabel.eventMode = "none";
          sLabel.x = sIcon.x + 16;
          sLabel.y = (ROW_HEIGHT - ROW_SUB_SIZE) / 2;
          rowContainer.addChild(sLabel);
        } else {
          // "sending..." with no icon
          const sLabel = new Text({
            text: statusLabelText,
            style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
            resolution: RESOLUTION,
          });
          sLabel.eventMode = "none";
          sLabel.x = contentW - ROW_PADDING_X - 55;
          sLabel.y = (ROW_HEIGHT - ROW_SUB_SIZE) / 2;
          rowContainer.addChild(sLabel);
        }
      }

      totalOutboxHeight = sorted.length * ROW_HEIGHT;
    };

    // -----------------------------------------------------------------------
    // layout
    // -----------------------------------------------------------------------

    const layout = (w: number, h: number) => {
      const state = ctx.doc.current;

      // auto-cleanup: remove accepted/declined invites older than 7 days
      const now = Date.now();
      const CLEANUP_MS = 7 * 24 * 60 * 60 * 1000;

      const staleInvites = (state.invites ?? []).filter(
        (inv: CanvasInvite) =>
          inv.status !== "pending" &&
          inv.receivedAt &&
          now - new Date(inv.receivedAt).getTime() > CLEANUP_MS
      );

      const staleShares = (state.shares ?? []).filter(
        (s: CanvasShare) =>
          (s.accepted || s.declined) && s.sentAt && now - new Date(s.sentAt).getTime() > CLEANUP_MS
      );

      const staleDeletions = (state.deletions ?? []).filter(
        (d: CanvasDeletedNotif) =>
          d.status === "dismissed" &&
          d.deletedAt &&
          now - new Date(d.deletedAt).getTime() > CLEANUP_MS
      );

      if (staleInvites.length > 0 || staleShares.length > 0 || staleDeletions.length > 0) {
        ctx.doc.change((draft) => {
          if (staleInvites.length > 0) {
            draft.invites = draft.invites.filter(
              (inv: CanvasInvite) =>
                inv.status === "pending" ||
                !inv.receivedAt ||
                now - new Date(inv.receivedAt).getTime() <= CLEANUP_MS
            );
          }
          if (staleShares.length > 0) {
            // #TODO: FIX THIS, is throwing RangeError: Cannot create a reference to an existing document object
            // draft.shares = draft.shares.filter(
            //   (s: CanvasShare) =>
            //     (!s.accepted && !s.declined) ||
            //     !s.sentAt ||
            //     now - new Date(s.sentAt).getTime() <= CLEANUP_MS
            // );
          }
          if (staleDeletions.length > 0) {
            draft.deletions = draft.deletions.filter(
              (d: CanvasDeletedNotif) =>
                d.status !== "dismissed" ||
                !d.deletedAt ||
                now - new Date(d.deletedAt).getTime() <= CLEANUP_MS
            );
          }
        });
      }

      const invites = state.invites ?? [];
      const shares = state.shares ?? [];
      const deletions = state.deletions ?? [];

      // pendingKnocks lives on the currently-open canvas's own document, not
      // this messagez doc (see docs/knock-and-hub-relay-plan.md section 1's
      // table for the asymmetry) — read it straight from `ctx.canvasStore`.
      const canvasStore = ctx.canvasStore;
      const canvasDocId = canvasStore?.handle.documentId ?? "";
      const dismissedKnocks = canvasDocId ? getDismissedKnocks(canvasDocId) : new Set<string>();
      const visibleKnocks: PendingCanvasKnock[] = canvasStore
        ? Object.values(canvasStore.doc().pendingKnocks ?? {}).filter((k) => {
            if (dismissedKnocks.has(k.requesterNodeId)) return false;
            if (activeKnockNotices.has(k.requesterNodeId)) return true;
            return canvasStore.resolveKnockDecision(k).outcome === "pending";
          })
        : [];
      const pendingKnockCount = canvasStore
        ? visibleKnocks.filter((k) => canvasStore.resolveKnockDecision(k).outcome === "pending")
            .length
        : 0;

      const pendingCount =
        invites.filter((inv: CanvasInvite) => inv.status === "pending").length +
        deletions.filter((d: CanvasDeletedNotif) => d.status === "unread").length +
        pendingKnockCount;
      const contentW = w - PADDING_X * 2;
      let y = PADDING_Y;

      // card background
      drawCard(w, h);

      // tab bar
      drawTabBar(y, pendingCount);

      // position "clear all" and "show resolved"/"show accepted" — on the
      // tab bar line when there's room, or wrapped to their own row below
      // it when the container is too narrow to fit both the tab labels
      // and these buttons without overlapping (a real reported bug: on a
      // narrow messagez panel, these could be squeezed off the visible
      // area entirely instead of just wrapping).
      const tabBtnY = y + (TAB_HEIGHT - (TAB_FONT_SIZE - 1)) / 2;
      const currentTabItems = viewMode === "inbox" ? invites.length : shares.length;
      const btnGap = 12;

      clearAllText.visible = currentTabItems > 0;
      toggleResolvedText.text = showResolved ? "hide resolved" : "show resolved";
      toggleResolvedText.visible = viewMode === "outbox" && shares.length > 0;
      toggleAcceptedText.text = showAccepted ? "hide accepted" : "show accepted";
      toggleAcceptedText.visible = viewMode === "inbox" && invites.length > 0;

      // only one of these two is ever visible at once (inbox vs outbox
      // view) — whichever it is sits immediately left of "clear all".
      const toggleText = viewMode === "outbox" ? toggleResolvedText : toggleAcceptedText;

      let buttonsRowWidth = 0;
      if (clearAllText.visible) buttonsRowWidth += clearAllText.width;
      if (toggleText.visible) {
        buttonsRowWidth += toggleText.width + (clearAllText.visible ? btnGap : 0);
      }

      const tabLabelsRightEdge = tabOutboxText.x + tabOutboxText.width;
      const fitsOnTabRow =
        buttonsRowWidth === 0 || w - tabLabelsRightEdge - btnGap - PADDING_X >= buttonsRowWidth;
      const buttonsRowY = fitsOnTabRow ? tabBtnY : tabBtnY + TAB_HEIGHT;

      clearAllText.x = w - PADDING_X - clearAllText.width;
      clearAllText.y = buttonsRowY;

      toggleResolvedText.x = clearAllText.visible
        ? clearAllText.x - toggleResolvedText.width - btnGap
        : w - PADDING_X - toggleResolvedText.width;
      toggleResolvedText.y = buttonsRowY;

      toggleAcceptedText.x = clearAllText.visible
        ? clearAllText.x - toggleAcceptedText.width - btnGap
        : w - PADDING_X - toggleAcceptedText.width;
      toggleAcceptedText.y = buttonsRowY;

      y += TAB_HEIGHT + (fitsOnTabRow ? 0 : TAB_HEIGHT) + 4;

      // hide all view containers
      inboxListContainer.visible = false;
      inboxEmptyText.visible = false;
      outboxListContainer.visible = false;
      outboxEmptyText.visible = false;
      knockAckBannerText.visible = false;

      if (viewMode === "inbox") {
        inboxListContainer.visible = true;

        inboxAreaY = y;
        inboxAreaHeight = h - y - PADDING_Y;

        // update mask
        inboxListMask.clear();
        inboxListMask.rect(PADDING_X, inboxAreaY, contentW, inboxAreaHeight);
        inboxListMask.fill({ color: 0xffffff });

        // position list container
        inboxListContainer.x = PADDING_X;
        inboxListContainer.y = inboxAreaY;
        inboxListContainer.hitArea = new Rectangle(0, 0, contentW, inboxAreaHeight);

        // filter invites based on toggle — a just-accepted invite (this
        // panel-open session) stays visible regardless of `showAccepted`,
        // see recentlyAcceptedIds' doc comment.
        const visibleInvites = invites.filter(
          (inv: CanvasInvite) =>
            showAccepted || inv.status === "pending" || recentlyAcceptedIds.has(inv.id)
        );

        // filter deletions based on toggle
        const visibleDeletions = deletions.filter(
          (d: CanvasDeletedNotif) => showAccepted || d.status === "unread"
        );

        // rebuild rows
        rebuildInboxRows(visibleInvites, contentW);

        // append pending-knock rows below invites (docs/knock-and-hub-relay-plan.md
        // section 7.2) — read from the currently-open canvas's own doc, not
        // this messagez doc, see the asymmetry note above `visibleKnocks`.
        totalInboxHeight += rebuildKnockRows(visibleKnocks, contentW, totalInboxHeight);

        // append deletion notification rows below invites
        if (visibleDeletions.length > 0) {
          const delSorted = [...visibleDeletions].sort((a, b) => {
            if (a.status === "unread" && b.status !== "unread") return -1;
            if (a.status !== "unread" && b.status === "unread") return 1;
            return new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime();
          });

          const delStartY = totalInboxHeight;
          for (let i = 0; i < delSorted.length; i++) {
            const notif = delSorted[i];
            const rowY = delStartY + i * ROW_HEIGHT;

            const rowContainer = new Container();
            rowContainer.eventMode = "static";
            rowContainer.y = rowY;
            inboxListInner.addChild(rowContainer);

            // alternating row bg (continue from invite count)
            const globalIdx = totalInboxHeight / ROW_HEIGHT + i;
            const rowBg = new Graphics();
            rowBg.eventMode = "none";
            if (globalIdx % 2 === 1) {
              rowBg.rect(0, 0, contentW, ROW_HEIGHT);
              rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
            }
            rowContainer.addChild(rowBg);

            // red color stripe for deletion
            const stripe = new Graphics();
            stripe.rect(0, 2, COLOR_STRIPE_WIDTH, ROW_HEIGHT - 4);
            stripe.fill({ color: DECLINE_COLOR });
            rowContainer.addChild(stripe);

            // thumbnail — initial letter
            const thumbColor = isTransparent(notif.canvasColor)
              ? BORDER
              : safeColor(notif.canvasColor);
            const thumbX = COLOR_STRIPE_WIDTH + 4;
            const thumbY = (ROW_HEIGHT - THUMB_SIZE) / 2;

            const thumbBg = new Graphics();
            thumbBg.roundRect(thumbX, thumbY, THUMB_SIZE, THUMB_SIZE, THUMB_RADIUS);
            thumbBg.fill({ color: thumbColor, alpha: 0.3 });
            rowContainer.addChild(thumbBg);

            const titleInitial = (notif.canvasTitle || "?")[0].toUpperCase();
            const thumbLetter = new Text({
              text: titleInitial,
              style: {
                fontFamily: FONT,
                fontSize: THUMB_SIZE * 0.5,
                fontWeight: "bold",
                fill: thumbColor,
                align: "center",
              },
              resolution: RESOLUTION,
            });
            thumbLetter.x = thumbX + (THUMB_SIZE - thumbLetter.width) / 2;
            thumbLetter.y = thumbY + (THUMB_SIZE - thumbLetter.height) / 2;
            rowContainer.addChild(thumbLetter);

            // text
            const leftW = COLOR_STRIPE_WIDTH + 4 + THUMB_SIZE + THUMB_MARGIN;
            const textX = leftW;
            const isPurge = notif.deleteMode === "purge";
            const actionLabel = isPurge ? "purged" : "deleted";
            const displayName = notif.deletedByUsername || notif.deletedBy.slice(0, 12) + "...";

            const titleText = new Text({
              text: `${displayName} ${actionLabel} canvas`,
              style: {
                fontFamily: FONT,
                fontSize: ROW_NAME_SIZE,
                fontWeight: "bold",
                fill: TEXT_COLOR,
              },
              resolution: RESOLUTION,
            });
            titleText.x = textX;
            titleText.y = 8;
            rowContainer.addChild(titleText);

            const descText = new Text({
              text: truncate(notif.canvasTitle || "untitled", 30),
              style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
              resolution: RESOLUTION,
            });
            descText.x = textX;
            descText.y = titleText.y + titleText.height + 2;
            rowContainer.addChild(descText);

            const metaText = new Text({
              text: relativeTime(notif.deletedAt),
              style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
              resolution: RESOLUTION,
            });
            metaText.x = textX;
            metaText.y = descText.y + descText.height + 2;
            rowContainer.addChild(metaText);

            // dismiss button
            if (notif.status === "unread") {
              const dismissW = 60;
              const dismissH = ACTION_BTN_SIZE;
              const dismissBtn = new Container();
              dismissBtn.eventMode = "static";
              dismissBtn.cursor = "pointer";

              const dismissBg = new Graphics();
              dismissBg.roundRect(0, 0, dismissW, dismissH, 4);
              dismissBg.fill({ color: DECLINE_COLOR });
              dismissBg.stroke({ color: DECLINE_COLOR, width: 1 });
              dismissBtn.addChild(dismissBg);

              const dismissLabel = new Text({
                text: "dismiss",
                style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: 0xffffff },
                resolution: RESOLUTION,
              });
              dismissLabel.x = (dismissW - dismissLabel.width) / 2;
              dismissLabel.y = (dismissH - dismissLabel.height) / 2;
              dismissBtn.addChild(dismissLabel);

              dismissBtn.x = contentW - dismissW - ROW_PADDING_X;
              dismissBtn.y = (ROW_HEIGHT - dismissH) / 2;

              const notifId = notif.id;
              dismissBtn.on("pointertap", () => {
                ctx.doc.change((draft: any) => {
                  const del = (draft.deletions ?? []).find((d: any) => d.id === notifId);
                  if (del) del.status = "dismissed";
                });
              });

              rowContainer.addChild(dismissBtn);
            } else {
              const statusIcon = new Text({
                text: "\u2713",
                style: {
                  fontFamily: FONT,
                  fontSize: ROW_NAME_SIZE,
                  fontWeight: "bold",
                  fill: MUTED_TEXT,
                },
                resolution: RESOLUTION,
              });
              statusIcon.x = contentW - statusIcon.width - ROW_PADDING_X;
              statusIcon.y = (ROW_HEIGHT - statusIcon.height) / 2;
              rowContainer.addChild(statusIcon);
            }
          }

          totalInboxHeight += delSorted.length * ROW_HEIGHT;
        }

        // clamp scroll
        clampInboxScroll();
        inboxListInner.y = -scrollY;

        // empty state
        if (
          visibleInvites.length === 0 &&
          visibleDeletions.length === 0 &&
          visibleKnocks.length === 0
        ) {
          inboxEmptyText.text =
            invites.length > 0 || deletions.length > 0 ? "all resolved" : "no messages yet";
          inboxEmptyText.visible = true;
          inboxEmptyText.x = PADDING_X + (contentW - inboxEmptyText.width) / 2;
          inboxEmptyText.y = inboxAreaY + inboxAreaHeight / 2 - 6;
        }
      } else {
        outboxListContainer.visible = true;

        // requester's own status banner (section 7.1) — see
        // `knockAckBannerText`'s doc comment above.
        let bannerHeight = 0;
        if (ackedKnockCanvasIds.size > 0) {
          const count = ackedKnockCanvasIds.size;
          knockAckBannerText.text = `\u2713  request received, waiting for a response${
            count > 1 ? ` (${count})` : ""
          }`;
          knockAckBannerText.visible = true;
          knockAckBannerText.x = PADDING_X;
          knockAckBannerText.y = y;
          bannerHeight = knockAckBannerText.height + 8;
        } else {
          knockAckBannerText.visible = false;
        }

        outboxAreaY = y + bannerHeight;
        outboxAreaHeight = h - outboxAreaY - PADDING_Y;

        // update mask
        outboxListMask.clear();
        outboxListMask.rect(PADDING_X, outboxAreaY, contentW, outboxAreaHeight);
        outboxListMask.fill({ color: 0xffffff });

        // position list container
        outboxListContainer.x = PADDING_X;
        outboxListContainer.y = outboxAreaY;
        outboxListContainer.hitArea = new Rectangle(0, 0, contentW, outboxAreaHeight);

        // rebuild rows
        rebuildOutboxRows(shares, contentW);

        // clamp scroll
        clampOutboxScroll();
        outboxListInner.y = -scrollY;

        // empty state
        if (shares.length === 0) {
          outboxEmptyText.text = "no shares yet";
          outboxEmptyText.visible = true;
          outboxEmptyText.x = PADDING_X + (contentW - outboxEmptyText.width) / 2;
          outboxEmptyText.y = outboxAreaY + outboxAreaHeight / 2 - 6;
        } else if (totalOutboxHeight === 0) {
          outboxEmptyText.text = "all shares resolved";
          outboxEmptyText.visible = true;
          outboxEmptyText.x = PADDING_X + (contentW - outboxEmptyText.width) / 2;
          outboxEmptyText.y = outboxAreaY + outboxAreaHeight / 2 - 6;
        }
      }
    };

    // initial draw
    layout(currentWidth, currentHeight);

    // subscribe to remote doc changes
    const unsub = ctx.doc.on("change", () => {
      layout(currentWidth, currentHeight);
    });

    // -----------------------------------------------------------------------
    // controller
    // -----------------------------------------------------------------------

    const testHooks: MessagezTestHooks = {
      getKnockActionGlobalPos(requesterNodeId, action) {
        const refs = knockRowRefs.get(requesterNodeId);
        if (!refs) return null;
        const btn =
          action === "roleToggle"
            ? refs.roleToggleBtn
            : action === "approve"
              ? refs.approveBtn
              : action === "reject"
                ? refs.rejectBtn
                : refs.ignoreBtn;
        const pos = btn.getGlobalPosition();
        return { x: pos.x + btn.width / 2, y: pos.y + btn.height / 2 };
      },
      getVisibleKnockRequesterIds() {
        return [...knockRowRefs.keys()];
      },
      getKnockMetaInfo(requesterNodeId) {
        return knockMetaInfo.get(requesterNodeId) ?? null;
      },
      getKnockNoticeText(requesterNodeId) {
        return activeKnockNotices.get(requesterNodeId) ?? null;
      },
      getKnockRole(requesterNodeId) {
        return knockRowRoles.get(requesterNodeId) ?? null;
      },
      simulateKnockAck(canvasDocId) {
        recordKnockAck({ knockId: "test-simulated", canvasDocId, ackerNodeId: "test-acker" });
      },
      simulateKnockRelay(canvasDocId, requesterNodeId, relayedBy) {
        recordKnockRelay({ canvasDocId, requesterNodeId, relayedBy });
      },
    };

    const controller: WidgetController & { testHooks: MessagezTestHooks } = {
      container,
      testHooks,

      onVisibilityChange(visible: boolean) {
        // panel closed (toggled off, or dismissed) — resume normal
        // showAccepted-governed hiding for any invites accepted while it
        // was open, rather than leaving them force-visible forever.
        if (!visible && recentlyAcceptedIds.size > 0) {
          recentlyAcceptedIds.clear();
          layout(currentWidth, currentHeight);
        }
      },

      destroy() {
        unsub();
        unsubKnockAcked();
        unsubKnockRelayed();
        unsubCanvasStore?.();
        for (const timer of knockNoticeTimers.values()) clearTimeout(timer);
        knockNoticeTimers.clear();
        container.destroy({ children: true });
      },

      resize(width: number, height: number) {
        currentWidth = width;
        currentHeight = height;
        layout(width, height);
      },
    };

    return controller;
  },
};

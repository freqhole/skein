import { Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { z } from "zod";
import { canvasRoleSchema } from "../../src/canvas/canvas-doc";
import type { CanvasStore } from "../../src/canvas/canvas-store";
import {
  getFriendInfo,
  hasKnockAckForCanvas,
  isOnline,
  onFriendsChange,
  onKnockAcked,
} from "../../src/p2p/friendz-bridge";
import { formatRelativeTime, formatShortDate } from "../../src/widgets/format";
import {
  isTransparent,
  safeColor,
  type CompactInfo,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../../src/widgets/widget-types";
import { trashCanvasCard } from "./trash-widget";
import { renderAvatar } from "./social/avatar-renderer";

export const canvasCardSchema = z.object({
  canvasDocId: z.string().default(""),
  title: z.string().default("untitled canvas"),
  description: z.string().default(""),
  previewUrl: z.string().default(""),
  createdAt: z.string().default(""),
  modifiedAt: z.string().default(""),
  authorName: z.string().default(""),
  color: z.number().default(0xd946ef),
  isRemote: z.boolean().default(false),
  ownerNodeId: z.string().default(""),
  ownerUsername: z.string().default(""),
  ownerAvatarDataUrl: z.string().default(""),
  role: canvasRoleSchema.default("admin"),
  accessRevoked: z.boolean().default(false),
  /** true while a remote card has never successfully synced (e.g. a
   *  "syncing..." placeholder from an access-denied or unreachable join) —
   *  shows a "request access" pill instead of the ordinary "new" indicator,
   *  letting the user send a knock without needing to open the canvas
   *  first. cleared once the canvas actually opens or a real invite is
   *  accepted for it. */
  accessPending: z.boolean().default(false),
  /** ISO timestamp set the moment the "request access" pill is clicked —
   *  keeps the pill from being clicked again while a knock is already in
   *  flight (delivery is retried automatically by the app whenever the
   *  owner or a fallback hub comes online, so a second click is never
   *  needed). cleared once access is actually granted. */
  accessRequestedAt: z.string().default(""),
  /** true once a `canvas-knock-decline` arrives for this canvas — cleared
   *  by `friendz-wiring.ts`'s `onCanvasKnockDecline` alongside
   *  `accessRequestedAt` (reset to ""), and cleared again locally the next
   *  time the pill is clicked to retry. lets the pill distinguish "the
   *  owner said no" from "still waiting to hear back". */
  accessDeclined: z.boolean().default(false),
  /** node ids of hubs the sharer's canvas has been explicitly shared
   *  with, carried over from the share link (see share-string.ts's
   *  `hubNodeIds`) — when non-empty on a not-yet-accessible remote card,
   *  offers a "connect via hub" pill alongside "request access" so the
   *  invitee can befriend a reachable hub instead of waiting for the
   *  owner to come back online. */
  hubNodeIds: z.array(z.string()).default([]),
  /** ISO timestamp set the moment the "connect via hub" pill is clicked —
   *  mirrors `accessRequestedAt`'s debounce role for the hub-connect
   *  action; cleared if the card is ever reset back to a fresh
   *  access-pending state. */
  hubConnectRequestedAt: z.string().default(""),
  lastVisitedAt: z.string().default(""),
  hasUpdates: z.boolean().default(false),
  lastKnownModifiedAt: z.string().default(""),
  lastModifiedBy: z.string().default(""),
  isDeleted: z.boolean().default(false),
  deletedAt: z.string().default(""),
  deletedBy: z.string().default(""),
  deleteMode: z.string().default(""),
});

export type CanvasCardState = z.infer<typeof canvasCardSchema>;

/** pre-rename role names, from before the admin/member/viewer rename —
 *  canvas-card docs written before that rename can still carry one of
 *  these as their stored `role`, since automerge docs are never migrated
 *  in place on their own. rewritten to the modern name by `migrateCanvasCard`
 *  below the first time such a doc fails to parse. */
const legacyRoleNames: Record<string, CanvasCardState["role"]> = {
  owner: "admin",
  editor: "member",
};

/** one-time repair pass for canvas-card docs written before the
 *  admin/member/viewer role rename — see `legacyRoleNames` above. writes
 *  directly into the raw automerge doc so the fix is permanent and syncs
 *  to every peer, rather than being silently defaulted away on every read
 *  (see `widget-doc.ts`'s `createWidgetDoc`). */
function migrateCanvasCard(raw: any): void {
  if (typeof raw.role === "string" && raw.role in legacyRoleNames) {
    raw.role = legacyRoleNames[raw.role];
  }
}

// layout constants
const CARD_RADIUS = 8;
const ACCENT_HEIGHT = 4;
const PADDING_X = 12;
const PADDING_Y = 8;
const PREVIEW_RATIO = 0.55;
const TITLE_FONT_SIZE = 14;
const DESC_FONT_SIZE = 11;
const DATE_FONT_SIZE = 10;
const AUTHOR_NAME_FONT_SIZE = 10;
// horizontal gap kept between the date/edited text (left) and the author
// name (right) in the footer row, so a long username never collides with it.
const AUTHOR_NAME_GAP = 8;
const FOOTER_HEIGHT = 24;
const GRID_STEP = 16;
const ROLE_PILL_FONT_SIZE = 8;
const ROLE_PILL_PAD_X = 6;
const ROLE_PILL_PAD_Y = 2;

// theme colors
const BG_COLOR = 0x141418;
const BORDER_COLOR = 0x2a2a3e;
const BORDER_HOVER_COLOR = 0x4a4a5e;
const PREVIEW_BG = 0x1e1e28;
const GRID_LINE_COLOR = 0x282838;
const TITLE_COLOR = 0xf0f0ff;
const DESC_COLOR = 0x888898;
const DATE_COLOR = 0x666678;
const ICON_COLOR = 0x444460;

// remote card theme colors
const REMOTE_BORDER_COLOR = 0x3a7ca5;
const REMOTE_BORDER_HOVER_COLOR = 0x5a9cc5;
const ROLE_MEMBER_COLOR = 0x22c55e;
const ROLE_VIEWER_COLOR = 0xf59e0b;
const REVOKED_OVERLAY_ALPHA = 0.7;
const REVOKED_TEXT_COLOR = 0xff6b6b;
const DELETED_OVERLAY_ALPHA = 0.65;
const DELETED_TEXT_COLOR = 0xff8c42;
const DELETED_SUBTEXT_COLOR = 0xaa7744;

/**
 * truncate a string so it fits within a rough character budget.
 * appends an ellipsis when truncated.
 */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1).trimEnd() + "\u2026";
}

/**
 * estimate the number of characters that fit within a given pixel width
 * at a given font size (rough heuristic — monospace-ish).
 */
function estimateMaxChars(width: number, fontSize: number): number {
  const avgCharWidth = fontSize * 0.55;
  return Math.max(4, Math.floor(width / avgCharWidth));
}

/**
 * draw a dashed border along a rounded rectangle path.
 * straight edges use a dash pattern; corner arcs are drawn solid
 * (they're small enough that dashing looks noisy).
 */
function drawDashedRoundRect(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  color: number,
  lineWidth: number
): void {
  const dashLen = 6;
  const gapLen = 4;

  const dashLine = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const nx = dx / len;
    const ny = dy / len;
    let pos = 0;
    while (pos < len) {
      const end = Math.min(pos + dashLen, len);
      g.moveTo(x1 + nx * pos, y1 + ny * pos);
      g.lineTo(x1 + nx * end, y1 + ny * end);
      pos = end + gapLen;
    }
  };

  // dashed straight edges
  dashLine(x + r, y, x + w - r, y); // top
  dashLine(x + w, y + r, x + w, y + h - r); // right
  dashLine(x + w - r, y + h, x + r, y + h); // bottom
  dashLine(x, y + h - r, x, y + r); // left

  // solid corner arcs
  g.moveTo(x + w - r, y);
  g.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  g.moveTo(x + w, y + h - r);
  g.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  g.moveTo(x + r, y + h);
  g.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  g.moveTo(x, y + r);
  g.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);

  g.stroke({ color, width: lineWidth });
}

export const canvasCardWidget: WidgetFactory<typeof canvasCardSchema> = {
  type: "canvas-card",
  metadata: {
    name: "canvas card",
    description: "a card linking to another canvas \u2014 used in the narthex",
    version: "0.1.0",
    category: "narthex",
    hidden: true,
    maximizable: false,
  },
  schema: canvasCardSchema,
  migrate: migrateCanvasCard,
  editableProps: [
    { key: "description", label: "description", type: "string" as const, default: "" },
    { key: "color", label: "color tag", type: "color" as const, default: 0xd946ef },
    {
      key: "previewUrl",
      label: "preview",
      type: "image" as const,
      default: "",
      imageMaxWidth: 320,
      imageMaxHeight: 200,
    },
  ],

  getCompactInfo: (state: z.infer<typeof canvasCardSchema>): CompactInfo => ({
    label: state.title || "untitled canvas",
    thumbnailUrl: state.previewUrl || undefined,
    accentColor: state.color,
  }),

  onCompactActivate: (state: z.infer<typeof canvasCardSchema>): void => {
    if (state.accessRevoked) return;
    if (state.canvasDocId) {
      window.location.hash = state.canvasDocId;
    }
  },

  onBeforeClose: (widgetId: string, store: CanvasStore): boolean => {
    // redirect property tray "delete widget" to soft-delete + move to trash
    // instead of cascade-deleting the linked canvas docs
    trashCanvasCard(store.repo, store, widgetId).catch((err) => {
      console.warn("[canvas-card] failed to trash canvas:", err);
    });
    return true; // handled — suppress default close behavior
  },

  create(ctx: WidgetMountContext<typeof canvasCardSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";
    container.cursor = "pointer";
    container.sortableChildren = true;

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let hovered = false;

    // --- graphics layers ---

    const cardBg = new Graphics();
    container.addChild(cardBg);

    const accentStripe = new Graphics();
    container.addChild(accentStripe);

    const previewBg = new Graphics();
    container.addChild(previewBg);

    const previewGrid = new Graphics();
    container.addChild(previewGrid);

    const previewIcon = new Graphics();
    previewIcon.visible = false;
    container.addChild(previewIcon);

    let previewSprite: Sprite | null = null;
    let lastRequestedPreviewUrl = "";
    const previewMask = new Graphics();
    container.addChild(previewMask);

    const hintText = new Text({
      text: "click to open",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 9,
        fill: ICON_COLOR,
      },
      resolution: 3,
    });
    hintText.anchor.set(0.5, 0);
    hintText.eventMode = "none";
    hintText.visible = false;
    container.addChild(hintText);

    // --- text elements ---

    const titleText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: TITLE_FONT_SIZE,
        fontWeight: "bold",
        fill: TITLE_COLOR,
        wordWrap: false,
      },
      resolution: 3,
    });
    titleText.eventMode = "none";
    container.addChild(titleText);

    // --- remote: role pill ---

    const rolePill = new Graphics();
    rolePill.eventMode = "none";
    rolePill.visible = false;
    container.addChild(rolePill);

    const rolePillText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: ROLE_PILL_FONT_SIZE,
        fontWeight: "bold",
        fill: 0xffffff,
      },
      resolution: 3,
    });
    rolePillText.eventMode = "none";
    rolePillText.visible = false;
    container.addChild(rolePillText);

    // --- description ---

    const descText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: DESC_FONT_SIZE,
        fill: DESC_COLOR,
        wordWrap: true,
        wordWrapWidth: 200,
        lineHeight: DESC_FONT_SIZE * 1.35,
      },
      resolution: 3,
    });
    descText.eventMode = "none";
    container.addChild(descText);

    const dateText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: DATE_FONT_SIZE,
        fill: DATE_COLOR,
        wordWrap: false,
      },
      resolution: 3,
    });
    dateText.eventMode = "none";
    container.addChild(dateText);

    // author name — full display name, right-aligned in the footer (was a
    // colored circle + single initial letter; replaced with the whole name,
    // truncated to fit, per user request).
    const authorNameText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: AUTHOR_NAME_FONT_SIZE,
        fill: DATE_COLOR,
        align: "right",
      },
      resolution: 3,
    });
    authorNameText.anchor.set(1, 0.5);
    authorNameText.eventMode = "none";
    container.addChild(authorNameText);

    // small avatar shown next to the owner's name on remote cards — a
    // persistent container so drawAuthorBadge can clear and redraw it on
    // every layout() without leaking children (see renderAvatar's doc
    // comment: it always appends fresh children to whatever parent it's
    // given).
    const authorAvatarContainer = new Container();
    container.addChild(authorAvatarContainer);

    // --- remote: corner badge ---

    const remoteBadge = new Text({
      text: "\u2197",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 11,
        fill: REMOTE_BORDER_COLOR,
      },
      resolution: 3,
    });
    remoteBadge.anchor.set(1, 0);
    remoteBadge.eventMode = "none";
    remoteBadge.visible = false;
    container.addChild(remoteBadge);

    // --- remote: access revoked overlay (must render on top of everything) ---

    const revokedOverlay = new Graphics();
    revokedOverlay.eventMode = "none";
    revokedOverlay.visible = false;
    revokedOverlay.zIndex = 100;
    container.addChild(revokedOverlay);

    const revokedText = new Text({
      text: "access revoked",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        fontWeight: "bold",
        fill: REVOKED_TEXT_COLOR,
      },
      resolution: 3,
    });
    revokedText.anchor.set(0.5);
    revokedText.eventMode = "none";
    revokedText.visible = false;
    revokedText.zIndex = 101;
    container.addChild(revokedText);

    // --- deleted overlay (soft-delete / purge visual treatment) ---

    const deletedOverlay = new Graphics();
    deletedOverlay.eventMode = "none";
    deletedOverlay.visible = false;
    deletedOverlay.zIndex = 90;
    container.addChild(deletedOverlay);

    const deletedText = new Text({
      text: "canvas deleted",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        fontWeight: "bold",
        fill: DELETED_TEXT_COLOR,
      },
      resolution: 3,
    });
    deletedText.anchor.set(0.5);
    deletedText.eventMode = "none";
    deletedText.visible = false;
    deletedText.zIndex = 91;
    container.addChild(deletedText);

    const deletedByText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 9,
        fontWeight: "normal",
        fill: DELETED_SUBTEXT_COLOR,
      },
      resolution: 3,
    });
    deletedByText.anchor.set(0.5);
    deletedByText.eventMode = "none";
    deletedByText.visible = false;
    deletedByText.zIndex = 91;
    container.addChild(deletedByText);

    // --- update pill (shows when a shared canvas has new activity) ---

    const updatePill = new Graphics();
    updatePill.eventMode = "none";
    updatePill.visible = false;
    updatePill.zIndex = 50;
    container.addChild(updatePill);

    const updatePillText = new Text({
      text: "updated",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 8,
        fontWeight: "bold",
        fill: 0xffffff,
      },
      resolution: 3,
    });
    updatePillText.eventMode = "none";
    updatePillText.visible = false;
    updatePillText.zIndex = 50;
    container.addChild(updatePillText);

    // --- request-access pill (remote cards that have never synced) ---
    const requestAccessContainer = new Container();
    requestAccessContainer.visible = false;
    requestAccessContainer.zIndex = 50;
    requestAccessContainer.eventMode = "static";
    requestAccessContainer.cursor = "pointer";
    container.addChild(requestAccessContainer);

    const requestAccessBg = new Graphics();
    requestAccessContainer.addChild(requestAccessBg);

    const requestAccessText = new Text({
      text: "request access",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: DATE_FONT_SIZE,
        fontWeight: "600",
        fill: 0xf59e0b,
      },
      resolution: 3,
    });
    requestAccessContainer.addChild(requestAccessText);

    // --- connect-via-hub pill (remote cards with a share-link hub id) ---
    const connectHubContainer = new Container();
    connectHubContainer.visible = false;
    connectHubContainer.zIndex = 50;
    connectHubContainer.eventMode = "static";
    connectHubContainer.cursor = "pointer";
    container.addChild(connectHubContainer);

    const connectHubBg = new Graphics();
    connectHubContainer.addChild(connectHubBg);

    const connectHubText = new Text({
      text: "connect via hub",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: DATE_FONT_SIZE,
        fontWeight: "600",
        fill: 0x38bdf8,
      },
      resolution: 3,
    });
    connectHubContainer.addChild(connectHubText);

    // --- syncing indicator for newly accepted remote cards ---
    const syncingContainer = new Container();
    syncingContainer.visible = false;
    syncingContainer.zIndex = 50;
    container.addChild(syncingContainer);

    const syncingBg = new Graphics();
    syncingContainer.addChild(syncingBg);

    const syncingText = new Text({
      text: "new \u2022 tap to open",
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: DATE_FONT_SIZE,
        fontWeight: "600",
        fill: 0x22c55e,
      },
      resolution: 3,
    });
    syncingContainer.addChild(syncingText);

    // --- drawing helpers ---

    const drawCardBg = (w: number, h: number, remote: boolean) => {
      cardBg.clear();
      cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
      cardBg.fill({ color: BG_COLOR });

      if (remote) {
        const borderColor = hovered ? REMOTE_BORDER_HOVER_COLOR : REMOTE_BORDER_COLOR;
        drawDashedRoundRect(cardBg, 0, 0, w, h, CARD_RADIUS, borderColor, 1);
      } else {
        const borderColor = hovered ? BORDER_HOVER_COLOR : BORDER_COLOR;
        cardBg.roundRect(0, 0, w, h, CARD_RADIUS);
        cardBg.stroke({ color: borderColor, width: 1 });
      }
    };

    const drawAccent = (w: number, color: number, remote: boolean) => {
      const col = isTransparent(color) ? 0x444460 : safeColor(color);
      accentStripe.clear();

      if (remote) {
        // striped accent — faint tinted base with alternating color stripes
        accentStripe.roundRect(1, 1, w - 2, ACCENT_HEIGHT + CARD_RADIUS, CARD_RADIUS);
        accentStripe.fill({ color: col, alpha: 0.15 });
        accentStripe.rect(1, ACCENT_HEIGHT, w - 2, CARD_RADIUS);
        accentStripe.fill({ color: BG_COLOR });
        // draw alternating stripes over the accent area
        const stripeW = 6;
        const gapW = 4;
        let x = 1;
        while (x < w - 1) {
          const sw = Math.min(stripeW, w - 1 - x);
          accentStripe.rect(x, 1, sw, ACCENT_HEIGHT);
          accentStripe.fill({ color: col });
          x += stripeW + gapW;
        }
      } else {
        // solid accent bar clipped to the top rounded corners
        // use a rounded rect for the top, then cover the bottom rounding with a flat rect
        accentStripe.roundRect(1, 1, w - 2, ACCENT_HEIGHT + CARD_RADIUS, CARD_RADIUS);
        accentStripe.fill({ color: col });
        // mask out the bottom part so it's flat
        accentStripe.rect(1, ACCENT_HEIGHT, w - 2, CARD_RADIUS);
        accentStripe.fill({ color: BG_COLOR });
        // redraw just the accent portion
        accentStripe.rect(1, 1, w - 2, ACCENT_HEIGHT);
        accentStripe.fill({ color: col });
      }
    };

    const drawPreview = (w: number, h: number, state: CanvasCardState) => {
      const previewH = Math.floor(h * PREVIEW_RATIO);
      const top = ACCENT_HEIGHT;
      const hasPreview = !!state.previewUrl;

      // background fill — use a dimmed version of the card color when no preview image
      previewBg.clear();
      previewBg.rect(1, top, w - 2, previewH);
      if (hasPreview) {
        previewBg.fill({ color: PREVIEW_BG });
      } else {
        previewBg.fill({ color: PREVIEW_BG });
        // overlay the card color at low opacity for a tinted background
        previewBg.rect(1, top, w - 2, previewH);
        previewBg.fill({ color: safeColor(state.color), alpha: 0.15 });
      }

      if (!hasPreview) {
        // faint grid pattern
        previewGrid.clear();
        for (let x = GRID_STEP; x < w - 2; x += GRID_STEP) {
          previewGrid.moveTo(x, top);
          previewGrid.lineTo(x, top + previewH);
        }
        for (let y = top + GRID_STEP; y < top + previewH; y += GRID_STEP) {
          previewGrid.moveTo(1, y);
          previewGrid.lineTo(w - 1, y);
        }
        previewGrid.stroke({ color: GRID_LINE_COLOR, width: 0.5, alpha: 0.5 });
        previewGrid.visible = true;
        // icon and hint are controlled by hover
      } else {
        previewGrid.visible = false;
        // icon and hint are controlled by hover
      }

      // icon — always drawn (visibility controlled by hover)
      const iconSize = Math.min(28, previewH * 0.35);
      const iconX = w / 2 - iconSize / 2;
      const iconY = top + previewH / 2 - iconSize / 2;
      previewIcon.clear();
      previewIcon.roundRect(iconX, iconY, iconSize, iconSize, 3);
      previewIcon.stroke({ color: ICON_COLOR, width: 1.5 });
      previewIcon.moveTo(iconX + iconSize / 2, iconY + 3);
      previewIcon.lineTo(iconX + iconSize / 2, iconY + iconSize - 3);
      previewIcon.stroke({ color: ICON_COLOR, width: 1 });
      previewIcon.moveTo(iconX + 3, iconY + iconSize / 2);
      previewIcon.lineTo(iconX + iconSize - 3, iconY + iconSize / 2);
      previewIcon.stroke({ color: ICON_COLOR, width: 1 });
      // visibility is toggled by pointerover/pointerout on the container
    };

    const updatePreviewSprite = async (dataUrl: string, w: number, h: number) => {
      lastRequestedPreviewUrl = dataUrl;

      // clean up existing sprite
      if (previewSprite) {
        container.removeChild(previewSprite);
        previewSprite.destroy();
        previewSprite = null;
      }
      // NOTE: do NOT call Assets.unload() here — previewUrl is always a
      // data: URL, which can be shared with other live consumers of the
      // same texture (another canvas-card with the same previewUrl, the
      // canvas-wizard's own preview field, a file widget's thumbnail,
      // etc). unloading it out from under them crashes the renderer
      // mid-frame ("alphaMode" null error in StencilMaskPipe, since this
      // widget's own preview sprite is masked) — same root cause already
      // fixed the same way in file.ts/property-tray.ts/canvas-wizard.ts.

      if (!dataUrl) return;

      try {
        const texture = await Assets.load<Texture>(dataUrl);
        // race check — another load may have started while we were loading
        if (lastRequestedPreviewUrl !== dataUrl) return;

        const previewH = Math.floor(h * PREVIEW_RATIO);
        const top = ACCENT_HEIGHT;

        previewSprite = new Sprite(texture);
        previewSprite.eventMode = "none";

        // cover/fill the preview area — scale up to fill, center-crop overflow
        const maxW = w - 2;
        const maxH = previewH;
        const scale = Math.max(maxW / texture.width, maxH / texture.height);
        previewSprite.width = texture.width * scale;
        previewSprite.height = texture.height * scale;
        previewSprite.x = 1 + (maxW - previewSprite.width) / 2;
        previewSprite.y = top + (maxH - previewSprite.height) / 2;

        // clip to preview area
        previewMask.clear();
        previewMask.rect(1, top, w - 2, previewH);
        previewMask.fill({ color: 0xffffff });
        previewSprite.mask = previewMask;

        container.addChild(previewSprite);
      } catch {
        // silently ignore load failures
      }
    };

    const drawAuthorBadge = (w: number, h: number, state: CanvasCardState) => {
      // for remote cards, prefer live friend data over the card's own
      // props — ownerUsername/ownerAvatarDataUrl are only ever stamped
      // once, at card-creation time (from whatever the inviter/share link
      // knew then), and go stale the moment the friend's profile changes
      // (or was learned only after this card already existed). the local
      // social doc is the current source of truth for a known friend, so
      // look it up fresh on every render instead, same as isOnline() below.
      const friendInfo = state.isRemote ? getFriendInfo(state.ownerNodeId) : null;
      const displayName = state.isRemote
        ? (friendInfo?.username || state.ownerUsername).trim() || state.ownerNodeId.slice(0, 8)
        : state.authorName.trim();

      // clear any avatar drawn on a previous layout() pass — renderAvatar
      // always appends fresh children, so the container must be emptied
      // first rather than redrawn in place.
      while (authorAvatarContainer.children.length > 0) {
        authorAvatarContainer.removeChildAt(0).destroy({ children: true });
      }

      if (displayName.length === 0) {
        authorNameText.visible = false;
        authorAvatarContainer.visible = false;
        return;
      }

      authorNameText.visible = true;

      const footerY = h - FOOTER_HEIGHT;
      const AVATAR_SIZE = 14;
      // avatar only for remote cards — a local card's "author" is just the
      // user themselves, nothing to show a picture of.
      const showAvatar = state.isRemote;
      authorAvatarContainer.visible = showAvatar;
      const avatarReserved = showAvatar ? AVATAR_SIZE + 4 : 0;

      // leave room for the date/edited text sharing this same footer row
      // (dateText.text/x/y are already set earlier in layout(), before this
      // is called) — reuse its measured width rather than re-deriving it.
      const dateReserved = dateText.visible ? dateText.width + AUTHOR_NAME_GAP : 0;
      const maxWidth = Math.max(20, w - PADDING_X * 2 - dateReserved - avatarReserved);
      const maxChars = estimateMaxChars(maxWidth, AUTHOR_NAME_FONT_SIZE);

      authorNameText.text = truncate(displayName, maxChars);
      authorNameText.x = w - PADDING_X;
      authorNameText.y = footerY + FOOTER_HEIGHT / 2;

      if (showAvatar) {
        const avatarCenterX = authorNameText.x - authorNameText.width - avatarReserved / 2;
        renderAvatar({
          parent: authorAvatarContainer,
          cacheKey: `canvas-card-owner-avatar-${state.ownerNodeId}`,
          centerX: avatarCenterX,
          centerY: footerY + FOOTER_HEIGHT / 2,
          size: AVATAR_SIZE,
          displayName,
          colorSeed: 0,
          avatarUrl: friendInfo?.avatarDataUrl || state.ownerAvatarDataUrl,
          online: isOnline(state.ownerNodeId),
          dotBorderColor: BG_COLOR,
        });
      }
    };

    const drawRemoteBadge = (w: number, remote: boolean) => {
      if (remote) {
        remoteBadge.x = w - PADDING_X + 2;
        remoteBadge.y = ACCENT_HEIGHT + 4;
        remoteBadge.visible = true;
      } else {
        remoteBadge.visible = false;
      }
    };

    const drawRolePill = (state: CanvasCardState, pillX: number, pillY: number): number => {
      if (!state.isRemote || state.role === "admin") {
        rolePill.visible = false;
        rolePillText.visible = false;
        return 0;
      }

      const pillColor = state.role === "member" ? ROLE_MEMBER_COLOR : ROLE_VIEWER_COLOR;
      rolePillText.text = state.role;
      rolePillText.style.fill = pillColor;

      // measure text to size the pill
      const tw = rolePillText.width;
      const th = rolePillText.height;
      const pw = tw + ROLE_PILL_PAD_X * 2;
      const ph = th + ROLE_PILL_PAD_Y * 2;

      rolePill.clear();
      rolePill.roundRect(pillX, pillY, pw, ph, ph / 2);
      rolePill.fill({ color: pillColor, alpha: 0.15 });
      rolePill.roundRect(pillX, pillY, pw, ph, ph / 2);
      rolePill.stroke({ color: pillColor, width: 0.5, alpha: 0.5 });

      rolePillText.x = pillX + ROLE_PILL_PAD_X;
      rolePillText.y = pillY + ROLE_PILL_PAD_Y;

      rolePill.visible = true;
      rolePillText.visible = true;

      return ph + 4; // total height offset for content below the pill
    };

    const drawRevokedOverlay = (w: number, h: number, revoked: boolean) => {
      revokedOverlay.clear();
      if (revoked) {
        revokedOverlay.roundRect(0, 0, w, h, CARD_RADIUS);
        revokedOverlay.fill({ color: 0x000000, alpha: REVOKED_OVERLAY_ALPHA });
        revokedOverlay.visible = true;
        revokedText.x = w / 2;
        revokedText.y = h / 2;
        revokedText.visible = true;
      } else {
        revokedOverlay.visible = false;
        revokedText.visible = false;
      }
    };

    const drawDeletedOverlay = (w: number, h: number, state: CanvasCardState) => {
      deletedOverlay.clear();
      if (state.isDeleted) {
        deletedOverlay.roundRect(0, 0, w, h, CARD_RADIUS);
        deletedOverlay.fill({ color: 0x000000, alpha: DELETED_OVERLAY_ALPHA });
        deletedOverlay.visible = true;

        // primary label — "canvas deleted" or "canvas purged"
        const isPurge = state.deleteMode === "purge";
        deletedText.text = isPurge ? "canvas purged" : "canvas deleted";
        deletedText.x = w / 2;
        deletedText.y = h / 2 - 8;
        deletedText.visible = true;

        // secondary label — who deleted it (truncated node id prefix)
        if (state.deletedBy) {
          const prefix =
            state.deletedBy.length > 8 ? state.deletedBy.slice(0, 8) + "\u2026" : state.deletedBy;
          deletedByText.text = "by " + prefix;
          deletedByText.x = w / 2;
          deletedByText.y = h / 2 + 8;
          deletedByText.visible = true;
        } else {
          deletedByText.visible = false;
        }
      } else {
        deletedOverlay.visible = false;
        deletedText.visible = false;
        deletedByText.visible = false;
      }
    };

    const drawUpdatePill = (w: number, state: CanvasCardState) => {
      updatePill.clear();
      if (state.hasUpdates) {
        const col = isTransparent(state.color) ? 0x444460 : safeColor(state.color);

        // measure text to size the pill
        updatePillText.text = "updated";
        const tw = updatePillText.width;
        const th = updatePillText.height;
        const dotR = 3;
        const dotGap = 4;
        const padX = 6;
        const padY = 3;
        const pillW = padX + dotR * 2 + dotGap + tw + padX;
        const pillH = th + padY * 2;
        const pillX = w - PADDING_X - pillW;
        const pillY = ACCENT_HEIGHT + 5;
        const pillR = pillH / 2;

        // pill background — dark base with accent tint for readability
        updatePill.roundRect(pillX, pillY, pillW, pillH, pillR);
        updatePill.fill({ color: 0x000000, alpha: 0.7 });
        updatePill.roundRect(pillX, pillY, pillW, pillH, pillR);
        updatePill.fill({ color: col, alpha: 0.15 });
        updatePill.roundRect(pillX, pillY, pillW, pillH, pillR);
        updatePill.stroke({ color: col, width: 0.5, alpha: 0.6 });

        // dot inside the pill
        const dotCx = pillX + padX + dotR;
        const dotCy = pillY + pillH / 2;
        updatePill.circle(dotCx, dotCy, dotR);
        updatePill.fill({ color: col });

        // position text after the dot
        updatePillText.style.fill = col;
        updatePillText.x = dotCx + dotR + dotGap;
        updatePillText.y = pillY + padY;
        updatePillText.visible = true;

        updatePill.visible = true;
      } else {
        updatePill.visible = false;
        updatePillText.visible = false;
      }
    };

    const drawSyncingIndicator = (w: number, _h: number, state: CanvasCardState) => {
      // show for remote cards that have never been visited, but not while
      // a request-access pill is already covering the same ground (a card
      // stuck pending access isn't just "new", it can't actually be opened
      // yet).
      const isNew =
        state.isRemote && !state.lastVisitedAt && !state.accessRevoked && !state.accessPending;
      syncingContainer.visible = isNew;
      if (!isNew) return;

      const tw = syncingText.width;
      const th = syncingText.height;
      const padX = 6;
      const padY = 2;
      const pillW = tw + padX * 2;
      const pillH = th + padY * 2;
      const pillX = w - pillW - PADDING_X;
      const pillY = ACCENT_HEIGHT + 6;

      syncingBg.clear();
      syncingBg.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
      syncingBg.fill({ color: 0x22c55e, alpha: 0.15 });
      syncingBg.stroke({ color: 0x22c55e, width: 1, alpha: 0.4 });

      syncingText.x = pillX + padX;
      syncingText.y = pillY + padY;
    };

    const REQUEST_SENT_COLOR = 0x888898;
    const REQUEST_DECLINED_COLOR = 0xef4444;

    const drawRequestAccessPill = (w: number, _h: number, state: CanvasCardState) => {
      const show = state.isRemote && state.accessPending && !state.accessRevoked && !state.isDeleted;
      requestAccessContainer.visible = show;
      if (!show) return;

      // once clicked, the pill stops being clickable — a knock is already
      // in flight (or delivered) and the app retries delivery on its own
      // whenever the owner or a fallback hub comes online, so a second
      // click would only risk minting a duplicate knock rather than
      // helping anything land faster. a decline reopens it for a retry.
      const requested = !!state.accessRequestedAt;
      const declined = !requested && state.accessDeclined;
      const delivered = requested && hasKnockAckForCanvas(state.canvasDocId);
      requestAccessContainer.eventMode = requested ? "none" : "static";
      requestAccessContainer.cursor = requested ? "default" : "pointer";

      const color = declined ? REQUEST_DECLINED_COLOR : requested ? REQUEST_SENT_COLOR : 0xf59e0b;
      requestAccessText.text = declined
        ? "access declined \u2022 tap to retry"
        : delivered
          ? "request sent \u2022 waiting for admin"
          : requested
            ? "request sent"
            : "request access";
      requestAccessText.style.fill = color;

      const tw = requestAccessText.width;
      const th = requestAccessText.height;
      const padX = 6;
      const padY = 2;
      const pillW = tw + padX * 2;
      const pillH = th + padY * 2;
      const pillX = w - pillW - PADDING_X;
      const pillY = ACCENT_HEIGHT + 6;

      requestAccessBg.clear();
      requestAccessBg.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
      requestAccessBg.fill({ color, alpha: 0.15 });
      requestAccessBg.stroke({ color, width: 1, alpha: 0.4 });

      requestAccessText.x = pillX + padX;
      requestAccessText.y = pillY + padY;
    };

    const HUB_SENT_COLOR = 0x888898;

    const drawConnectHubPill = (w: number, _h: number, state: CanvasCardState) => {
      const show =
        state.isRemote &&
        state.accessPending &&
        !state.accessRevoked &&
        !state.isDeleted &&
        state.hubNodeIds.length > 0;
      connectHubContainer.visible = show;
      if (!show) return;

      // once clicked, stops being clickable — the friend request +
      // connect attempt is already in flight, and a second click would
      // only risk sending a duplicate friend request.
      const requested = !!state.hubConnectRequestedAt;
      connectHubContainer.eventMode = requested ? "none" : "static";
      connectHubContainer.cursor = requested ? "default" : "pointer";

      const color = requested ? HUB_SENT_COLOR : 0x38bdf8;
      connectHubText.text = requested ? "connecting via hub..." : "connect via hub";
      connectHubText.style.fill = color;

      const tw = connectHubText.width;
      const th = connectHubText.height;
      const padX = 6;
      const padY = 2;
      const pillW = tw + padX * 2;
      const pillH = th + padY * 2;
      const pillX = w - pillW - PADDING_X;
      // stacked just below the request-access pill, same right edge —
      // both can be visible at once (a stranger may want either path).
      const pillY = ACCENT_HEIGHT + 6 + pillH + 4;

      connectHubBg.clear();
      connectHubBg.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
      connectHubBg.fill({ color, alpha: 0.15 });
      connectHubBg.stroke({ color, width: 1, alpha: 0.4 });

      connectHubText.x = pillX + padX;
      connectHubText.y = pillY + padY;
    };

    // --- full layout ---

    const layout = (w: number, h: number) => {
      const state = ctx.doc.current;
      const contentWidth = w - PADDING_X * 2;
      const previewH = Math.floor(h * PREVIEW_RATIO);
      const textTop = ACCENT_HEIGHT + previewH + PADDING_Y;

      drawCardBg(w, h, state.isRemote);
      drawAccent(w, state.color, state.isRemote);
      drawPreview(w, h, state);
      // only reload the sprite when the URL changes
      if (state.previewUrl !== lastRequestedPreviewUrl) {
        updatePreviewSprite(state.previewUrl, w, h);
      }

      // hint text below preview icon
      const previewH2 = Math.floor(h * PREVIEW_RATIO);
      const previewCenterY = ACCENT_HEIGHT + previewH2 / 2;
      hintText.x = w / 2;
      hintText.y = previewCenterY + 18;

      // title
      const titleMaxChars = estimateMaxChars(contentWidth, TITLE_FONT_SIZE);
      titleText.text = truncate(state.title || "untitled canvas", titleMaxChars);
      titleText.x = PADDING_X;
      titleText.y = textTop;

      // role pill (remote cards only, below title)
      const pillY = textTop + TITLE_FONT_SIZE + 2;
      const pillOffset = drawRolePill(state, PADDING_X, pillY);

      // description — allow two lines, then truncate
      const descMaxWidth = contentWidth;
      descText.style.wordWrapWidth = descMaxWidth;
      const descTopY = textTop + TITLE_FONT_SIZE + 4 + pillOffset;
      const descAvailH = h - descTopY - FOOTER_HEIGHT - PADDING_Y;
      const maxDescLines = Math.max(1, Math.floor(descAvailH / (DESC_FONT_SIZE * 1.35)));
      const descMaxCharsPerLine = estimateMaxChars(descMaxWidth, DESC_FONT_SIZE);
      const descMaxChars = descMaxCharsPerLine * Math.min(maxDescLines, 2);

      if (state.description) {
        descText.text = truncate(state.description, descMaxChars);
        descText.visible = true;
      } else {
        descText.text = "";
        descText.visible = false;
      }
      descText.x = PADDING_X;
      descText.y = descTopY;

      // footer: timestamps
      const footerY = h - FOOTER_HEIGHT;
      const hasModified = !!state.modifiedAt;
      const hasCreated = !!state.createdAt;

      if (hasModified && state.modifiedAt !== state.createdAt) {
        dateText.text = "edited " + formatRelativeTime(state.modifiedAt);
        dateText.style.fontStyle = "italic";
        dateText.visible = true;
      } else if (hasCreated) {
        dateText.text = formatShortDate(state.createdAt);
        dateText.style.fontStyle = "normal";
        dateText.visible = true;
      } else {
        dateText.text = "";
        dateText.visible = false;
      }
      dateText.x = PADDING_X;
      dateText.y = footerY + (FOOTER_HEIGHT - DATE_FONT_SIZE) / 2;

      // footer: author badge on the right (shows owner info for remote cards)
      drawAuthorBadge(w, h, state);

      // remote card extras
      drawRemoteBadge(w, state.isRemote);
      drawRevokedOverlay(w, h, state.isRemote && state.accessRevoked);

      // update pill indicator for new activity on shared canvases
      drawUpdatePill(w, state);

      // syncing indicator for newly accepted remote cards
      drawSyncingIndicator(w, h, state);

      // request-access pill for remote cards that never successfully synced
      drawRequestAccessPill(w, h, state);

      // connect-via-hub pill for remote cards whose share link carried hub node ids
      drawConnectHubPill(w, h, state);

      // deleted overlay — renders above the update pill
      drawDeletedOverlay(w, h, state);

      // cursor style — revoked and purged cards shouldn't look clickable
      if (state.isRemote && state.accessRevoked) {
        container.cursor = "not-allowed";
      } else if (state.isDeleted && state.deleteMode === "purge") {
        container.cursor = "not-allowed";
      } else if (state.isDeleted) {
        container.cursor = "default";
      } else {
        container.cursor = "pointer";
      }
    };

    // --- initial draw ---
    layout(currentWidth, currentHeight);

    // gentle pulse for the syncing indicator
    let syncPulseDir = -1;
    const syncPulseTimer = setInterval(() => {
      if (!syncingContainer.visible) return;
      syncingContainer.alpha += syncPulseDir * 0.02;
      if (syncingContainer.alpha <= 0.4) syncPulseDir = 1;
      if (syncingContainer.alpha >= 1.0) syncPulseDir = -1;
    }, 50);

    // --- hover effects ---

    container.on("pointerover", () => {
      hovered = true;
      drawCardBg(currentWidth, currentHeight, ctx.doc.current.isRemote);
      hintText.visible = true;
      previewIcon.visible = true;
    });

    container.on("pointerout", () => {
      hovered = false;
      drawCardBg(currentWidth, currentHeight, ctx.doc.current.isRemote);
      hintText.visible = false;
      previewIcon.visible = false;
    });

    // --- click navigation ---

    container.on("pointertap", () => {
      const state = ctx.doc.current;
      if (state.accessRevoked) return;
      // purged canvases are being auto-deleted, don't navigate
      if (state.isDeleted && state.deleteMode === "purge") return;
      if (state.canvasDocId) {
        window.location.hash = state.canvasDocId;
      }
    });

    // --- request-access pill click ---
    // a separate hit target from the whole-card tap above — stops
    // propagation so tapping the pill sends a knock instead of also
    // triggering navigation to a canvas that's known not to be reachable yet.
    requestAccessContainer.on("pointertap", (event) => {
      event.stopPropagation();
      const state = ctx.doc.current;
      if (!state.canvasDocId || !state.ownerNodeId) return;
      // already requested — drawRequestAccessPill() disables the hit
      // target for this case too, but guard here as well in case a tap
      // event was already in flight when that ran.
      if (state.accessRequestedAt) return;
      ctx.doc.change((d: CanvasCardState) => {
        d.accessRequestedAt = new Date().toISOString();
        d.accessDeclined = false;
      });
      window.dispatchEvent(
        new CustomEvent("skein:request-canvas-access", {
          detail: {
            canvasDocId: state.canvasDocId,
            ownerNodeId: state.ownerNodeId,
          },
        })
      );
    });

    // --- connect-via-hub pill click ---
    // a separate hit target, same rationale as the request-access pill
    // above: stops propagation so tapping the pill connects to the hub
    // instead of also navigating to a canvas known not to be reachable
    // directly yet. this is the explicit, user-initiated action required
    // before any friend request or connection attempt is made against a
    // hub node id discovered from a share link — never automatic.
    connectHubContainer.on("pointertap", (event) => {
      event.stopPropagation();
      const state = ctx.doc.current;
      const hubNodeId = state.hubNodeIds[0];
      if (!hubNodeId) return;
      if (state.hubConnectRequestedAt) return;
      ctx.doc.change((d: CanvasCardState) => {
        d.hubConnectRequestedAt = new Date().toISOString();
      });
      window.dispatchEvent(
        new CustomEvent("skein:connect-via-hub", {
          detail: { hubNodeId },
        })
      );
    });

    // --- title sync ---
    // the canvas card's doc has its own title field (doc.current.title).
    // the widget frame header uses entry.title (from the canvas store).
    // keep them in sync so editing either one updates both.
    let titleSyncing = false;

    const syncDocTitleToEntry = () => {
      if (titleSyncing) return;
      const docTitle = ctx.doc.current.title;
      const entry = ctx.canvasStore?.getWidget(ctx.widgetId);
      if (!entry) return;
      const entryTitle = entry.title ?? "";
      if (docTitle && docTitle !== entryTitle) {
        titleSyncing = true;
        ctx.canvasStore?.setWidgetTitle(ctx.widgetId, docTitle);
        titleSyncing = false;
      }
    };

    const syncEntryTitleToDoc = () => {
      if (titleSyncing) return;
      const entry = ctx.canvasStore?.getWidget(ctx.widgetId);
      if (!entry) return;
      const entryTitle = entry.title ?? "";
      const docTitle = ctx.doc.current.title;
      if (entryTitle && entryTitle !== docTitle) {
        titleSyncing = true;
        ctx.doc.change((d: any) => {
          d.title = entryTitle;
        });
        titleSyncing = false;
      }
    };

    // initial sync: doc title -> entry title (doc title is the source on first mount)
    syncDocTitleToEntry();

    // listen for doc changes -> push to entry title
    const unsubDocTitle = ctx.doc.on("change", () => {
      syncDocTitleToEntry();
    });

    // listen for store changes -> push to doc title
    const unsubStoreTitle = ctx.canvasStore?.onChange(() => {
      syncEntryTitleToDoc();
    });

    // --- subscribe to doc changes ---

    const unsub = ctx.doc.on("change", () => {
      layout(currentWidth, currentHeight);
    });

    // a remote card's owner badge (drawAuthorBadge) reads live friend info
    // (username/avatar) via getFriendInfo() at render time — re-run layout
    // whenever the friends list changes (profile response arrives, avatar
    // synced later, etc.) so an already-mounted card picks it up without
    // needing a reload or an unrelated prop change to force a redraw.
    const unsubFriends = onFriendsChange(() => {
      if (ctx.doc.current.isRemote) layout(currentWidth, currentHeight);
    });

    // the request-access pill's "waiting for admin" text (drawRequestAccessPill)
    // depends on hasKnockAckForCanvas(), a session-only signal — re-run
    // layout whenever any knock is acked so a pill already showing
    // "request sent" upgrades live the moment delivery is confirmed,
    // without needing a reload.
    const unsubKnockAcked = onKnockAcked(() => {
      layout(currentWidth, currentHeight);
    });

    return {
      container,
      destroy() {
        clearInterval(syncPulseTimer);
        unsub();
        unsubDocTitle();
        unsubStoreTitle?.();
        unsubFriends();
        unsubKnockAcked();
        if (previewSprite) {
          container.removeChild(previewSprite);
          previewSprite.mask = null;
          previewSprite.destroy();
          previewSprite = null;
        }
        // see updatePreviewSprite()'s comment above — never unload a data:
        // URL texture, it may still be referenced elsewhere.
        container.destroy({ children: true });
      },
      resize(width: number, height: number) {
        currentWidth = width;
        currentHeight = height;
        layout(width, height);
      },
    };
  },
};

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { z } from "zod";
import type { DocumentId } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import type { CanvasDocument } from "../../src/canvas/canvas-doc";
import { resolveDocReadyCached } from "../../src/p2p/doc-ready";
import type { WidgetController, WidgetFactory, WidgetMountContext } from "../../src/widgets/widget-types";
import {
  cancelTransfer,
  clearCompletedTransfers,
  pauseTransfer,
} from "../../src/file-utils/pending-transfers";

const TAG = "widgets.filez";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

// mirrors pending-transfers.ts's PendingTransferItem — this widget never
// mutates the doc itself (state is driven entirely by boot.ts's
// subscribeToPendingTransfers wiring), the schema exists only to type
// ctx.doc.current for the ephemeral overlay mount (see mountCanvasInfoOverlay's
// pattern in boot.ts, which this widget follows).
const pendingTransferItemSchema = z.object({
  id: z.string(),
  direction: z.enum(["upload", "download", "serving"]),
  state: z.enum(["queued", "active", "completed"]),
  blobId: z.string().optional(),
  filename: z.string().optional(),
  peerId: z.string().optional(),
  peerName: z.string().optional(),
  canvasIds: z.array(z.string()).optional(),
  fraction: z.number().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  canPause: z.boolean(),
  canCancel: z.boolean(),
});

export const filezSchema = z.object({
  items: z.array(pendingTransferItemSchema).default([]),
});

export type FilezState = z.infer<typeof filezSchema>;
type FilezItem = z.infer<typeof pendingTransferItemSchema>;

// ---------------------------------------------------------------------------
// layout constants
// ---------------------------------------------------------------------------

const BG = 0x1a1a24;
const BORDER = 0x2a2a3e;
const TEXT_COLOR = 0xf0f0ff;
const MUTED_TEXT = 0x666678;
const ACCENT_COLOR = 0x3b82f6;
const CARD_RADIUS = 6;
const PADDING_X = 16;
const PADDING_Y = 14;
const HEADER_HEIGHT = 30;
const ROW_HEIGHT = 62;
const ROW_PADDING_X = 10;
const COLOR_STRIPE_WIDTH = 3;
const TITLE_FONT_SIZE = 12;
const ROW_NAME_SIZE = 11;
const ROW_SUB_SIZE = 9;
const ROW_ALT_BG = 0x1f1f2c;
const SCROLL_SPEED = 30;
const CTRL_BTN_W = 44;
const CTRL_BTN_H = 16;
const CTRL_BTN_GAP = 6;
const FONT = "system-ui, sans-serif";
const RESOLUTION = 3;

const DIRECTION_INFO: Record<FilezItem["direction"], { label: string; color: number }> = {
  upload: { label: "upload", color: 0x3b82f6 },
  download: { label: "download", color: 0x22c55e },
  serving: { label: "serving", color: 0x8b5cf6 },
};

/** truncate a string so it fits within a rough character budget. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1).trimEnd() + "\u2026";
}

function truncateId(id: string, len = 10): string {
  return id.length > len ? `${id.slice(0, len)}\u2026` : id;
}

/** relative-time label for a completed row's completedAt timestamp. */
function formatCompletedAgo(completedAt: number | undefined): string {
  if (!completedAt) return "done";
  const deltaMs = Date.now() - completedAt;
  if (deltaMs < 60_000) return "done just now";
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 60) return `done ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `done ${hours}h ago`;
}

// ---------------------------------------------------------------------------
// widget factory
// ---------------------------------------------------------------------------

export const filezWidget: WidgetFactory<typeof filezSchema> = {
  type: "filez",
  metadata: {
    name: "filez",
    description: "pending uploads, downloads, and outgoing transfers",
    version: "0.1.0",
    category: "narthex",
    hidden: true,
    singleton: true,
    singletonId: "skein-filez",
    defaultWidth: 560,
    defaultHeight: 340,
  },
  schema: filezSchema,
  editableProps: [],

  create(ctx: WidgetMountContext<typeof filezSchema>): WidgetController {
    const container = new Container();
    container.eventMode = "static";

    let currentWidth = ctx.width;
    let currentHeight = ctx.height;
    let destroyed = false;

    // canvas title lookups are best-effort/async (repo.find always returns
    // a Promise) — cache resolved titles and re-layout once they arrive,
    // rather than blocking row rendering on them. undefined = not yet
    // attempted, null = attempted and unresolvable.
    const canvasTitleCache = new Map<string, string | null>();
    const resolvingCanvasIds = new Set<string>();

    // tracks a pause/cancel click that's in flight for a given item id, so
    // the row can show "pausing…"/"cancelling…" and ignore a second click
    // instead of leaving the button looking inert until the next poll tick
    // (300ms away) actually changes the item's state.
    const pendingActions = new Map<string, "pause" | "cancel">();

    function resolveCanvasTitle(canvasDocId: string): string | null {
      if (canvasTitleCache.has(canvasDocId)) return canvasTitleCache.get(canvasDocId) ?? null;
      if (!ctx.canvasStore || resolvingCanvasIds.has(canvasDocId)) return null;
      resolvingCanvasIds.add(canvasDocId);
      resolveDocReadyCached<CanvasDocument>(ctx.canvasStore.repo, canvasDocId as DocumentId, {
        timeoutMs: 4000,
      })
        .then((handle) => {
          resolvingCanvasIds.delete(canvasDocId);
          const title = handle?.isReady() ? handle.doc()?.title || null : null;
          canvasTitleCache.set(canvasDocId, title);
          if (!destroyed) layout(currentWidth, currentHeight);
        })
        .catch(() => {
          resolvingCanvasIds.delete(canvasDocId);
          canvasTitleCache.set(canvasDocId, null);
        });
      return null;
    }

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
    // header
    // -----------------------------------------------------------------------

    const titleText = new Text({
      text: "transfers",
      style: { fontFamily: FONT, fontSize: TITLE_FONT_SIZE, fill: TEXT_COLOR },
      resolution: RESOLUTION,
    });
    titleText.eventMode = "none";
    container.addChild(titleText);

    const countText = new Text({
      text: "",
      style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    countText.eventMode = "none";
    container.addChild(countText);

    // only visible once there's at least one completed row to clear.
    const clearCompletedBtn = new Text({
      text: "clear completed",
      style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    clearCompletedBtn.eventMode = "static";
    clearCompletedBtn.cursor = "pointer";
    clearCompletedBtn.on("pointertap", () => clearCompletedTransfers());
    container.addChild(clearCompletedBtn);

    const headerDivider = new Graphics();
    container.addChild(headerDivider);

    // -----------------------------------------------------------------------
    // list area (scrollable, masked) — single tab only right now; a "local
    // files" tab is deferred, see this widget's plan doc. rows are built by
    // renderRows() below so a future tab can reuse it for a different item
    // source without a rewrite.
    // -----------------------------------------------------------------------

    let scrollY = 0;
    let listAreaY = 0;
    let listAreaHeight = 0;
    let totalListHeight = 0;

    const listContainer = new Container();
    listContainer.eventMode = "static";
    container.addChild(listContainer);

    const listMask = new Graphics();
    container.addChild(listMask);
    listContainer.mask = listMask;

    const listInner = new Container();
    listInner.eventMode = "static";
    listContainer.addChild(listInner);

    const emptyText = new Text({
      text: "no transfers",
      style: { fontFamily: FONT, fontSize: 11, fill: MUTED_TEXT },
      resolution: RESOLUTION,
    });
    emptyText.eventMode = "none";
    container.addChild(emptyText);

    const clampListScroll = () => {
      const maxScroll = Math.max(0, totalListHeight - listAreaHeight);
      scrollY = Math.max(0, Math.min(scrollY, maxScroll));
    };

    listContainer.on("wheel", (e: WheelEvent) => {
      const canScroll = totalListHeight > listAreaHeight;
      if (!canScroll) return; // let the event pass through to the canvas viewport

      e.stopPropagation();
      if ((e as any).nativeEvent) (e as any).nativeEvent._skeinWidgetScroll = true;
      scrollY += e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED;
      clampListScroll();
      listInner.y = -scrollY;
    });

    // -----------------------------------------------------------------------
    // row rendering
    // -----------------------------------------------------------------------

    function renderRows(items: FilezItem[], contentW: number): void {
      while (listInner.children.length > 0) {
        listInner.removeChildAt(0).destroy({ children: true });
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const dirInfo = DIRECTION_INFO[item.direction];
        const rowY = i * ROW_HEIGHT;

        const rowContainer = new Container();
        rowContainer.eventMode = "static";
        rowContainer.y = rowY;
        listInner.addChild(rowContainer);

        // alternating row background
        const rowBg = new Graphics();
        rowBg.eventMode = "none";
        if (i % 2 === 1) {
          rowBg.rect(0, 0, contentW, ROW_HEIGHT);
          rowBg.fill({ color: ROW_ALT_BG, alpha: 0.5 });
        }
        rowContainer.addChild(rowBg);

        // color stripe on left edge (direction)
        const stripe = new Graphics();
        stripe.eventMode = "none";
        stripe.rect(0, 0, COLOR_STRIPE_WIDTH, ROW_HEIGHT);
        stripe.fill({ color: dirInfo.color });
        rowContainer.addChild(stripe);

        // controls (pause/cancel) reserve space on the right — real,
        // clickable buttons, see the render loop below.
        const showPause = item.canPause;
        const showCancel = item.canCancel;
        const controlsW =
          (showPause ? CTRL_BTN_W : 0) +
          (showCancel ? CTRL_BTN_W : 0) +
          (showPause && showCancel ? CTRL_BTN_GAP : 0);
        const controlsReserved = controlsW > 0 ? controlsW + CTRL_BTN_GAP : 0;

        const textLeft = COLOR_STRIPE_WIDTH + ROW_PADDING_X;
        const textW = Math.max(20, contentW - textLeft - ROW_PADDING_X - controlsReserved);

        // line 1: direction + filename
        const filename = item.filename ?? (item.blobId ? truncateId(item.blobId) : "unknown file");
        const dirLabel = new Text({
          text: dirInfo.label,
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: dirInfo.color, fontWeight: "bold" },
          resolution: RESOLUTION,
        });
        dirLabel.eventMode = "none";
        dirLabel.x = textLeft;
        dirLabel.y = 8;
        rowContainer.addChild(dirLabel);

        const filenameMaxChars = Math.max(
          4,
          Math.floor((textW - dirLabel.width - 8) / (ROW_NAME_SIZE * 0.55))
        );
        const filenameText = new Text({
          text: truncate(filename, filenameMaxChars),
          style: { fontFamily: FONT, fontSize: ROW_NAME_SIZE, fill: TEXT_COLOR },
          resolution: RESOLUTION,
        });
        filenameText.eventMode = "none";
        filenameText.x = textLeft + dirLabel.width + 8;
        filenameText.y = 7;
        rowContainer.addChild(filenameText);

        // line 2: peer/hub + canvas (canvas omitted if unresolvable)
        const peerDisplay = item.peerName ?? (item.peerId ? truncateId(item.peerId) : "\u2014");
        let subtitle = `with: ${peerDisplay}`;
        if (item.canvasIds && item.canvasIds.length > 0) {
          const names = item.canvasIds
            .map((id) => resolveCanvasTitle(id))
            .filter((n): n is string => !!n);
          if (names.length > 0) {
            subtitle += ` \u2022 in: ${names.join(", ")}`;
          }
        }
        const subtitleMaxChars = Math.max(4, Math.floor(textW / (ROW_SUB_SIZE * 0.55)));
        const subtitleText = new Text({
          text: truncate(subtitle, subtitleMaxChars),
          style: { fontFamily: FONT, fontSize: ROW_SUB_SIZE, fill: MUTED_TEXT },
          resolution: RESOLUTION,
        });
        subtitleText.eventMode = "none";
        subtitleText.x = textLeft;
        subtitleText.y = 26;
        rowContainer.addChild(subtitleText);

        // line 3: progress readout — completed rows show a relative-time
        // "done" label instead (see PendingTransferItem's doc comment for
        // why upload/download have no live fraction while queued/in-flight).
        let progressLabel = "";
        if (item.state === "completed") {
          progressLabel = formatCompletedAgo(item.completedAt);
        } else if (item.fraction !== undefined) {
          progressLabel = `${Math.round(item.fraction * 100)}%`;
        } else if (item.state === "queued") {
          progressLabel = "queued";
        }
        if (progressLabel) {
          const progressText = new Text({
            text: progressLabel,
            style: {
              fontFamily: FONT,
              fontSize: ROW_SUB_SIZE,
              fill: item.fraction !== undefined ? ACCENT_COLOR : MUTED_TEXT,
            },
            resolution: RESOLUTION,
          });
          progressText.eventMode = "none";
          progressText.x = textLeft;
          progressText.y = 42;
          rowContainer.addChild(progressText);
        }

        // pause/cancel — real actions, wired to pending-transfers.ts's
        // cancelTransfer()/pauseTransfer() (which in turn drive an actual
        // AbortController / snatch.ts's pauseSnatchDownload). only rendered
        // when the row's own canPause/canCancel say it's possible — always
        // false for completed/serving rows. buttons disable and relabel
        // themselves the moment they're clicked (see runAction/pendingActions
        // above) rather than waiting on the next poll tick for feedback.
        let ctrlX = contentW - ROW_PADDING_X - controlsW;
        const ctrlY = (ROW_HEIGHT - CTRL_BTN_H) / 2;
        const pending = pendingActions.get(item.id);
        if (showPause) {
          const isPending = pending === "pause";
          rowContainer.addChild(
            buildActionButton(isPending ? "pausing…" : "pause", ctrlX, ctrlY, isPending, () =>
              runAction(item, "pause")
            )
          );
          ctrlX += CTRL_BTN_W + CTRL_BTN_GAP;
        }
        if (showCancel) {
          const isPending = pending === "cancel";
          rowContainer.addChild(
            buildActionButton(isPending ? "cancelling…" : "cancel", ctrlX, ctrlY, isPending, () =>
              runAction(item, "cancel")
            )
          );
        }

        // completed rows are dimmed to visually separate them from live
        // transfers, without hiding them outright.
        rowContainer.alpha = item.state === "completed" ? 0.55 : 1;
      }

      totalListHeight = items.length * ROW_HEIGHT;
    }

    /**
     * fire a pause/cancel click: logs the attempt (visible with dev-build
     * debug logging — see log.ts), marks the item pending so its button
     * relabels/disables immediately, then clears the pending flag and
     * re-layouts once the call settles either way. ignores a second click
     * while one's already in flight for this item.
     */
    function runAction(item: FilezItem, action: "pause" | "cancel"): void {
      if (pendingActions.has(item.id)) return;
      pendingActions.set(item.id, action);
      log.debug(
        TAG,
        `${action} requested: id=${item.id} direction=${item.direction} blob=${item.blobId ?? "?"}`
      );
      if (!destroyed) layout(currentWidth, currentHeight);

      const run = action === "pause" ? pauseTransfer(item) : cancelTransfer(item);
      void run
        .then((ok) => {
          log.debug(TAG, `${action} ${ok ? "succeeded" : "reported nothing to do"}: id=${item.id}`);
        })
        .catch((err) => {
          log.debug(TAG, `${action} failed: id=${item.id}`, err);
        })
        .finally(() => {
          pendingActions.delete(item.id);
          if (!destroyed) layout(currentWidth, currentHeight);
        });
    }

    function buildActionButton(
      label: string,
      x: number,
      y: number,
      disabled: boolean,
      onClick: () => void
    ): Container {
      const btn = new Container();
      btn.x = x;
      btn.y = y;
      btn.eventMode = disabled ? "none" : "static";
      btn.cursor = disabled ? "default" : "pointer";

      const bg = new Graphics();
      bg.roundRect(0, 0, CTRL_BTN_W, CTRL_BTN_H, 4);
      bg.fill({ color: disabled ? 0x14141c : BORDER });
      btn.addChild(bg);

      const text = new Text({
        text: label,
        style: {
          fontFamily: FONT,
          fontSize: label.length > 6 ? 7 : 8,
          fill: disabled ? MUTED_TEXT : TEXT_COLOR,
        },
        resolution: RESOLUTION,
      });
      text.anchor.set(0.5, 0.5);
      text.x = CTRL_BTN_W / 2;
      text.y = CTRL_BTN_H / 2;
      btn.addChild(text);

      if (!disabled) {
        btn.on("pointertap", (e) => {
          e.stopPropagation();
          onClick();
        });
      }

      return btn;
    }

    // -----------------------------------------------------------------------
    // layout
    // -----------------------------------------------------------------------

    const layout = (w: number, h: number) => {
      const items = ctx.doc.current.items;
      const completedCount = items.filter((i) => i.state === "completed").length;
      const liveCount = items.length - completedCount;

      drawCard(w, h);

      titleText.x = PADDING_X;
      titleText.y = PADDING_Y - 2;

      countText.text = liveCount > 0 ? `${liveCount} active` : "";
      countText.x = w - PADDING_X - countText.width;
      countText.y = PADDING_Y + 1;

      clearCompletedBtn.visible = completedCount > 0;
      if (clearCompletedBtn.visible) {
        clearCompletedBtn.x = countText.x - clearCompletedBtn.width - 12;
        clearCompletedBtn.y = PADDING_Y + 1;
      }

      headerDivider.clear();
      headerDivider.moveTo(PADDING_X, HEADER_HEIGHT);
      headerDivider.lineTo(w - PADDING_X, HEADER_HEIGHT);
      headerDivider.stroke({ color: BORDER, width: 1 });

      listAreaY = HEADER_HEIGHT + 6;
      listAreaHeight = Math.max(0, h - listAreaY - PADDING_Y);
      const contentW = Math.max(0, w - PADDING_X * 2);

      listContainer.x = PADDING_X;
      listContainer.y = listAreaY;
      // explicit hitArea (rather than relying on child bounds) so wheel/
      // pointer events register anywhere in the visible list box, even over
      // gaps between rows or an even row's undrawn background.
      listContainer.hitArea = new Rectangle(0, 0, contentW, listAreaHeight);

      listMask.clear();
      listMask.rect(PADDING_X, listAreaY, contentW, listAreaHeight);
      listMask.fill({ color: 0xffffff });

      renderRows(items, contentW);
      clampListScroll();
      listInner.y = -scrollY;

      emptyText.visible = items.length === 0;
      if (emptyText.visible) {
        emptyText.x = PADDING_X + (contentW - emptyText.width) / 2;
        emptyText.y = listAreaY + (listAreaHeight - emptyText.height) / 2;
      }
    };

    layout(currentWidth, currentHeight);

    const unsub = ctx.doc.on("change", () => layout(currentWidth, currentHeight));

    return {
      container,

      destroy() {
        destroyed = true;
        unsub();
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

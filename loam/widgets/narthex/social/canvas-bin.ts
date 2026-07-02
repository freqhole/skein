// ---------------------------------------------------------------------------
// canvas bin widget — recursive folder display for a peer's own curated
// profile canvases (docs/hub-and-profile-plan.md section 10.2).
//
// this is the *display* surface for `ProfileStore.canvases()` — the
// existing `profile-tab.ts` "my canvases" list stays as the *management*
// affordance (add current canvas / remove). this widget renders every
// curated canvas somewhere in a recursive tree of folders (backed by
// `CanvasBinStore`, canvas-bin-doc.ts) and lets the viewer file them into
// nested groups, closely mirroring `widgets/bin/index.ts`'s own
// grid/shelf/crate/drawer + nesting pattern — adapted to hold references to
// entirely separate top-level canvases (`ProfileCanvasEntry.canvasDocId`)
// instead of same-canvas `WidgetEntry`s.
//
// ## why this isn't a registered `WidgetFactory` (widgets/index.ts)
//
// like `social`/`messagez` (see boot.ts's `mountSocialOverlay`/
// `mountMessagesOverlay`), this widget is mounted directly by calling its
// `create()` function with a hand-built context — it's never placed via the
// palette/`CanvasStore.addWidget()`, so it has no reason to be in
// `createTestRegistry()`. unlike those two, it also isn't backed by
// `WidgetMountContext`'s generic `doc: WidgetDoc<S>` shape wired through a
// widget id in some *other* doc — its state lives in its own dedicated
// `CanvasBinStore` (a whole separate automerge doc, per-peer, never
// shared/synced to anyone), so its context type is its own, smaller shape
// rather than a strict `WidgetMountContext<S>`.
//
// ## click-to-navigate
//
// clicking a canvas card sets `window.location.hash = canvasDocId` — the
// exact same one-line mechanism `widgets/narthex/canvas-card.ts`'s
// `onCompactActivate` already uses. whatever happens next (open directly if
// already accessible, or fall back to the existing share-link/knock flow if
// not) is the app's existing hash-navigation pipeline
// (`SkeinRouter.onHashChange` -> `navigateToCanvas`, src/standalone/boot.ts)
// — deliberately not re-implemented or special-cased here, per the task's
// own instruction not to invent a new access-denied UI.
// ---------------------------------------------------------------------------

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { CanvasBinNode } from "../../../src/canvas/canvas-bin-doc";
import { CanvasBinStore, type CanvasBinMode } from "../../../src/canvas/canvas-bin-doc";
import type { ProfileStore } from "../../../src/canvas/profile-doc";
import {
  autoFitCols,
  computeRows,
  resolveScale,
  slotRect,
  type SlotSizeOptions,
} from "../../bin/bin-layout";
import { registerSocialBridge } from "../../../src/dev/test-bridge-registry";
import {
  ACCENT,
  BG,
  BORDER,
  FONT,
  MUTED_TEXT,
  RESOLUTION,
  SCROLL_SPEED,
  TEXT_COLOR,
} from "./constants";
import { truncate } from "./helpers";

/** the widget "type" identifier for this new narthex widget — kebab-case,
 *  same naming convention as `widgets/index.ts`'s registry (`"bin"`,
 *  `"canvas-card"`, `"audio-recording"`). not registered anywhere (see
 *  module doc comment above) — kept as a named export purely so tests/
 *  future code have one canonical string to refer to it by. */
export const PROFILE_CANVAS_BIN_WIDGET_TYPE = "profile-canvas-bin";

// -- layout constants --------------------------------------------------------

const HEADER_HEIGHT = 24;
const VIEWPORT_HEIGHT = 220;
const BIN_PADDING = 6;
const CARD_LABEL_SIZE = 9;
const HOLD_MS = 220;
const DRAG_THRESHOLD = 6;
const GHOST_ALPHA = 0.7;

export interface ProfileCanvasBinContext {
  /** the recursive folder tree backing this widget's display — see
   *  canvas-bin-doc.ts. */
  canvasBinStore: CanvasBinStore;
  /** the local peer's own curated canvas list — source of truth for
   *  title/description/color/preview per entry, and for which canvases
   *  exist at all (this widget never edits it, only reads/reconciles). */
  profileStore: ProfileStore;
  width: number;
  height: number;
}

export interface ProfileCanvasBinController {
  container: Container;
  layout(width: number): void;
  destroy(): void;
}

/** find the next available "new folder"/"new folder 2"/... name among
 *  `siblings` so repeated clicks don't collide. */
function nextFolderName(siblings: CanvasBinNode[]): string {
  const taken = new Set(
    siblings.filter((n): n is CanvasBinNode & { kind: "folder" } => n.kind === "folder").map((n) => n.title)
  );
  if (!taken.has("new folder")) return "new folder";
  let i = 2;
  while (taken.has(`new folder ${i}`)) i++;
  return `new folder ${i}`;
}

export function createProfileCanvasBinWidget(ctx: ProfileCanvasBinContext): ProfileCanvasBinController {
  const { canvasBinStore, profileStore } = ctx;

  const container = new Container();
  container.eventMode = "static";
  container.label = "profile-canvas-bin";

  let currentWidth = ctx.width;

  // path of folder ids from root down to the currently-viewed folder, with
  // titles cached for the breadcrumb (avoids a re-lookup if a folder gets
  // renamed/removed out from under an open breadcrumb — falls back to the
  // stored title regardless).
  let path: Array<{ id: string; title: string }> = [];

  const currentParentId = (): string | null => (path.length === 0 ? null : path[path.length - 1].id);

  // -- header: label / breadcrumb / add-folder ------------------------------

  const headerLabel = new Text({
    text: "canvas bin",
    style: { fontFamily: FONT, fontSize: 10, fill: MUTED_TEXT },
    resolution: RESOLUTION,
  });
  headerLabel.eventMode = "none";
  container.addChild(headerLabel);

  const backBtn = new Container();
  backBtn.eventMode = "static";
  backBtn.cursor = "pointer";
  backBtn.visible = false;
  const backLabel = new Text({
    text: "‹ back",
    style: { fontFamily: FONT, fontSize: 10, fill: ACCENT },
    resolution: RESOLUTION,
  });
  backLabel.eventMode = "none";
  backBtn.addChild(backLabel);
  container.addChild(backBtn);

  const addFolderBtn = new Container();
  addFolderBtn.eventMode = "static";
  addFolderBtn.cursor = "pointer";
  const addFolderLabel = new Text({
    text: "+ folder",
    style: { fontFamily: FONT, fontSize: 10, fill: ACCENT },
    resolution: RESOLUTION,
  });
  addFolderLabel.eventMode = "none";
  addFolderBtn.addChild(addFolderLabel);
  container.addChild(addFolderBtn);

  backBtn.on("pointertap", (e) => {
    e.stopPropagation();
    path = path.slice(0, -1);
    render();
  });

  addFolderBtn.on("pointertap", (e) => {
    e.stopPropagation();
    const siblings = canvasBinStore.getChildren(currentParentId());
    canvasBinStore.addFolder(nextFolderName(siblings), currentParentId());
    render();
  });

  // -- scrollable content area -----------------------------------------------

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
    text: "no canvases here yet",
    style: { fontFamily: FONT, fontSize: 10, fill: MUTED_TEXT },
    resolution: RESOLUTION,
  });
  emptyText.eventMode = "none";
  emptyText.visible = false;
  container.addChild(emptyText);

  let scrollY = 0;
  let listAreaHeight = 0;
  let totalListHeight = 0;

  const clampScroll = () => {
    const maxScroll = Math.max(0, totalListHeight - listAreaHeight);
    scrollY = Math.max(0, Math.min(scrollY, maxScroll));
  };

  listContainer.on("wheel", (e: WheelEvent) => {
    const canScroll = totalListHeight > listAreaHeight;
    if (!canScroll) return;
    e.stopPropagation();
    if ((e as any).nativeEvent) (e as any).nativeEvent._skeinWidgetScroll = true;
    scrollY += e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED;
    clampScroll();
    listInner.y = -scrollY;
  });

  // -- drag-to-move state ----------------------------------------------------
  // a card can be tapped (open folder / navigate to canvas) or held-and-
  // dragged onto another folder card (or the back button, to move up one
  // level) to file it there. mirrors friends-tab.ts's own hold+threshold
  // drag-vs-tap distinction, simplified (no groups/multi-drop-zone bar).

  interface DragState {
    nodeId: string;
    startX: number;
    startY: number;
    holdTimer: ReturnType<typeof setTimeout> | null;
    isDragging: boolean;
    ghost: Container | null;
  }
  let dragState: DragState | null = null;
  let hoveredDropFolderId: string | null | undefined = undefined; // undefined = none, null = "back" (root/parent)
  let cardBoundsByNodeId = new Map<string, { x: number; y: number; w: number; h: number; isFolder: boolean }>();

  function globalToLocal(e: any): { x: number; y: number } {
    const p = container.toLocal({ x: e.global?.x ?? 0, y: e.global?.y ?? 0 });
    return { x: p.x, y: p.y };
  }

  function startDrag(nodeId: string, e: any) {
    const local = globalToLocal(e);
    dragState = {
      nodeId,
      startX: local.x,
      startY: local.y,
      isDragging: false,
      holdTimer: setTimeout(() => {
        if (dragState) beginDragging();
      }, HOLD_MS),
      ghost: null,
    };
  }

  function beginDragging() {
    if (!dragState) return;
    dragState.isDragging = true;
    const node = canvasBinStore.findNode(dragState.nodeId);
    const label = node
      ? node.kind === "folder"
        ? node.title
        : (profileStore.canvases().find((c) => c.canvasDocId === node.canvasDocId)?.title ?? "canvas")
      : "item";
    const ghost = new Container();
    ghost.eventMode = "none";
    ghost.alpha = GHOST_ALPHA;
    const bg = new Graphics();
    bg.roundRect(0, 0, 90, 28, 4).fill({ color: ACCENT, alpha: 0.9 });
    ghost.addChild(bg);
    const t = new Text({
      text: truncate(label, 16),
      style: { fontFamily: FONT, fontSize: CARD_LABEL_SIZE, fill: 0xffffff },
      resolution: RESOLUTION,
    });
    t.x = 6;
    t.y = 8;
    ghost.addChild(t);
    container.addChild(ghost);
    dragState.ghost = ghost;
  }

  function updateDrag(e: any) {
    if (!dragState) return;
    const local = globalToLocal(e);
    if (!dragState.isDragging) {
      const dx = local.x - dragState.startX;
      const dy = local.y - dragState.startY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) beginDragging();
      else return;
    }
    if (dragState.ghost) {
      dragState.ghost.x = local.x + 8;
      dragState.ghost.y = local.y + 8;
    }

    // hit-test against back button and folder cards for drop highlighting
    hoveredDropFolderId = undefined;
    if (backBtn.visible) {
      const b = backBtn.getBounds();
      const bl = container.toLocal({ x: b.x, y: b.y });
      if (
        local.x >= bl.x &&
        local.x <= bl.x + b.width &&
        local.y >= bl.y &&
        local.y <= bl.y + b.height
      ) {
        hoveredDropFolderId = null;
      }
    }
    if (hoveredDropFolderId === undefined) {
      for (const [nodeId, bounds] of cardBoundsByNodeId) {
        if (nodeId === dragState.nodeId) continue;
        if (!bounds.isFolder) continue;
        if (
          local.x >= bounds.x &&
          local.x <= bounds.x + bounds.w &&
          local.y >= bounds.y &&
          local.y <= bounds.y + bounds.h
        ) {
          hoveredDropFolderId = nodeId;
          break;
        }
      }
    }
  }

  function endDrag() {
    if (!dragState) return;
    if (dragState.holdTimer) clearTimeout(dragState.holdTimer);
    const wasDragging = dragState.isDragging;
    const nodeId = dragState.nodeId;
    if (dragState.ghost) {
      container.removeChild(dragState.ghost);
      dragState.ghost.destroy({ children: true });
    }
    const dropTarget = hoveredDropFolderId;
    dragState = null;
    hoveredDropFolderId = undefined;

    if (wasDragging && dropTarget !== undefined) {
      canvasBinStore.moveNode(nodeId, dropTarget);
      render();
    } else if (!wasDragging) {
      activateNode(nodeId);
    }
  }

  container.on("globalpointermove", (e) => updateDrag(e));
  container.on("pointerup", () => endDrag());
  container.on("pointerupoutside", () => endDrag());

  function activateNode(nodeId: string) {
    const node = canvasBinStore.findNode(nodeId);
    if (!node) return;
    if (node.kind === "folder") {
      path = [...path, { id: node.id, title: node.title }];
      render();
    } else {
      // click-to-navigate — see module doc comment for why this mirrors
      // canvas-card.ts's onCompactActivate exactly rather than adding new
      // access-check logic here.
      window.location.hash = node.canvasDocId;
    }
  }

  // -- rendering ---------------------------------------------------------------

  function drawCard(
    g: Graphics,
    w: number,
    h: number,
    isFolder: boolean,
    color: number | undefined,
    isDropHover: boolean
  ) {
    g.clear();
    if (isFolder) {
      g.roundRect(0, 0, w, h, 4).fill({ color: BG }).stroke({
        width: isDropHover ? 2 : 1,
        color: isDropHover ? ACCENT : BORDER,
        alpha: isDropHover ? 1 : 0.8,
      });
      // simple folder glyph — a small tab + body
      g.roundRect(4, 4, w * 0.4, 5, 1).fill({ color: MUTED_TEXT, alpha: 0.6 });
      g.roundRect(4, 9, w - 8, h - 20, 2).stroke({ color: MUTED_TEXT, width: 1, alpha: 0.5 });
    } else {
      g.roundRect(0, 0, w, h, 4).fill({ color: color ?? MUTED_TEXT }).stroke({
        width: isDropHover ? 2 : 1,
        color: isDropHover ? ACCENT : 0x000000,
        alpha: isDropHover ? 1 : 0.25,
      });
    }
  }

  function render() {
    // reconcile the tree against the live profile before every render so a
    // canvas added/removed elsewhere (e.g. profile-tab.ts's own list, or a
    // remote device sync) always shows up / disappears here too.
    canvasBinStore.reconcileWithProfile(profileStore.canvases());

    const nodes = canvasBinStore.getChildren(currentParentId());
    const mode = canvasBinStore.mode() as CanvasBinMode;
    const scaleOptions: SlotSizeOptions = { scale: resolveScale(canvasBinStore.slotScale()) };

    backBtn.visible = path.length > 0;
    headerLabel.text = path.length > 0 ? path[path.length - 1].title : "canvas bin";

    while (listInner.children.length > 0) {
      listInner.removeChildAt(0).destroy({ children: true });
    }
    cardBoundsByNodeId = new Map();

    emptyText.visible = nodes.length === 0;

    const contentWidth = currentWidth - BIN_PADDING * 2;
    const cols = autoFitCols(mode, contentWidth, scaleOptions);
    const rows = computeRows(nodes.length, cols);
    const canvasEntries = profileStore.canvases();

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const rect = slotRect(mode, { col: i % cols, row: Math.floor(i / cols) }, contentWidth, scaleOptions);

      const cardContainer = new Container();
      cardContainer.eventMode = "static";
      cardContainer.cursor = "pointer";
      cardContainer.x = rect.x;
      cardContainer.y = rect.y;
      cardContainer.hitArea = new Rectangle(0, 0, rect.width, rect.height);
      listInner.addChild(cardContainer);

      const isFolder = node.kind === "folder";
      const entry = node.kind === "canvas" ? canvasEntries.find((c) => c.canvasDocId === node.canvasDocId) : undefined;

      const g = new Graphics();
      cardContainer.addChild(g);

      const isDropHover = dragState?.isDragging === true && hoveredDropFolderId === node.id;
      drawCard(g, rect.width, rect.height, isFolder, entry?.color, isDropHover);

      const labelText = isFolder ? node.title : entry?.title ?? "untitled canvas";
      const maxChars = Math.max(4, Math.floor(rect.width / 6));
      const label = new Text({
        text: truncate(labelText, maxChars),
        style: {
          fontFamily: FONT,
          fontSize: CARD_LABEL_SIZE,
          fill: isFolder ? TEXT_COLOR : 0xffffff,
          wordWrap: true,
          wordWrapWidth: rect.width - 6,
        },
        resolution: RESOLUTION,
      });
      label.x = 3;
      label.y = rect.height - label.height - 3;
      cardContainer.addChild(label);

      cardContainer.on("pointerdown", (e) => {
        e.stopPropagation();
        startDrag(node.id, e);
      });

      cardBoundsByNodeId.set(node.id, {
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        isFolder,
      });
    }

    totalListHeight = mode === "drawer" ? rows * (rect_height_for_drawer()) : contentDimsHeight(mode, rows, cols, contentWidth, scaleOptions);
    layoutHeader();
  }

  function rect_height_for_drawer(): number {
    return slotRect("drawer", { col: 0, row: 0 }, currentWidth - BIN_PADDING * 2, {
      scale: resolveScale(canvasBinStore.slotScale()),
    }).height;
  }

  function contentDimsHeight(
    mode: CanvasBinMode,
    rows: number,
    _cols: number,
    contentWidth: number,
    options: SlotSizeOptions
  ): number {
    if (rows === 0) return 0;
    const last = slotRect(mode, { col: 0, row: rows - 1 }, contentWidth, options);
    return last.y + last.height;
  }

  function layoutHeader() {
    headerLabel.x = 0;
    headerLabel.y = 0;

    addFolderBtn.x = currentWidth - addFolderLabel.width;
    addFolderBtn.y = 0;
    addFolderBtn.hitArea = new Rectangle(-4, -4, addFolderLabel.width + 8, addFolderLabel.height + 8);

    backBtn.x = 0;
    backBtn.y = HEADER_HEIGHT - 14;
    backBtn.hitArea = new Rectangle(-4, -4, backLabel.width + 8, backLabel.height + 8);

    const listTop = backBtn.visible ? HEADER_HEIGHT + 4 : HEADER_HEIGHT - 6;
    listContainer.x = BIN_PADDING;
    listContainer.y = listTop;

    listAreaHeight = Math.max(0, VIEWPORT_HEIGHT - listTop);
    clampScroll();
    listInner.y = -scrollY;

    listMask.clear();
    listMask.rect(listContainer.x, listContainer.y, currentWidth - BIN_PADDING * 2, listAreaHeight).fill({
      color: 0xffffff,
    });

    emptyText.x = BIN_PADDING;
    emptyText.y = listTop + 4;
  }

  // -- profile/tree change subscriptions ---------------------------------------

  const profileUnsub = profileStore.onChange(() => render());
  const binUnsub = canvasBinStore.onChange(() => render());

  // -- test hooks ---------------------------------------------------------------
  // see src/dev/test-bridge.ts's ProfileCanvasBinTestHooks — mirrors the
  // established "call the widget's real internal handlers directly, since
  // this repo has no infra for simulated pixi pointer drags" precedent
  // (profile-tab.ts's pickAvatar, friends-tab.ts's FriendsTabTestHooks).
  registerSocialBridge({
    canvasBin: {
      getVisibleNodes: () => canvasBinStore.getChildren(currentParentId()),
      getCurrentFolderId: () => currentParentId(),
      enterFolder: (folderId: string) => activateNode(folderId),
      goBack: () => {
        path = path.slice(0, -1);
        render();
      },
      addFolder: (title: string) => {
        const id = canvasBinStore.addFolder(title, currentParentId());
        render();
        return id;
      },
      moveNode: (nodeId: string, newParentId: string | null) => {
        const moved = canvasBinStore.moveNode(nodeId, newParentId);
        render();
        return moved;
      },
      activateNode: (nodeId: string) => activateNode(nodeId),
    },
  });

  render();

  return {
    container,
    layout(width: number) {
      currentWidth = width;
      render();
    },
    destroy() {
      profileUnsub();
      binUnsub();
      if (dragState?.holdTimer) clearTimeout(dragState.holdTimer);
      container.destroy({ children: true });
    },
  };
}

export { VIEWPORT_HEIGHT as PROFILE_CANVAS_BIN_HEIGHT };

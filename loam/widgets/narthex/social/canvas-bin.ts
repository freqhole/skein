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

import { Assets, Container, Graphics, Rectangle, Sprite, Text, type Texture } from "pixi.js";
import type { CanvasBinNode } from "../../../src/canvas/canvas-bin-doc";
import { CanvasBinStore, type CanvasBinMode } from "../../../src/canvas/canvas-bin-doc";
import type { ProfileStore } from "../../../src/canvas/profile-doc";
import {
  computePageSize,
  slotRect,
  type SlotSizeOptions,
} from "../../bin/bin-layout";
import { registerSocialBridge } from "../../../src/dev/test-bridge-registry";
import type { ProfileCanvasBinTestHooks } from "../../../src/dev/test-bridge";
import {
  ACCENT,
  BG,
  BORDER,
  FONT,
  MUTED_TEXT,
  RESOLUTION,
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
const PAGER_HEIGHT = 20;
const BIN_PADDING = 6;
const CARD_LABEL_SIZE = 12;
const CARD_DESCRIPTION_SIZE = 10;
const CARD_LABEL_LINE_GAP = 4;
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
  /** render in read-only mode: no drag-to-move, no "+ folder" button — only
   *  navigate-into-folder and open-canvas stay active. used for viewing a
   *  FRIEND's bin (friends-tab.ts's friend-detail view) — the owner's own
   *  embed (profile-tab.ts) omits this (defaults to `false`, fully
   *  editable). */
  isReadOnly?: boolean;
  /**
   * override how this instance's test hooks get exposed. defaults to
   * `registerSocialBridge({ canvasBin: hooks })` — the owner's own
   * profile-tab embed, which is a permanent per-session singleton. any
   * OTHER concurrent mount of this widget (a friend's read-only bin in
   * friends-tab.ts) must supply its own registration target here, or it
   * would silently clobber the owner's own hooks under the same
   * `window.__skeinTest.social.canvasBin` key.
   */
  registerTestHooks?: (hooks: ProfileCanvasBinTestHooks) => void;
}

export interface ProfileCanvasBinController {
  container: Container;
  layout(width: number, height?: number): void;
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
  const { canvasBinStore, profileStore, isReadOnly = false } = ctx;

  const container = new Container();
  container.eventMode = "static";
  container.label = "profile-canvas-bin";

  let currentWidth = ctx.width;
  let viewportHeight = ctx.height > 0 ? ctx.height : VIEWPORT_HEIGHT;

  // real prev/next pagination (not scroll — see module doc comment and
  // ProfileCanvasBinContext's doc comment). reset to 0 whenever the
  // currently-viewed folder changes; clamped into range on every render()
  // in case the item count shrinks (e.g. a canvas removed elsewhere).
  let page = 0;
  let lastTotalPages = 1;

  // bumped on every render() — guards the async preview-thumbnail loads
  // below (see the per-card loop) against adding a Sprite to a card
  // container that a LATER render() has already destroyed (render() fully
  // tears down and rebuilds listInner's children every call).
  let renderGeneration = 0;

  // node ids (not canvasDocIds — folders never have previews) whose
  // preview-image Sprite has actually finished loading and attached, as of
  // the current render generation. reset at the start of every render(),
  // populated by loadEndcapPreview() on success — exposed via
  // `getLoadedPreviewNodeIds()` below so tests (and live debugging) can
  // prove an image genuinely rendered, not just that `entry.previewUrl`
  // was non-empty.
  let loadedPreviewNodeIds = new Set<string>();

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
  addFolderBtn.eventMode = isReadOnly ? "none" : "static";
  addFolderBtn.cursor = "pointer";
  addFolderBtn.visible = !isReadOnly;
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
    page = 0;
    render();
  });

  addFolderBtn.on("pointertap", (e) => {
    e.stopPropagation();
    if (isReadOnly) return;
    const siblings = canvasBinStore.getChildren(currentParentId());
    canvasBinStore.addFolder(nextFolderName(siblings), currentParentId());
    render();
  });

  // -- content area (paginated — real prev/next, not scroll) -----------------

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

  let listAreaHeight = 0;

  // -- pager: "‹ prev" / "page X of Y" / "next ›" ------------------------------
  // real page navigation (an explicit, deliberate design choice — see module
  // doc comment) rather than scrolling a taller list. shared by owner and
  // read-only modes alike; only shown when there's more than one page.

  const pagerContainer = new Container();
  pagerContainer.eventMode = "static";
  pagerContainer.visible = false;
  container.addChild(pagerContainer);

  const prevPageBtn = new Container();
  prevPageBtn.eventMode = "static";
  prevPageBtn.cursor = "pointer";
  const prevPageLabel = new Text({
    text: "‹ prev",
    style: { fontFamily: FONT, fontSize: 9, fill: ACCENT },
    resolution: RESOLUTION,
  });
  prevPageLabel.eventMode = "none";
  prevPageBtn.addChild(prevPageLabel);
  pagerContainer.addChild(prevPageBtn);

  const pageIndicator = new Text({
    text: "page 1 of 1",
    style: { fontFamily: FONT, fontSize: 9, fill: MUTED_TEXT },
    resolution: RESOLUTION,
  });
  pageIndicator.eventMode = "none";
  pagerContainer.addChild(pageIndicator);

  const nextPageBtn = new Container();
  nextPageBtn.eventMode = "static";
  nextPageBtn.cursor = "pointer";
  const nextPageLabel = new Text({
    text: "next ›",
    style: { fontFamily: FONT, fontSize: 9, fill: ACCENT },
    resolution: RESOLUTION,
  });
  nextPageLabel.eventMode = "none";
  nextPageBtn.addChild(nextPageLabel);
  pagerContainer.addChild(nextPageBtn);

  function goToPrevPage() {
    if (page <= 0) return;
    page -= 1;
    render();
  }

  function goToNextPage() {
    if (page >= lastTotalPages - 1) return;
    page += 1;
    render();
  }

  prevPageBtn.on("pointertap", (e) => {
    e.stopPropagation();
    goToPrevPage();
  });
  nextPageBtn.on("pointertap", (e) => {
    e.stopPropagation();
    goToNextPage();
  });

  // -- drag-to-move state ----------------------------------------------------
  // a card can be tapped (open folder / navigate to canvas) or held-and-
  // dragged onto another folder card (or the back button, to move up one
  // level) to file it there. mirrors friends-tab.ts's own hold+threshold
  // drag-vs-tap distinction, simplified (no groups/multi-drop-zone bar).
  // read-only mode skips this entirely — cards are wired for a plain tap
  // instead (see the card-creation loop in render()).


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
      page = 0;
      render();
    } else {
      // click-to-navigate — see module doc comment for why this mirrors
      // canvas-card.ts's onCompactActivate exactly rather than adding new
      // access-check logic here.
      window.location.hash = node.canvasDocId;
    }
  }

  // -- rendering ---------------------------------------------------------------

  /**
   * draw a full-width drawer row: a square "endcap" (folder glyph or color
   * swatch, matching the row's own height, flush left — same visual idiom
   * `widgets/bin/bin-card-builders.ts`'s `buildDrawerCard()` uses for its
   * own drawer rows) plus the row's background/border. the title label
   * itself is a separate `Text` positioned to the right of the endcap by
   * the caller (`render()`), not drawn here.
   */
  /**
   * draw a full-width drawer row: a square "endcap" (folder glyph or color
   * swatch, matching the row's own height, flush left — same visual idiom
   * `widgets/bin/bin-card-builders.ts`'s `buildDrawerCard()` uses for its
   * own drawer rows) plus the row's background/border. the title/
   * description labels and the endcap's preview-image sprite (when the
   * entry has one) are added separately by the caller (`render()`), not
   * drawn here.
   */
  function drawCard(
    g: Graphics,
    w: number,
    h: number,
    isFolder: boolean,
    color: number | undefined,
    isDropHover: boolean
  ) {
    g.clear();
    const rowColor = isFolder ? BG : (color ?? MUTED_TEXT);
    g.roundRect(0, 0, w, h, 4).fill({ color: rowColor, alpha: isFolder ? 1 : 0.18 }).stroke({
      width: isDropHover ? 2 : 1,
      color: isDropHover ? ACCENT : isFolder ? BORDER : 0x000000,
      alpha: isDropHover ? 1 : isFolder ? 0.8 : 0.25,
    });

    // square endcap, flush left, matching row height — the caller may
    // layer a preview-image Sprite on top of this once loaded (canvas
    // entries only; folders always just show the glyph).
    const endcap = h;
    if (isFolder) {
      // simple folder glyph — a small tab + body, centered in the endcap
      const gw = endcap * 0.5;
      const gx = (endcap - gw) / 2;
      g.roundRect(gx, endcap * 0.28, gw, 3, 1).fill({ color: MUTED_TEXT, alpha: 0.7 });
      g.roundRect(gx, endcap * 0.42, gw, endcap * 0.32, 2).stroke({
        color: MUTED_TEXT,
        width: 1,
        alpha: 0.6,
      });
    } else {
      // color swatch fill for the endcap — the base look, and the fallback
      // shown while (or if) a preview image fails to load.
      g.roundRect(1, 1, endcap - 2, h - 2, 3).fill({ color: color ?? MUTED_TEXT, alpha: 0.9 });
    }
  }

  /**
   * best-effort: load a canvas entry's preview image into the endcap area
   * of an already-drawn row, replacing the plain color swatch once it's
   * ready. guarded by `myGeneration` so a load that resolves after a LATER
   * render() has already torn this card down (render() fully rebuilds
   * listInner's children every call) never touches a destroyed container.
   *
   * NOTE: never call `Assets.unload()` for `dataUrl` — profile canvas
   * previews are `data:` URLs, which can be shared with other live
   * consumers of the same texture (a narthex canvas-card showing the same
   * canvas, the canvas-wizard's own preview field, etc). unloading it out
   * from under them crashes the renderer mid-frame — same class of bug
   * already root-caused and fixed the same way in
   * canvas-card.ts/file.ts/property-tray.ts/canvas-wizard.ts this session.
   */
  function loadEndcapPreview(
    nodeId: string,
    cardContainer: Container,
    dataUrl: string,
    endcap: number,
    rowHeight: number,
    myGeneration: number
  ): void {
    Assets.load<Texture>(dataUrl)
      .then((texture) => {
        if (myGeneration !== renderGeneration || cardContainer.destroyed) return;

        const sprite = new Sprite(texture);
        sprite.eventMode = "none";
        const scale = Math.max(endcap / texture.width, rowHeight / texture.height);
        sprite.width = texture.width * scale;
        sprite.height = texture.height * scale;
        sprite.x = (endcap - sprite.width) / 2;
        sprite.y = (rowHeight - sprite.height) / 2;

        const mask = new Graphics();
        mask.roundRect(1, 1, endcap - 2, rowHeight - 2, 3).fill({ color: 0xffffff });
        cardContainer.addChild(mask);
        sprite.mask = mask;
        cardContainer.addChild(sprite);
        loadedPreviewNodeIds.add(nodeId);
      })
      .catch(() => {
        // silently keep the color-swatch fallback already drawn.
      });
  }

  function render() {
    renderGeneration++;
    const myGeneration = renderGeneration;

    // reconcile the tree against the live profile before every render so a
    // canvas added/removed elsewhere (e.g. profile-tab.ts's own list, or a
    // remote device sync) always shows up / disappears here too.
    canvasBinStore.reconcileWithProfile(profileStore.canvases());

    const nodes = canvasBinStore.getChildren(currentParentId());
    // always render as a vertical drawer (full-width rows), paginated —
    // not a user-toggleable mode like the general bin/ widget's own
    // grid/shelf/crate/drawer picker. `slotRect`/`computePageSize`
    // (bin-layout.ts) already handle "drawer" generically (1 column,
    // full content width per row), so this needs no other rendering
    // changes — just fixing which mode this specific widget always uses.
    // `CanvasBinStore.mode()`/`setMode()` still exist (canvas-bin-doc.ts)
    // for potential future use, but nothing in this widget reads/exposes
    // them anymore.
    const mode: CanvasBinMode = "drawer";
    // fixed, larger-than-default row scale (not `canvasBinStore.slotScale()`
    // — that setting has no UI for this widget either, same reasoning as
    // hardcoding `mode` above) so a row has room for a legible title AND
    // description line plus a preview-image endcap, rather than the
    // general bin/ widget's compact single-line drawer rows.
    const scaleOptions: SlotSizeOptions = { scale: 2.0 };

    backBtn.visible = path.length > 0;
    headerLabel.text = path.length > 0 ? path[path.length - 1].title : "canvas bin";

    while (listInner.children.length > 0) {
      listInner.removeChildAt(0).destroy({ children: true });
    }
    cardBoundsByNodeId = new Map();
    loadedPreviewNodeIds = new Set();

    emptyText.visible = nodes.length === 0;

    const contentWidth = currentWidth - BIN_PADDING * 2;
    const listTop = backBtn.visible ? HEADER_HEIGHT + 4 : HEADER_HEIGHT - 6;
    listAreaHeight = Math.max(0, viewportHeight - listTop - PAGER_HEIGHT);

    const pageSize = computePageSize(mode, contentWidth, listAreaHeight, scaleOptions);
    const cols = pageSize.cols;
    const itemsPerPage = Math.max(1, pageSize.itemsPerPage);
    lastTotalPages = Math.max(1, Math.ceil(nodes.length / itemsPerPage));
    page = Math.min(Math.max(0, page), lastTotalPages - 1);

    pagerContainer.visible = lastTotalPages > 1;
    pageIndicator.text = `page ${page + 1} of ${lastTotalPages}`;
    prevPageBtn.eventMode = page > 0 ? "static" : "none";
    prevPageBtn.alpha = page > 0 ? 1 : 0.4;
    nextPageBtn.eventMode = page < lastTotalPages - 1 ? "static" : "none";
    nextPageBtn.alpha = page < lastTotalPages - 1 ? 1 : 0.4;

    const pageStart = page * itemsPerPage;
    const pageNodes = nodes.slice(pageStart, pageStart + itemsPerPage);
    const canvasEntries = profileStore.canvases();

    for (let i = 0; i < pageNodes.length; i++) {
      const node = pageNodes[i];
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

      const endcap = rect.height;
      if (!isFolder && entry?.previewUrl) {
        loadEndcapPreview(node.id, cardContainer, entry.previewUrl, endcap, rect.height, myGeneration);
      }

      // title + (optional) description sit to the right of the square
      // endcap. title is vertically centered when there's no description;
      // otherwise both lines are stacked and centered as a pair.
      const titleText = isFolder ? node.title : entry?.title ?? "untitled canvas";
      const descriptionText = !isFolder ? entry?.description?.trim() : undefined;
      const labelX = endcap + 6;
      const labelMaxWidth = Math.max(10, rect.width - labelX - 4);
      const titleMaxChars = Math.max(4, Math.floor(labelMaxWidth / 7.5));
      const descriptionMaxChars = Math.max(4, Math.floor(labelMaxWidth / 6.5));

      const title = new Text({
        text: truncate(titleText, titleMaxChars),
        style: {
          fontFamily: FONT,
          fontSize: CARD_LABEL_SIZE,
          fill: isFolder ? TEXT_COLOR : 0xffffff,
        },
        resolution: RESOLUTION,
      });
      title.x = labelX;

      if (descriptionText) {
        const description = new Text({
          text: truncate(descriptionText, descriptionMaxChars),
          style: {
            fontFamily: FONT,
            fontSize: CARD_DESCRIPTION_SIZE,
            fill: MUTED_TEXT,
          },
          resolution: RESOLUTION,
        });
        description.x = labelX;
        const pairHeight = title.height + CARD_LABEL_LINE_GAP + description.height;
        title.y = (rect.height - pairHeight) / 2;
        description.y = title.y + title.height + CARD_LABEL_LINE_GAP;
        cardContainer.addChild(description);
      } else {
        title.y = (rect.height - title.height) / 2;
      }
      cardContainer.addChild(title);

      if (isReadOnly) {
        // no drag-to-move in read-only mode — a plain tap navigates
        // straight through (see module doc comment on click-to-navigate).
        cardContainer.on("pointertap", (e) => {
          e.stopPropagation();
          activateNode(node.id);
        });
      } else {
        cardContainer.on("pointerdown", (e) => {
          e.stopPropagation();
          startDrag(node.id, e);
        });
      }

      cardBoundsByNodeId.set(node.id, {
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        isFolder,
      });
    }

    layoutHeader();
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
    listInner.y = 0;

    listMask.clear();
    listMask.rect(listContainer.x, listContainer.y, currentWidth - BIN_PADDING * 2, listAreaHeight).fill({
      color: 0xffffff,
    });

    emptyText.x = BIN_PADDING;
    emptyText.y = listTop + 4;

    // pager row, anchored to the bottom of the widget's viewport — only
    // visible when there's more than one page (set in render()).
    const pagerY = viewportHeight - PAGER_HEIGHT + 4;

    prevPageBtn.x = 0;
    prevPageBtn.y = pagerY;
    prevPageBtn.hitArea = new Rectangle(-4, -4, prevPageLabel.width + 8, prevPageLabel.height + 8);

    pageIndicator.x = (currentWidth - pageIndicator.width) / 2;
    pageIndicator.y = pagerY;

    nextPageBtn.x = currentWidth - nextPageLabel.width;
    nextPageBtn.y = pagerY;
    nextPageBtn.hitArea = new Rectangle(-4, -4, nextPageLabel.width + 8, nextPageLabel.height + 8);
  }

  // -- profile/tree change subscriptions ---------------------------------------

  const profileUnsub = profileStore.onChange(() => render());
  const binUnsub = canvasBinStore.onChange(() => render());

  // -- test hooks ---------------------------------------------------------------
  // see ProfileCanvasBinTestHooks (dev/test-bridge.ts) / ProfileCanvasBinContext.registerTestHooks
  // for how this gets exposed for different concurrent mounts — mirrors the
  // established "call the widget's real internal handlers directly, since
  // this repo has no infra for simulated pixi pointer drags" precedent
  // (profile-tab.ts's pickAvatar, friends-tab.ts's FriendsTabTestHooks).
  const registerHooks = ctx.registerTestHooks ?? ((hooks) => registerSocialBridge({ canvasBin: hooks }));
  registerHooks({
    getVisibleNodes: () => canvasBinStore.getChildren(currentParentId()),
    getCurrentFolderId: () => currentParentId(),
    enterFolder: (folderId: string) => activateNode(folderId),
    goBack: () => {
      path = path.slice(0, -1);
      page = 0;
      render();
    },
    addFolder: (title: string) => {
      if (isReadOnly) return "";
      const id = canvasBinStore.addFolder(title, currentParentId());
      render();
      return id;
    },
    moveNode: (nodeId: string, newParentId: string | null) => {
      if (isReadOnly) return false;
      const moved = canvasBinStore.moveNode(nodeId, newParentId);
      render();
      return moved;
    },
    isReadOnly: () => isReadOnly,
    getCurrentPage: () => page,
    getTotalPages: () => lastTotalPages,
    nextPage: () => goToNextPage(),
    prevPage: () => goToPrevPage(),
    activateNode: (nodeId: string) => activateNode(nodeId),
    getLoadedPreviewNodeIds: () => [...loadedPreviewNodeIds],
  });

  render();

  return {
    container,
    layout(width: number, height?: number) {
      currentWidth = width;
      if (height !== undefined && height > 0) viewportHeight = height;
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


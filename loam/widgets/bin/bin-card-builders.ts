// card builder functions for the bin widget.
// extracted from BinRenderer to keep modules under ~300 lines.

import { Container, Graphics, Rectangle, Sprite, Text } from "pixi.js";
import { log } from "@freqhole/reliquary/utils";
import {
  checkBlobLocality,
  revealBlobInFinder,
  saveBlobToDisk,
  snatchBlob,
} from "../../src/widgets/file-utils";
import { isTauriMode } from "../../src/p2p/tauri-transport";
import { drawRevealIcon, drawSaveIcon } from "../../src/widgets/icons";
import { isTransparent, type CompactInfo } from "../../src/widgets/widget-types";
import {
  CRATE_FONT_SIZE,
  DEFAULT_ACCENT_COLOR,
  DRAWER_FONT_SIZE,
  GRID_LABEL_FONT_SIZE,
  GRID_LABEL_HEIGHT,
  GRID_LABEL_MAX_CHARS,
  SHELF_FONT_SIZE,
  SLOT_EMPTY_BG,
  TEXT_COLOR,
} from "./bin-constants";
import type { SlotSizeOptions } from "./bin-layout";
import { slotRect } from "./bin-layout";
import {
  createMediaOverlay,
  createPreviewOverlay,
  isMediaDomain,
  isPhotoDomain,
} from "./bin-media";
import type { CardBuildContext, CardRenderState, RenderedCard } from "./bin-types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

/** dispatch to the correct builder based on mode */
export function buildCard(state: CardRenderState, ctx: CardBuildContext): RenderedCard {
  switch (ctx.mode) {
    case "grid":
      return buildGridCard(state, ctx);
    case "shelf":
      return buildShelfCard(state, ctx);
    case "crate":
      return buildCrateCard(state, ctx);
    case "drawer":
      return buildDrawerCard(state, ctx);
  }
}

function truncateLabel(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label;
  return label.slice(0, maxChars - 1) + "\u2026";
}

// -----------------------------------------------------------------------
// action button helpers
// -----------------------------------------------------------------------

const ACTION_BTN_SIZE = 24;
const ACTION_BTN_BG = 0x2a2a2a;
const ACTION_BTN_HOVER_BG = 0x444444;

/**
 * create an icon button (snatch, save, or reveal) for a compact card.
 * the button fires a callback on pointerup and has hover highlighting
 * plus a tooltip label that appears above the button on hover.
 * all pointer events are stopped so they don't cascade to the card
 * (which would trigger audio/video playback or drag).
 */
function createActionButton(
  iconDraw: (g: Graphics, x: number, y: number, size: number, color: number, alpha: number) => void,
  size: number,
  tooltipText: string,
  onClick: () => void
): Container {
  const btn = new Container();
  btn.eventMode = "static";
  btn.cursor = "pointer";

  const bg = new Graphics();
  bg.roundRect(0, 0, size, size, 3).fill({ color: ACTION_BTN_BG, alpha: 0.8 });
  btn.addChild(bg);

  const iconPad = Math.max(2, Math.floor(size * 0.12));
  const icon = new Graphics();
  iconDraw(icon, iconPad, iconPad, size - iconPad * 2, 0xffffff, 0.85);
  btn.addChild(icon);

  // tooltip — small text label above the button, shown on hover
  const tipBg = new Graphics();
  tipBg.visible = false;
  tipBg.eventMode = "none";
  btn.addChild(tipBg);

  const tooltip = new Text({
    text: tooltipText,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: 9,
      fill: 0xffffff,
    },
    resolution: TEXT_RESOLUTION,
  });
  tooltip.anchor.set(0.5, 1);
  tooltip.x = size / 2;
  tooltip.y = -4;
  tooltip.visible = false;
  tooltip.eventMode = "none";
  btn.addChild(tooltip);

  btn.on("pointerenter", () => {
    bg.clear();
    bg.roundRect(0, 0, size, size, 3).fill({ color: ACTION_BTN_HOVER_BG, alpha: 0.95 });
    tooltip.visible = true;
    tipBg.visible = true;
    tipBg.clear();
    const tw = tooltip.width;
    const th = tooltip.height;
    tipBg
      .roundRect(size / 2 - tw / 2 - 4, -4 - th - 2, tw + 8, th + 4, 3)
      .fill({ color: 0x000000, alpha: 0.9 });
  });
  btn.on("pointerleave", () => {
    bg.clear();
    bg.roundRect(0, 0, size, size, 3).fill({ color: ACTION_BTN_BG, alpha: 0.8 });
    tooltip.visible = false;
    tipBg.visible = false;
  });

  // stop ALL pointer events from reaching the card — prevents triggering
  // audio/video playback, drag-and-drop, or card tap handlers
  btn.on("pointerdown", (e: any) => e.stopPropagation());
  btn.on("pointerup", (e: any) => {
    e.stopPropagation();
    onClick();
  });
  btn.on("pointertap", (e: any) => e.stopPropagation());

  return btn;
}

/** info needed to create file action buttons */
interface ActionButtonInfo {
  blobId?: string | null;
  filename?: string | null;
  mime?: string | null;
  blake3?: string | null;
  size?: number | null;
  domain?: string | null;
  snatchedBy?: string[] | null;
}

/**
 * build the set of action buttons for a file card.
 * returns a container with the buttons laid out horizontally.
 * returns null if no buttons are applicable (non-file card, no blobId).
 */
function buildActionButtons(
  info: ActionButtonInfo,
  btnSize: number,
  getPeers: (() => Record<string, { nodeId: string }> | undefined) | null
): Container | null {
  if (!info.blobId) return null;

  const row = new Container();
  row.label = "action-buttons";

  const isTauri = isTauriMode();
  const iconDraw = isTauri ? drawRevealIcon : drawSaveIcon;
  const tooltip = isTauri ? "reveal" : "save";

  const btn = createActionButton(iconDraw, btnSize, tooltip, () => {
    const blobId = String(info.blobId ?? "");
    const filename = String(info.filename ?? "file");

    void (async () => {
      try {
        // ensure the blob is local before saving/revealing
        const localityInfo = await checkBlobLocality(blobId, info.blake3 ?? undefined);
        if (localityInfo.locality !== "local") {
          const peers = getPeers?.() ?? {};
          await snatchBlob(
            {
              blobId,
              filename,
              mime: String(info.mime ?? ""),
              size: info.size ?? 0,
              blake3: String(info.blake3 ?? ""),
              domain: String(info.domain ?? ""),
            },
            peers as any
          );
        }

        if (isTauri) {
          await revealBlobInFinder(blobId);
        } else {
          await saveBlobToDisk(blobId, filename);
        }
      } catch (err) {
        log.warn("bin", "save/reveal failed:", err);
      }
    })();
  });
  btn.x = 0;
  row.addChild(btn);

  // hidden by default — shown on card hover
  row.visible = false;
  row.zIndex = 11;

  return row;
}

// -----------------------------------------------------------------------
// shelf autofit helper
// -----------------------------------------------------------------------

/**
 * find the largest font size that fits the text within the available length.
 * the text is single-line (no word wrap), so we only check width.
 * never goes below minSize and never above maxSize.
 */
function computeShelfFontSize(
  text: string,
  availableLength: number,
  minSize: number,
  maxSize: number
): { fontSize: number; fits: boolean } {
  if (availableLength <= 0) return { fontSize: minSize, fits: false };

  // start at max and shrink down
  let fontSize = maxSize;

  const measure = new Text({
    text,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize,
    },
    resolution: TEXT_RESOLUTION,
  });

  let fits = false;
  let iterations = 0;
  while (iterations < 15) {
    measure.style.fontSize = fontSize;
    const tw = measure.width;

    if (tw <= availableLength) {
      fits = true;
      break;
    }

    if (fontSize <= minSize) break;

    // shrink proportionally
    const scale = availableLength / Math.max(tw, 1);
    fontSize = Math.max(minSize, Math.floor(fontSize * scale * 0.95));
    iterations++;
  }

  measure.destroy();
  return { fontSize: Math.max(fontSize, minSize), fits };
}

/** helper to populate the common extra fields on RenderedCard from CompactInfo */
function extraCardFields(info: {
  label?: string;
  thumbnailUrl?: string;
  blobId?: string;
  mime?: string;
  filename?: string;
  blake3?: string;
  size?: number;
  snatchedBy?: string[];
}) {
  return {
    mediaLabel: info.label ?? null,
    thumbnailUrl: info.thumbnailUrl ?? null,
    filename: info.filename ?? null,
    blake3: info.blake3 ?? null,
    fileSize: info.size ?? null,
    snatchedBy: info.snatchedBy ?? null,
  };
}

// -----------------------------------------------------------------------
// solid label face / caption backdrop helpers
// -----------------------------------------------------------------------

/**
 * fill+stroke a card's fallback face (no thumbnail) using a widget's own
 * bg/border colors when its CompactInfo exposes them (e.g. the label
 * widget) — makes the card face read as a small mirror of the real widget
 * instead of a generic accent-tinted placeholder. -1 means transparent,
 * matching the widgets' own bg/border color convention.
 */
function drawSolidLabelFace(
  target: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  info: CompactInfo
): void {
  if (info.bgColor !== undefined && !isTransparent(info.bgColor)) {
    target.roundRect(x, y, w, h, radius).fill({ color: info.bgColor });
  }
  const borderWidth = info.borderWidth ?? 0;
  if (borderWidth > 0 && info.borderColor !== undefined && !isTransparent(info.borderColor)) {
    target.roundRect(x, y, w, h, radius).stroke({ color: info.borderColor, width: borderWidth });
  }
}

const LABEL_BACKDROP_COLOR = 0x000000;
const LABEL_BACKDROP_ALPHA = 0.55;
const LABEL_BACKDROP_PAD_X = 4;
const LABEL_BACKDROP_PAD_Y = 2;

/** base padding (px) between a grid cell's edge and its content */
const GRID_CONTENT_BASE_INSET = 4;

/**
 * draw a small semi-transparent backdrop rect behind a caption Text so it
 * stays legible over a thumbnail image. computed analytically from the
 * text's own anchor/rotation/position (rather than getBounds()) so it
 * works the same for grid/crate/drawer's unrotated captions and shelf's
 * ±90°-rotated caption — a ±90° rotation swaps which axis the text's
 * width/height occupy on screen.
 */
function addLabelBackdrop(parent: Container, label: Text, radius = 2): void {
  const rotated = Math.abs(Math.round((label.rotation * 2) / Math.PI)) % 2 === 1;
  const w = (rotated ? label.height : label.width) + LABEL_BACKDROP_PAD_X * 2;
  const h = (rotated ? label.width : label.height) + LABEL_BACKDROP_PAD_Y * 2;
  const x =
    label.x - label.anchor.x * (rotated ? label.height : label.width) - LABEL_BACKDROP_PAD_X;
  const y =
    label.y - label.anchor.y * (rotated ? label.width : label.height) - LABEL_BACKDROP_PAD_Y;
  const backdrop = new Graphics();
  backdrop
    .roundRect(x, y, w, h, radius)
    .fill({ color: LABEL_BACKDROP_COLOR, alpha: LABEL_BACKDROP_ALPHA });
  parent.addChild(backdrop);
}

// -----------------------------------------------------------------------
// grid mode
// -----------------------------------------------------------------------

/** grid mode: square thumbnail + label below */
function buildGridCard(state: CardRenderState, ctx: CardBuildContext): RenderedCard {
  const { info, slot, widgetId } = state;
  const rect = slotRect(ctx.mode, slot, ctx.contentWidth, {
    scale: ctx.scale,
    cellBorderWidth: ctx.cellBordersEnabled ? ctx.cellBorderWidth : 0,
  });

  const cellSize = rect.width;

  const card = new Container();
  card.label = `card-${widgetId}`;
  card.x = rect.x;
  card.y = rect.y;
  card.eventMode = "static";
  card.cursor = "pointer";
  card.sortableChildren = true;
  // cell size already accounts for the shared cell-border width (see
  // slotSize in bin-layout.ts) — so an explicit rect covering the whole
  // cell keeps the card reliably clickable/draggable even while the
  // thumbnail/fallback is still loading and no other content has drawn yet.
  card.hitArea = new Rectangle(0, 0, cellSize, cellSize);

  // everything (thumbnail/fallback, media overlay, action buttons) is
  // clipped to the cell bounds — a child widget's own border (e.g. a label
  // widget with a thick border) can otherwise render far outside its cell
  // and bleed into neighboring cells. no per-cell background/border is
  // drawn here; the shared cell-borders overlay (see BinRenderer) handles
  // the optional grid-line look instead.
  const cellContent = new Container();
  cellContent.label = "cell-content";
  card.addChild(cellContent);

  const cellMask = new Graphics();
  cellMask.rect(0, 0, cellSize, cellSize).fill({ color: 0xffffff });
  card.addChild(cellMask);
  cellContent.mask = cellMask;

  // thumbnail or fallback
  const thumbSprite: Sprite | null = null;
  let textureKey: string | null = null;

  if (info.thumbnailUrl && info.thumbnailUrl.length > 0) {
    textureKey = info.thumbnailUrl;

    ctx.loadCardTexture(info.thumbnailUrl).then((tex) => {
      if (!tex || !ctx.isAlive(widgetId)) return;

      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);

      // fit the sprite into the cell, center-cropped — the cellMask above
      // already clips to the cell bounds, so no separate per-sprite mask
      // is needed here
      const scale = Math.max(cellSize / tex.width, cellSize / tex.height);
      sprite.scale.set(scale);
      sprite.x = cellSize / 2;
      sprite.y = cellSize / 2;

      cellContent.addChild(sprite);

      // update the rendered card reference
      ctx.updateThumbSprite(widgetId, sprite);
    });
  } else {
    // fallback: mirrors the widget's own bg/border colors when exposed
    // (e.g. label widget), else a generic accent-tinted placeholder
    const fbInset = GRID_CONTENT_BASE_INSET;
    const fbSize = cellSize - fbInset * 2;
    const fallback = new Graphics();
    if (info.bgColor !== undefined) {
      drawSolidLabelFace(fallback, fbInset, fbInset, fbSize, fbSize, 3, info);
    } else {
      const accent = info.accentColor ?? DEFAULT_ACCENT_COLOR;
      fallback.roundRect(fbInset, fbInset, fbSize, fbSize, 3).fill({
        color: accent,
        alpha: 0.4,
      });
    }
    cellContent.addChild(fallback);

    // fill more of the cell than a plain fixed size — scales with the
    // available (inset-adjusted) fallback area
    const letterFontSize = Math.max(18, Math.round(fbSize * 0.65));
    const letter = info.label.charAt(0).toUpperCase() || "?";
    const letterText = new Text({
      text: letter,
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: letterFontSize,
        fill: info.textColor ?? TEXT_COLOR,
        align: "center",
      },
      resolution: TEXT_RESOLUTION,
    });
    letterText.anchor.set(0.5);
    letterText.x = cellSize / 2;
    letterText.y = cellSize / 2;
    cellContent.addChild(letterText);
  }

  // media overlay — play/pause icon for audio/video, expand icon for photos
  let mediaOverlay: Container | null = null;
  if (isMediaDomain(info.domain)) {
    const parts = createMediaOverlay(cellSize, cellSize);
    mediaOverlay = parts.overlay;
    cellContent.addChild(mediaOverlay);
  } else if (isPhotoDomain(info.domain)) {
    const parts = createPreviewOverlay(cellSize, cellSize);
    mediaOverlay = parts.overlay;
    cellContent.addChild(mediaOverlay);
  }

  // action buttons (snatch, save/reveal) — below thumbnail, hidden until hover
  if (info.blobId) {
    const btnSize = Math.max(18, Math.min(ACTION_BTN_SIZE, Math.floor(cellSize * 0.25)));
    const actions = buildActionButtons(info, btnSize, ctx.getPeers ?? null);
    if (actions) {
      actions.x = Math.round((cellSize - actions.width) / 2);
      actions.y = cellSize - btnSize - 2;
      cellContent.addChild(actions);
      card.on("pointerenter", () => {
        actions.visible = true;
      });
      card.on("pointerleave", () => {
        actions.visible = false;
      });
    }
  }

  // filename label below the cell — autofit the same way crate/shelf do:
  // try the largest font that fits the cell width (capped by the fixed
  // label row height), falling back to truncation at the minimum size.
  const gridMaxFont = Math.max(GRID_LABEL_FONT_SIZE, Math.floor(GRID_LABEL_HEIGHT * 0.7));
  const { fontSize: gridFontSize, fits: gridFits } = computeShelfFontSize(
    info.label,
    cellSize,
    GRID_LABEL_FONT_SIZE,
    gridMaxFont
  );
  let gridDisplayText: string;
  if (gridFits) {
    gridDisplayText = info.label;
  } else {
    const maxChars = Math.max(
      GRID_LABEL_MAX_CHARS,
      Math.floor(cellSize / (gridFontSize * 0.55))
    );
    gridDisplayText = truncateLabel(info.label, maxChars);
  }
  const label = new Text({
    text: gridDisplayText,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: gridFontSize,
      fill: TEXT_COLOR,
      align: "center",
    },
    resolution: TEXT_RESOLUTION,
  });
  label.anchor.set(0.5, 0);
  label.x = cellSize / 2;
  label.y = cellSize + 2;
  addLabelBackdrop(card, label);
  card.addChild(label);

  // pointer interactions
  ctx.attachPointerHandlers(card, widgetId);

  return {
    widgetId,
    slot,
    container: card,
    thumbSprite,
    textureKey,
    mediaOverlay,
    mediaDomain: info.domain ?? null,
    mediaBlobId: info.blobId ?? null,
    mediaMime: info.mime ?? null,
    ...extraCardFields(info),
  };
}

// -----------------------------------------------------------------------
// shelf mode
// -----------------------------------------------------------------------

/** shelf mode: narrow vertical spine with endcap thumbnail + rotated text */
function buildShelfCard(state: CardRenderState, ctx: CardBuildContext): RenderedCard {
  const { info, slot, widgetId } = state;
  const layoutOpts: SlotSizeOptions = {
    scale: ctx.scale,
    cellBorderWidth: ctx.cellBordersEnabled ? ctx.cellBorderWidth : 0,
  };
  const rect = slotRect(ctx.mode, slot, ctx.contentWidth, layoutOpts);
  const accent = info.accentColor ?? DEFAULT_ACCENT_COLOR;

  const spineW = rect.width;
  const spineH = rect.height;

  const card = new Container();
  card.label = `card-${widgetId}`;
  card.x = rect.x;
  card.y = rect.y;
  card.eventMode = "static";
  card.cursor = "pointer";
  card.sortableChildren = true;

  // all visual content is clipped to the spine's own bounds — a child
  // widget's own border/background (e.g. a label widget with a thick
  // border) can otherwise render past the spine and bleed into
  // neighboring slots. no per-card border stroke is drawn here; the
  // shared cell-borders overlay (see BinRenderer) handles the optional
  // grid-line look instead.
  const content = new Container();
  content.label = "card-content";
  card.addChild(content);

  const contentMask = new Graphics();
  contentMask.rect(0, 0, spineW, spineH).fill({ color: 0xffffff });
  card.addChild(contentMask);
  content.mask = contentMask;

  // spine background
  const bg = new Graphics();
  bg.roundRect(0, 0, spineW, spineH, 2).fill({ color: accent, alpha: 0.6 });
  content.addChild(bg);

  // endcap thumbnail at top of spine
  const thumbSprite: Sprite | null = null;
  let textureKey: string | null = null;
  const endcapH = spineW; // square, proportional to spine width

  if (info.thumbnailUrl && info.thumbnailUrl.length > 0) {
    textureKey = info.thumbnailUrl;

    // placeholder background for the endcap area
    const thumbBg = new Graphics();
    thumbBg.rect(0, 0, spineW, endcapH).fill({ color: accent, alpha: 0.3 });
    content.addChild(thumbBg);

    ctx.loadCardTexture(info.thumbnailUrl).then((tex) => {
      if (!tex || !ctx.isAlive(widgetId)) return;

      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      // fill-crop into endcap area (flush, no margin)
      const scale = Math.max(spineW / tex.width, endcapH / tex.height);
      sprite.scale.set(scale);
      sprite.x = spineW / 2;
      sprite.y = endcapH / 2;

      const mask = new Graphics();
      mask.rect(0, 0, spineW, endcapH).fill({ color: 0xffffff });
      content.addChild(mask);
      content.addChild(sprite);
      sprite.mask = mask;

      ctx.updateThumbSprite(widgetId, sprite);
    });
  } else {
    // fallback: mirrors the widget's own bg/border colors when exposed
    // (e.g. label widget), rendered over the endcap area
    if (info.bgColor !== undefined) {
      const face = new Graphics();
      drawSolidLabelFace(face, 0, 0, spineW, endcapH, 0, info);
      content.addChild(face);
    }
    const letter = info.label.charAt(0).toUpperCase() || "?";
    const letterText = new Text({
      text: letter,
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 14,
        fill: info.textColor ?? TEXT_COLOR,
        align: "center",
      },
      resolution: TEXT_RESOLUTION,
    });
    letterText.anchor.set(0.5);
    letterText.x = spineW / 2;
    letterText.y = endcapH / 2;
    content.addChild(letterText);
  }

  // rotated text — direction based on shelfTextOrigin
  // autofit: try to use the largest font that fits, but never below SHELF_FONT_SIZE
  const textAreaH = spineH - endcapH - 2;
  const maxFontSize = Math.floor(spineW * 0.8);
  const { fontSize: shelfFontSize, fits: textFits } = computeShelfFontSize(
    info.label,
    textAreaH,
    SHELF_FONT_SIZE,
    maxFontSize
  );

  // if autofit says the full text fits, use it; otherwise truncate at min size
  let displayText: string;
  if (textFits) {
    displayText = info.label;
  } else {
    const maxChars = Math.max(4, Math.floor(textAreaH / (shelfFontSize * 0.7)));
    displayText = truncateLabel(info.label, maxChars);
  }

  const label = new Text({
    text: displayText,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: shelfFontSize,
      fill: TEXT_COLOR,
    },
    resolution: TEXT_RESOLUTION,
  });

  // center anchor eliminates font-size-dependent positioning drift
  label.anchor.set(0.5, 0.5);
  label.rotation = ctx.shelfTextOrigin === "top" ? Math.PI / 2 : -Math.PI / 2;
  label.x = spineW / 2;
  label.y = endcapH + 1 + textAreaH / 2;
  addLabelBackdrop(content, label);
  content.addChild(label);

  // media overlay — play/pause icon for audio/video, expand icon for photos
  let mediaOverlay: Container | null = null;
  if (isMediaDomain(info.domain)) {
    const parts = createMediaOverlay(spineW, endcapH);
    mediaOverlay = parts.overlay;
    content.addChild(mediaOverlay);
  } else if (isPhotoDomain(info.domain)) {
    const parts = createPreviewOverlay(spineW, endcapH);
    mediaOverlay = parts.overlay;
    content.addChild(mediaOverlay);
  }

  ctx.attachPointerHandlers(card, widgetId);

  return {
    widgetId,
    slot,
    container: card,
    thumbSprite,
    textureKey,
    mediaOverlay,
    mediaDomain: info.domain ?? null,
    mediaBlobId: info.blobId ?? null,
    mediaMime: info.mime ?? null,
    ...extraCardFields(info),
  };
}

// -----------------------------------------------------------------------
// crate mode
// -----------------------------------------------------------------------

/** crate mode: horizontal row with flush-left endcap thumbnail + text */
function buildCrateCard(state: CardRenderState, ctx: CardBuildContext): RenderedCard {
  const { info, slot, widgetId } = state;
  const rect = slotRect(ctx.mode, slot, ctx.contentWidth, {
    scale: ctx.scale,
    cellBorderWidth: ctx.cellBordersEnabled ? ctx.cellBorderWidth : 0,
  });
  const accent = info.accentColor ?? DEFAULT_ACCENT_COLOR;

  const card = new Container();
  card.label = `card-${widgetId}`;
  card.x = rect.x;
  card.y = rect.y;
  card.eventMode = "static";
  card.cursor = "pointer";
  card.sortableChildren = true;

  const slotW = rect.width;
  const slotH = rect.height;

  // all visual content is clipped to the row's own bounds — a child
  // widget's own border/background can otherwise render past the row and
  // bleed into neighboring slots. no per-card border stroke is drawn
  // here; the shared cell-borders overlay (see BinRenderer) handles the
  // optional grid-line look instead.
  const content = new Container();
  content.label = "card-content";
  card.addChild(content);

  const contentMask = new Graphics();
  contentMask.rect(0, 0, slotW, slotH).fill({ color: 0xffffff });
  card.addChild(contentMask);
  content.mask = contentMask;

  // background
  const bg = new Graphics();
  bg.roundRect(0, 0, slotW, slotH, 2).fill({ color: SLOT_EMPTY_BG });
  content.addChild(bg);

  // endcap thumbnail — flush left, square matching row height
  const endcapW = slotH; // square, proportional to row height
  const thumbSprite: Sprite | null = null;
  let textureKey: string | null = null;

  // endcap placeholder
  const thumbBg = new Graphics();
  thumbBg.rect(0, 0, endcapW, slotH).fill({ color: accent, alpha: 0.6 });
  content.addChild(thumbBg);

  if (info.thumbnailUrl && info.thumbnailUrl.length > 0) {
    textureKey = info.thumbnailUrl;

    ctx.loadCardTexture(info.thumbnailUrl).then((tex) => {
      if (!tex || !ctx.isAlive(widgetId)) return;

      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      // fill-crop into endcap area
      const scale = Math.max(endcapW / tex.width, slotH / tex.height);
      sprite.scale.set(scale);
      sprite.x = endcapW / 2;
      sprite.y = slotH / 2;

      const mask = new Graphics();
      mask.rect(0, 0, endcapW, slotH).fill({ color: 0xffffff });
      content.addChild(mask);
      content.addChild(sprite);
      sprite.mask = mask;

      ctx.updateThumbSprite(widgetId, sprite);
    });
  } else {
    // fallback: mirrors the widget's own bg/border colors when exposed
    // (e.g. label widget), else the generic accent-tinted endcap placeholder
    if (info.bgColor !== undefined) {
      thumbBg.clear();
      drawSolidLabelFace(thumbBg, 0, 0, endcapW, slotH, 0, info);
    }

    const letter = info.label.charAt(0).toUpperCase() || "?";
    const letterText = new Text({
      text: letter,
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 14,
        fill: info.textColor ?? TEXT_COLOR,
      },
      resolution: TEXT_RESOLUTION,
    });
    letterText.anchor.set(0.5);
    letterText.x = endcapW / 2;
    letterText.y = slotH / 2;
    content.addChild(letterText);
  }

  // action buttons — at right end of row, hidden until hover
  let actionBtnsW = 0;
  if (info.blobId) {
    const btnSize = Math.max(16, Math.min(22, slotH - 4));
    const actions = buildActionButtons(info, btnSize, ctx.getPeers ?? null);
    if (actions) {
      actionBtnsW = actions.width + 6;
      actions.x = slotW - actions.width - 4;
      actions.y = Math.round((slotH - btnSize) / 2);
      content.addChild(actions);
      card.on("pointerenter", () => {
        actions.visible = true;
      });
      card.on("pointerleave", () => {
        actions.visible = false;
      });
    }
  }

  // filename text — to the right of the endcap
  const textX = endcapW + 6;
  const maxLabelWidth = slotW - textX - 4 - actionBtnsW;
  const crateMaxFont = Math.max(CRATE_FONT_SIZE, Math.floor(slotH * 0.55));
  const { fontSize: crateFontSize, fits: crateFits } = computeShelfFontSize(
    info.label,
    maxLabelWidth,
    CRATE_FONT_SIZE,
    crateMaxFont
  );
  let crateDisplayText: string;
  if (crateFits) {
    crateDisplayText = info.label;
  } else {
    const maxChars = Math.max(6, Math.floor(maxLabelWidth / (crateFontSize * 0.55)));
    crateDisplayText = truncateLabel(info.label, maxChars);
  }
  const label = new Text({
    text: crateDisplayText,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: crateFontSize,
      fill: TEXT_COLOR,
    },
    resolution: TEXT_RESOLUTION,
  });
  label.x = textX;
  label.y = (slotH - label.height) / 2;
  addLabelBackdrop(content, label);
  content.addChild(label);

  // media overlay — play/pause icon for audio/video, expand icon for photos
  let mediaOverlay: Container | null = null;
  if (isMediaDomain(info.domain)) {
    const parts = createMediaOverlay(endcapW, slotH);
    mediaOverlay = parts.overlay;
    content.addChild(mediaOverlay);
  } else if (isPhotoDomain(info.domain)) {
    const parts = createPreviewOverlay(endcapW, slotH);
    mediaOverlay = parts.overlay;
    content.addChild(mediaOverlay);
  }

  ctx.attachPointerHandlers(card, widgetId);

  return {
    widgetId,
    slot,
    container: card,
    thumbSprite,
    textureKey,
    mediaOverlay,
    mediaDomain: info.domain ?? null,
    mediaBlobId: info.blobId ?? null,
    mediaMime: info.mime ?? null,
    ...extraCardFields(info),
  };
}

// -----------------------------------------------------------------------
// drawer mode
// -----------------------------------------------------------------------

/** drawer mode: full-width horizontal rows with flush-left endcap + text */
function buildDrawerCard(state: CardRenderState, ctx: CardBuildContext): RenderedCard {
  const { info, slot, widgetId } = state;
  const rect = slotRect(ctx.mode, slot, ctx.contentWidth, {
    scale: ctx.scale,
    cellBorderWidth: ctx.cellBordersEnabled ? ctx.cellBorderWidth : 0,
  });
  const accent = info.accentColor ?? DEFAULT_ACCENT_COLOR;

  const container = new Container();
  container.label = `card-${widgetId}`;
  container.x = rect.x;
  container.y = rect.y;
  container.eventMode = "static";
  container.cursor = "pointer";
  container.sortableChildren = true;

  const slotW = rect.width;
  const slotH = rect.height;

  // all visual content is clipped to the row's own bounds — a child
  // widget's own border/background can otherwise render past the row and
  // bleed into neighboring rows. no per-card border stroke is drawn here;
  // the shared cell-borders overlay (see BinRenderer) handles the
  // optional grid-line look instead.
  const content = new Container();
  content.label = "card-content";
  container.addChild(content);

  const contentMask = new Graphics();
  contentMask.rect(0, 0, slotW, slotH).fill({ color: 0xffffff });
  container.addChild(contentMask);
  content.mask = contentMask;

  // background
  const bg = new Graphics();
  bg.roundRect(0, 0, slotW, slotH, 3).fill({ color: accent, alpha: 0.15 });
  content.addChild(bg);

  // endcap thumbnail — flush left, square matching row height
  const endcapW = slotH; // square, proportional to row height
  const thumbSprite: Sprite | null = null;
  let textureKey: string | null = null;

  // endcap placeholder
  const thumbBg = new Graphics();
  thumbBg.rect(0, 0, endcapW, slotH).fill({ color: accent, alpha: 0.3 });
  content.addChild(thumbBg);

  if (info.thumbnailUrl && info.thumbnailUrl.length > 0) {
    textureKey = info.thumbnailUrl;

    ctx.loadCardTexture(info.thumbnailUrl).then((tex) => {
      if (!tex || !ctx.isAlive(widgetId)) return;

      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      // fill-crop into endcap area
      const scale = Math.max(endcapW / tex.width, slotH / tex.height);
      sprite.scale.set(scale);
      sprite.x = endcapW / 2;
      sprite.y = slotH / 2;

      const mask = new Graphics();
      mask.rect(0, 0, endcapW, slotH).fill({ color: 0xffffff });
      content.addChild(mask);
      sprite.mask = mask;
      content.addChild(sprite);

      ctx.updateThumbSprite(widgetId, sprite);
    });
  } else {
    // fallback: mirrors the widget's own bg/border colors when exposed
    // (e.g. label widget), else the generic accent-tinted endcap placeholder
    if (info.bgColor !== undefined) {
      thumbBg.clear();
      drawSolidLabelFace(thumbBg, 0, 0, endcapW, slotH, 0, info);
    }

    const letter = info.label.charAt(0).toUpperCase() || "?";
    const letterText = new Text({
      text: letter,
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 16,
        fill: info.textColor ?? TEXT_COLOR,
      },
      resolution: TEXT_RESOLUTION,
    });
    letterText.anchor.set(0.5);
    letterText.x = endcapW / 2;
    letterText.y = slotH / 2;
    content.addChild(letterText);
  }

  // action buttons — at right end of row, hidden until hover
  let drawerActionBtnsW = 0;
  if (info.blobId) {
    const btnSize = Math.max(18, Math.min(ACTION_BTN_SIZE, slotH - 6));
    const actions = buildActionButtons(info, btnSize, ctx.getPeers ?? null);
    if (actions) {
      drawerActionBtnsW = actions.width + 8;
      actions.x = slotW - actions.width - 6;
      actions.y = Math.round((slotH - btnSize) / 2);
      content.addChild(actions);
      container.on("pointerenter", () => {
        actions.visible = true;
      });
      container.on("pointerleave", () => {
        actions.visible = false;
      });
    }
  }

  // text label — to the right of the endcap
  const textX = endcapW + 8;
  const maxLabelWidth = slotW - textX - 8 - drawerActionBtnsW;
  const drawerMaxFont = Math.max(DRAWER_FONT_SIZE, Math.floor(slotH * 0.5));
  const { fontSize: drawerFontSize, fits: drawerFits } = computeShelfFontSize(
    info.label,
    maxLabelWidth,
    DRAWER_FONT_SIZE,
    drawerMaxFont
  );
  let drawerDisplayText: string;
  if (drawerFits) {
    drawerDisplayText = info.label;
  } else {
    const maxChars = Math.max(8, Math.floor(maxLabelWidth / (drawerFontSize * 0.55)));
    drawerDisplayText = truncateLabel(info.label, maxChars);
  }
  const label = new Text({
    text: drawerDisplayText,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: drawerFontSize,
      fill: TEXT_COLOR,
    },
    resolution: TEXT_RESOLUTION,
  });
  label.x = textX;
  label.y = (slotH - label.height) / 2;
  addLabelBackdrop(content, label);
  content.addChild(label);

  // media overlay — play/pause icon for audio/video, expand icon for photos
  let mediaOverlay: Container | null = null;
  if (isMediaDomain(info.domain)) {
    const parts = createMediaOverlay(endcapW, slotH);
    mediaOverlay = parts.overlay;
    content.addChild(mediaOverlay);
  } else if (isPhotoDomain(info.domain)) {
    const parts = createPreviewOverlay(endcapW, slotH);
    mediaOverlay = parts.overlay;
    content.addChild(mediaOverlay);
  }

  ctx.attachPointerHandlers(container, widgetId);

  return {
    widgetId,
    slot,
    container,
    thumbSprite,
    textureKey,
    mediaOverlay,
    mediaDomain: info.domain ?? null,
    mediaBlobId: info.blobId ?? null,
    mediaMime: info.mime ?? null,
    ...extraCardFields(info),
  };
}

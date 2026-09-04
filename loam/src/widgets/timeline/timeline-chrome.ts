/**
 * toolbar chrome (zoom out/level/in/fit, undo/redo, snap/autoscroll
 * toggles) — extracted from `stfu/video-timeline.ts`'s toolbar row, made
 * generic. persistence of snap/autoscroll prefs is the CALLER's
 * responsibility (pass current-value getters + click handlers) — this
 * module has no opinion on localStorage keys, so animaniac and stfu can
 * each use their own.
 */

import { Container, Graphics, Text } from "pixi.js";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;
export const TOOLBAR_HEIGHT = 24;
export const TOOLBAR_GROUP_GAP = 24;
export const TOOLBAR_TRAILING_SLOT_WIDTH = 24;

type ButtonContainer = Container & { buttonWidth: number; redraw?: () => void; setLabel?: (label: string) => void };

export function makeTextButton(label: string, onClick: () => void): ButtonContainer {
  const c = new Container() as ButtonContainer;
  const bg = new Graphics();
  const text = new Text({ text: label, style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 }, resolution: TEXT_RESOLUTION });
  let w = Math.max(22, text.width + 12);
  const h = TOOLBAR_HEIGHT;
  const draw = (color: number) => {
    bg.clear();
    bg.roundRect(0, 0, w, h, 4).fill({ color });
  };
  draw(0x2a2a3e);
  text.anchor.set(0.5);
  text.x = w / 2;
  text.y = h / 2;
  c.addChild(bg, text);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerover", () => draw(0x3a3a52));
  c.on("pointerout", () => draw(0x2a2a3e));
  c.on("pointertap", (e) => {
    e.stopPropagation();
    onClick();
  });
  c.buttonWidth = w;
  c.setLabel = (nextLabel: string) => {
    text.text = nextLabel;
    w = Math.max(22, text.width + 12);
    text.x = w / 2;
    c.buttonWidth = w;
    draw(0x2a2a3e);
  };
  return c;
}

export function makeToggleButton(label: string, isOn: () => boolean, onClick: () => void): ButtonContainer {
  const c = new Container() as ButtonContainer;
  const bg = new Graphics();
  const text = new Text({ text: label, style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 }, resolution: TEXT_RESOLUTION });
  const w = Math.max(22, text.width + 12);
  const h = TOOLBAR_HEIGHT;
  const draw = (hover: boolean) => {
    const on = isOn();
    bg.clear();
    bg.roundRect(0, 0, w, h, 4).fill({ color: on ? 0x4a3a6a : hover ? 0x3a3a52 : 0x2a2a3e });
    if (on) bg.roundRect(0, 0, w, h, 4).stroke({ width: 1, color: 0xa78bfa });
  };
  draw(false);
  text.anchor.set(0.5);
  text.x = w / 2;
  text.y = h / 2;
  c.addChild(bg, text);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerover", () => draw(true));
  c.on("pointerout", () => draw(false));
  c.on("pointertap", (e) => {
    e.stopPropagation();
    onClick();
    draw(false);
  });
  c.buttonWidth = w;
  c.redraw = () => draw(false);
  return c;
}

export function makeActionButton(label: string, onClick: () => void, isDisabled: () => boolean): ButtonContainer {
  const c = new Container() as ButtonContainer;
  const bg = new Graphics();
  const text = new Text({ text: label, style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 }, resolution: TEXT_RESOLUTION });
  const w = Math.max(22, text.width + 12);
  const h = TOOLBAR_HEIGHT;
  const draw = (hover: boolean) => {
    const disabled = isDisabled();
    bg.clear();
    bg.roundRect(0, 0, w, h, 4).fill({ color: hover && !disabled ? 0x3a3a52 : 0x2a2a3e });
    text.alpha = disabled ? 0.35 : 1;
    c.cursor = disabled ? "default" : "pointer";
  };
  draw(false);
  text.anchor.set(0.5);
  text.x = w / 2;
  text.y = h / 2;
  c.addChild(bg, text);
  c.eventMode = "static";
  c.on("pointerover", () => draw(true));
  c.on("pointerout", () => draw(false));
  c.on("pointertap", (e) => {
    e.stopPropagation();
    if (isDisabled()) return;
    onClick();
  });
  c.buttonWidth = w;
  c.redraw = () => draw(false);
  return c;
}

export interface TimelineToolbarOptions {
  container: Container;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  isSnapEnabled: () => boolean;
  toggleSnap: () => void;
  isAutoScrollEnabled: () => boolean;
  toggleAutoScroll: () => void;
}

export interface TimelineToolbarHandle {
  /** shift the built-in buttons right by `width` px to make room for an
   *  externally-mounted leading control. */
  reserveStart(width: number): void;
  /** fixed anchor at the row's right edge, `TOOLBAR_TRAILING_SLOT_WIDTH`
   *  px wide — external controls add their own child here. */
  trailingSlot: Container;
  /** the autoscroll button's own current left edge (x) — external trailing
   *  controls (e.g. animaniac's own +audio/+video buttons) should anchor
   *  themselves to the left of THIS, not `trailingSlot.x` directly, or
   *  they land on top of the autoscroll button (which already occupies
   *  the space immediately left of `trailingSlot`). */
  getTrailingGroupLeftX(): number;
  setZoomLevelLabel(text: string): void;
  refreshUndoRedo(): void;
  layout(contentWidth: number): void;
  destroy(): void;
}

export function createTimelineToolbar(options: TimelineToolbarOptions): TimelineToolbarHandle {
  const { container, zoomIn, zoomOut, zoomFit, onUndo, onRedo, canUndo, canRedo, isSnapEnabled, toggleSnap, isAutoScrollEnabled, toggleAutoScroll } =
    options;

  const trailingSlot = new Container();
  container.addChild(trailingSlot);

  const autoscrollBtn = makeToggleButton("autoscroll", isAutoScrollEnabled, toggleAutoScroll);
  container.addChild(autoscrollBtn);

  const zoomLabelText = new Text({ text: "ZOOM", style: { fontFamily: FONT_FAMILY, fontSize: 7, fill: 0x707090, letterSpacing: 0.4 }, resolution: TEXT_RESOLUTION });
  zoomLabelText.anchor.set(0.5, 1);
  zoomLabelText.y = TOOLBAR_HEIGHT / 2;
  const zoomLevelText = new Text({ text: "1x", style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0x9090b0 }, resolution: TEXT_RESOLUTION });
  zoomLevelText.anchor.set(0.5, 0);
  zoomLevelText.y = TOOLBAR_HEIGHT / 2;

  const zoomOutBtn = makeTextButton("\u2212", zoomOut);
  const zoomInBtn = makeTextButton("+", zoomIn);
  const fitBtn = makeTextButton("fit", zoomFit);
  const undoBtn = makeActionButton("undo", onUndo, () => !canUndo());
  const redoBtn = makeActionButton("redo", onRedo, () => !canRedo());
  const snapBtn = makeToggleButton("snap", isSnapEnabled, toggleSnap);
  container.addChild(zoomOutBtn, zoomLabelText, zoomLevelText, zoomInBtn, fitBtn, undoBtn, redoBtn, snapBtn);

  let leadingWidth = 0;
  let currentContentWidth = 0;

  function layoutButtons(): void {
    let x = leadingWidth;
    zoomOutBtn.x = x;
    x += zoomOutBtn.buttonWidth + 4;
    zoomLabelText.x = x + 14;
    zoomLevelText.x = x + 14;
    x += 32;
    zoomInBtn.x = x;
    x += zoomInBtn.buttonWidth + 8;
    fitBtn.x = x;
    x += fitBtn.buttonWidth + TOOLBAR_GROUP_GAP;
    undoBtn.x = x;
    x += undoBtn.buttonWidth + 6;
    redoBtn.x = x;
    x += redoBtn.buttonWidth + TOOLBAR_GROUP_GAP;
    snapBtn.x = x;
  }
  function layoutTrailing(): void {
    trailingSlot.x = Math.max(0, currentContentWidth - TOOLBAR_TRAILING_SLOT_WIDTH);
    autoscrollBtn.x = Math.max(0, trailingSlot.x - TOOLBAR_GROUP_GAP - autoscrollBtn.buttonWidth);
  }
  layoutButtons();

  return {
    reserveStart(width: number) {
      leadingWidth = Math.max(0, width);
      layoutButtons();
    },
    trailingSlot,
    getTrailingGroupLeftX() {
      return autoscrollBtn.x;
    },
    setZoomLevelLabel(text: string) {
      zoomLevelText.text = text;
    },
    refreshUndoRedo() {
      undoBtn.redraw?.();
      redoBtn.redraw?.();
    },
    layout(contentWidth: number) {
      currentContentWidth = contentWidth;
      layoutTrailing();
    },
    destroy() {
      trailingSlot.destroy({ children: true });
      autoscrollBtn.destroy();
      zoomLabelText.destroy();
      zoomLevelText.destroy();
      zoomOutBtn.destroy();
      zoomInBtn.destroy();
      fitBtn.destroy();
      undoBtn.destroy();
      redoBtn.destroy();
      snapBtn.destroy();
    },
  };
}

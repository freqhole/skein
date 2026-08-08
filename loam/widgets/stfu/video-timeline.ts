/**
 * stfu's pixi timeline shell — the virtual pan/zoom camera, cut-segments
 * track row, ruler row, and scrollbar row. ports the _design_ (not the code
 * — a different language/runtime) of trek-minus-paris's `editor.js` virtual
 * camera: a fixed-size content area pans/zooms a "viewport" of time, so a
 * track only ever draws what's currently visible rather than the whole
 * (possibly huge) timeline at once.
 *
 * this module owns the camera + chrome (track background/ruler/scrollbar/
 * playhead/zoom buttons); the actual cut-segment graphics + drag/trim/
 * delete interaction live in `cut-segments-track.ts`, which draws into
 * `trackContentLayer` and hooks `trackHitArea` for empty-space clicks. that
 * layer is intentionally *unscaled* — its children reposition themselves
 * from scratch (via `timeToScreenX()`) on every `onViewChange()` call
 * rather than riding a `Container.scale`/`.x` transform, which keeps
 * fixed-screen-size things (trim handles, a delete glyph) simple to draw at
 * a consistent size across zoom levels. fine for a single cut-editing
 * track's realistic segment counts; not meant for a "many thousands of
 * items" track (that concern belongs to the revisions list, not this).
 */

import { Container, Graphics, Rectangle, Text } from "pixi.js";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

// zoom levels are "duration ÷ N seconds visible", matching editor.js's model
const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const NICE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

export const TOOLBAR_HEIGHT = 20;
export const ROW_GAP = 3;
/** height of the cut-segments track row (the only track row this shell owns
 *  today — the future audio-clips track gets its own row, phase 4). */
export const CUT_TRACK_HEIGHT = 28;
const RULER_HEIGHT = 14;
const SCROLLBAR_GAP = 4;
const SCROLLBAR_HEIGHT = 8;
const RULER_LABEL_POOL_SIZE = 16;

/** total fixed height of the whole shell (toolbar + track + ruler +
 *  scrollbar rows) — only the width is responsive, mirroring editor.js's
 *  own layout model. */
export const TIMELINE_SHELL_HEIGHT =
  TOOLBAR_HEIGHT + ROW_GAP + CUT_TRACK_HEIGHT + ROW_GAP + RULER_HEIGHT + SCROLLBAR_GAP + SCROLLBAR_HEIGHT;

function niceStep(target: number): number {
  for (const s of NICE_STEPS) {
    if (s >= target) return s;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2);
  return `${m}:${s.padStart(5, "0")}`;
}

function makeTextButton(label: string, onClick: () => void): Container {
  const c = new Container();
  const bg = new Graphics();
  const text = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  const w = Math.max(22, text.width + 12);
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
  (c as Container & { buttonWidth: number }).buttonWidth = w;
  return c;
}

export interface VideoTimelineHandle {
  /** add this to the widget's own container; positioned at (0, 0) locally —
   *  the caller sets `container.y` to place it below the video area. */
  container: Container;
  /** unscaled layer track rows should add their own content to — reposition
   *  children from scratch (via `timeToScreenX()`) on every `onViewChange()`
   *  call; local coordinates match `timeToScreenX()`/`screenXToTime()` (x=0
   *  is the left edge of the visible content area, 1 unit = 1 screen px). */
  trackContentLayer: Container;
  /** unscaled background of the cut-segments track row — tracks should
   *  attach their own "click empty space to create a segment" pointer
   *  handling here; its local coordinate frame matches `timeToScreenX()`/
   *  `screenXToTime()` (x=0 is the left edge of the visible content area). */
  trackHitArea: Container;
  /** the toolbar row (zoom out/level/in/fit buttons) — external controls
   *  (stfu's cut-mode-control) mount their collapsed trigger here, leftmost,
   *  after calling `reserveToolbarStart()` to make room. */
  toolbarRow: Container;
  /** shift the built-in zoom controls right by `width` px to make room for
   *  an externally-mounted leading control (see `toolbarRow`). */
  reserveToolbarStart(width: number): void;
  /** call whenever the widget's own width changes. */
  resize(contentWidth: number): void;
  setDuration(duration: number): void;
  /** move the playhead line and, if it's now outside the visible window,
   *  recenter the camera on it (mirrors editor.js's scrollTimeIntoView). */
  setCurrentTime(t: number): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomFit(): void;
  timeToScreenX(t: number): number;
  screenXToTime(x: number): number;
  /** fires after any pan/zoom/resize — track rows re-draw their content here. */
  onViewChange(handler: () => void): () => void;
  destroy(): void;
}

export function createVideoTimeline(initialContentWidth: number): VideoTimelineHandle {
  const container = new Container();

  let contentWidth = Math.max(0, initialContentWidth);
  let duration = 0;
  let viewStartTime = 0;
  let viewDuration = 0;
  let pxPerSecond = 0;
  let zoomIndex = 0;
  let currentTime = 0;

  const viewChangeHandlers: Array<() => void> = [];

  // -- toolbar row (zoom out / level / in / fit) --------------------------------

  const toolbarRow = new Container();
  container.addChild(toolbarRow);

  const zoomLevelText = new Text({
    text: "1x",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0x9090b0 },
    resolution: TEXT_RESOLUTION,
  });
  zoomLevelText.anchor.set(0.5, 0.5);
  zoomLevelText.y = TOOLBAR_HEIGHT / 2;

  const zoomOutBtn = makeTextButton("\u2212", () => zoomOut());
  const zoomInBtn = makeTextButton("+", () => zoomIn());
  const fitBtn = makeTextButton("fit", () => zoomFit());
  toolbarRow.addChild(zoomOutBtn, zoomLevelText, zoomInBtn, fitBtn);

  // reserved space at the row's start for an externally-mounted control
  // (stfu's cut-mode-control sits leftmost, matching editor.js's own
  // `layoutToolbar()` order) — set via `reserveToolbarStart()`.
  let toolbarLeadingWidth = 0;

  function layoutToolbar(): void {
    let x = toolbarLeadingWidth;
    zoomOutBtn.x = x;
    x += (zoomOutBtn as any).buttonWidth + 4;
    zoomLevelText.x = x + 14;
    x += 32;
    zoomInBtn.x = x;
    x += (zoomInBtn as any).buttonWidth + 8;
    fitBtn.x = x;
  }
  layoutToolbar();

  // -- cut-segments track row (background + scaled content layer) --------------

  const trackRow = new Container();
  trackRow.y = TOOLBAR_HEIGHT + ROW_GAP;
  container.addChild(trackRow);

  const trackBg = new Graphics();
  trackBg.eventMode = "static";
  trackRow.addChild(trackBg);

  const trackContentLayer = new Container();
  trackRow.addChild(trackContentLayer);

  const trackMask = new Graphics();
  trackRow.addChild(trackMask);
  trackRow.mask = trackMask;

  // -- ruler row (pooled labels + tick marks) -----------------------------------

  const rulerRow = new Container();
  rulerRow.y = TOOLBAR_HEIGHT + ROW_GAP + CUT_TRACK_HEIGHT + ROW_GAP;
  container.addChild(rulerRow);

  const rulerTicks = new Graphics();
  const rulerMask = new Graphics();
  rulerRow.addChild(rulerTicks, rulerMask);
  rulerRow.mask = rulerMask;

  function updateRulerMask(): void {
    rulerMask.clear().rect(0, 0, Math.max(0, contentWidth), RULER_HEIGHT).fill({ color: 0xffffff });
  }
  updateRulerMask(); // draw immediately so the ruler isn't masked-out until the next resize()

  const rulerLabelPool: Text[] = [];
  for (let i = 0; i < RULER_LABEL_POOL_SIZE; i++) {
    const t = new Text({
      text: "",
      style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: 0x707090 },
      resolution: TEXT_RESOLUTION,
    });
    t.visible = false;
    rulerLabelPool.push(t);
    rulerRow.addChild(t);
  }

  // -- playhead (drawn in the ruler row's unscaled space) -----------------------

  const playhead = new Graphics();
  rulerRow.addChild(playhead);

  // -- scrollbar row -------------------------------------------------------------

  const scrollbarRow = new Container();
  scrollbarRow.y = TOOLBAR_HEIGHT + ROW_GAP + CUT_TRACK_HEIGHT + ROW_GAP + RULER_HEIGHT + SCROLLBAR_GAP;
  container.addChild(scrollbarRow);

  const scrollbarTrack = new Graphics();
  scrollbarTrack.eventMode = "static";
  scrollbarTrack.cursor = "pointer";
  const scrollbarThumb = new Graphics();
  scrollbarThumb.eventMode = "static";
  scrollbarThumb.cursor = "grab";
  scrollbarRow.addChild(scrollbarTrack, scrollbarThumb);

  let scrollbarDrag: { startGlobalX: number; startViewStart: number } | null = null;

  scrollbarTrack.on("pointerdown", (e) => {
    if (duration <= 0 || viewDuration >= duration) return;
    const local = e.getLocalPosition(scrollbarRow);
    const clickRatio = contentWidth > 0 ? local.x / contentWidth : 0;
    viewStartTime = clampViewStart(clickRatio * duration - viewDuration / 2);
    applyViewChange(false);
  });
  scrollbarThumb.on("pointerdown", (e) => {
    e.stopPropagation();
    scrollbarDrag = { startGlobalX: e.global.x, startViewStart: viewStartTime };
  });
  scrollbarThumb.on("globalpointermove", (e) => {
    if (!scrollbarDrag || duration <= 0) return;
    const maxViewStart = duration - viewDuration;
    const thumbWidthPx = Math.max(20, (viewDuration / duration) * contentWidth);
    const maxThumbLeft = contentWidth - thumbWidthPx;
    const deltaPx = e.global.x - scrollbarDrag.startGlobalX;
    const deltaTime = maxThumbLeft > 0 ? (deltaPx / maxThumbLeft) * maxViewStart : 0;
    viewStartTime = clampViewStart(scrollbarDrag.startViewStart + deltaTime);
    applyViewChange(false);
  });
  const endScrollbarDrag = () => {
    scrollbarDrag = null;
  };
  scrollbarThumb.on("pointerup", endScrollbarDrag);
  scrollbarThumb.on("pointerupoutside", endScrollbarDrag);

  // -- zoom camera ---------------------------------------------------------------

  function clampViewStart(t: number): number {
    const maxStart = Math.max(0, duration - viewDuration);
    return Math.max(0, Math.min(maxStart, t));
  }

  function timeToScreenX(t: number): number {
    return (t - viewStartTime) * pxPerSecond;
  }

  function screenXToTime(x: number): number {
    return pxPerSecond > 0 ? viewStartTime + x / pxPerSecond : viewStartTime;
  }

  function updateTrackChrome(): void {
    trackBg.clear();
    trackBg.rect(0, 0, contentWidth, CUT_TRACK_HEIGHT).fill({ color: 0x1c1c28 });
    trackBg.hitArea = new Rectangle(0, 0, contentWidth, CUT_TRACK_HEIGHT);
    trackMask.clear().rect(0, 0, contentWidth, CUT_TRACK_HEIGHT).fill({ color: 0xffffff });
  }

  function updateRuler(): void {
    rulerTicks.clear();
    rulerLabelPool.forEach((t) => (t.visible = false));
    if (duration <= 0 || contentWidth <= 0) return;
    const approxTicks = Math.max(2, Math.floor(contentWidth / 60));
    const step = niceStep(viewDuration / approxTicks);
    const startT = Math.max(0, Math.floor(viewStartTime / step) * step);
    let poolIndex = 0;
    for (let t = startT; t <= viewStartTime + viewDuration + step; t += step) {
      const x = timeToScreenX(t);
      if (x < -40 || x > contentWidth + 40) continue;
      if (x >= 0 && x <= contentWidth) {
        rulerTicks.moveTo(x, 0).lineTo(x, 3);
      }
      if (poolIndex < rulerLabelPool.length) {
        const label = rulerLabelPool[poolIndex++];
        label.text = formatTime(t);
        label.anchor.set(0.5, 0);
        label.x = Math.max(label.width / 2, Math.min(contentWidth - label.width / 2, x));
        label.y = 4;
        label.visible = true;
      }
    }
    rulerTicks.stroke({ width: 1, color: 0x444460 });
  }

  function updateScrollbarVisual(): void {
    scrollbarTrack.clear();
    scrollbarTrack.rect(0, 0, contentWidth, SCROLLBAR_HEIGHT).fill({ color: 0x22222e });
    if (duration <= 0 || viewDuration >= duration - 0.0001) {
      scrollbarThumb.clear();
      scrollbarThumb
        .roundRect(0, 0, contentWidth, SCROLLBAR_HEIGHT, 4)
        .fill({ color: 0x555570, alpha: 0.35 });
      scrollbarThumb.eventMode = "none";
      return;
    }
    scrollbarThumb.eventMode = "static";
    const thumbWidthPx = Math.max(20, (viewDuration / duration) * contentWidth);
    const maxThumbLeft = contentWidth - thumbWidthPx;
    const maxViewStart = duration - viewDuration;
    const ratio = maxViewStart > 0 ? viewStartTime / maxViewStart : 0;
    scrollbarThumb.clear();
    scrollbarThumb
      .roundRect(ratio * maxThumbLeft, 0, thumbWidthPx, SCROLLBAR_HEIGHT, 4)
      .fill({ color: 0x555570 });
  }

  function updatePlayhead(): void {
    playhead.clear();
    const x = timeToScreenX(currentTime);
    if (x < 0 || x > contentWidth) return;
    playhead.moveTo(x, 0).lineTo(x, RULER_HEIGHT).stroke({ width: 1, color: 0xd946ef });
  }

  function applyViewChange(zoomChanged: boolean): void {
    pxPerSecond = viewDuration > 0 ? contentWidth / viewDuration : 0;
    void zoomChanged; // track rows redraw from scratch on every view change regardless
    updateTrackChrome();
    updateRuler();
    updateScrollbarVisual();
    updatePlayhead();
    for (const h of viewChangeHandlers) h();
  }

  function setZoom(index: number, focusTime?: number): void {
    zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
    viewDuration = duration > 0 ? duration / ZOOM_LEVELS[zoomIndex] : 0;
    const focus = focusTime ?? currentTime;
    viewStartTime = clampViewStart(focus - viewDuration / 2);
    zoomLevelText.text = `${ZOOM_LEVELS[zoomIndex]}x`;
    applyViewChange(true);
  }

  function zoomIn(): void {
    setZoom(zoomIndex + 1);
  }

  function zoomOut(): void {
    setZoom(zoomIndex - 1);
  }

  function zoomFit(): void {
    setZoom(0);
  }

  function scrollTimeIntoView(t: number): void {
    if (duration <= 0 || viewDuration >= duration) return;
    const center = viewStartTime + viewDuration / 2;
    const tolerance = viewDuration * 0.15;
    if (Math.abs(t - center) > tolerance) {
      viewStartTime = clampViewStart(t - viewDuration / 2);
      applyViewChange(false);
    }
  }

  return {
    container,
    trackContentLayer,
    trackHitArea: trackBg,
    toolbarRow,

    reserveToolbarStart(width: number) {
      toolbarLeadingWidth = Math.max(0, width);
      layoutToolbar();
    },

    resize(newContentWidth: number) {
      contentWidth = Math.max(0, newContentWidth);
      updateRulerMask();
      applyViewChange(false);
    },

    setDuration(newDuration: number) {
      duration = Math.max(0, newDuration);
      setZoom(zoomIndex, currentTime);
    },

    setCurrentTime(t: number) {
      currentTime = t;
      scrollTimeIntoView(t);
      updatePlayhead();
    },

    zoomIn,
    zoomOut,
    zoomFit,
    timeToScreenX,
    screenXToTime,

    onViewChange(handler: () => void) {
      viewChangeHandlers.push(handler);
      return () => {
        const i = viewChangeHandlers.indexOf(handler);
        if (i !== -1) viewChangeHandlers.splice(i, 1);
      };
    },

    destroy() {
      viewChangeHandlers.length = 0;
      container.destroy({ children: true });
    },
  };
}

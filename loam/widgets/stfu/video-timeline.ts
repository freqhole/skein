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

import type { FederatedPointerEvent, FederatedWheelEvent } from "pixi.js";
import { Container, Graphics, Rectangle, Text } from "pixi.js";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

// zoom levels are "duration ÷ N seconds visible", matching editor.js's model
const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const NICE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

// local-only (not doc-persisted) — matches editor.js's own SNAP_ENABLED_STORAGE_KEY
// convention: snapping is an editing-assist preference, not part of the shared
// document, so it's per-browser rather than per-collaborator.
const SNAP_ENABLED_STORAGE_KEY = "skein.stfu.snapEnabled";

function readSnapEnabledPref(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(SNAP_ENABLED_STORAGE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function writeSnapEnabledPref(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SNAP_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // ignore (private browsing / storage disabled)
  }
}

export const TOOLBAR_HEIGHT = 24;
export const ROW_GAP = 3;
/** reserved left-margin width (px), inside every track row, for that row's
 *  own label ("REFERENCE"/"CUT LIST"/"AUDIO CLIPS") — row content (and the
 *  ruler/scrollbar) starts to the right of this column instead of
 *  overlapping it, so labels always have dedicated, legible space rather
 *  than sitting on top of (and getting buried under) track content. */
export const TRACK_LABEL_COLUMN_WIDTH = 92;
/** height of the reference/diarization track row — always present (even
 *  with zero reference data, same as the cut-segments row), matching
 *  editor.js's `TRACK_HEIGHT`. */
export const REFERENCE_TRACK_HEIGHT = 36;
/** height of the cut-segments track row. */
export const CUT_TRACK_HEIGHT = 28;
/** height of the audio-clips track row (below the cut-segments row). */
export const AUDIO_CLIP_TRACK_HEIGHT = 28;
const RULER_HEIGHT = 14;
const SCROLLBAR_GAP = 4;
const SCROLLBAR_HEIGHT = 8;
const RULER_LABEL_POOL_SIZE = 16;
/** fixed width reserved at the toolbar row's trailing (right) edge for an
 *  externally-mounted control — see `toolbarTrailingSlot`. */
export const TOOLBAR_TRAILING_SLOT_WIDTH = 24;

/** total fixed height of the whole shell (toolbar + reference + cut track +
 *  audio-clips track + ruler + scrollbar rows) — only the width is
 *  responsive, mirroring editor.js's own layout model. */
export const TIMELINE_SHELL_HEIGHT =
  TOOLBAR_HEIGHT +
  ROW_GAP +
  REFERENCE_TRACK_HEIGHT +
  ROW_GAP +
  CUT_TRACK_HEIGHT +
  ROW_GAP +
  AUDIO_CLIP_TRACK_HEIGHT +
  ROW_GAP +
  RULER_HEIGHT +
  SCROLLBAR_GAP +
  SCROLLBAR_HEIGHT;

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

/** like `makeTextButton()`, but stays visually "pressed" (a filled/outlined
 *  highlight) while `isOn()` is true — used for the "snap" toggle. exposes a
 *  `redraw()` escape hatch so external state changes (not just hover/click)
 *  can refresh the highlight. */
function makeToggleButton(label: string, isOn: () => boolean, onClick: () => void): Container {
  const c = new Container();
  const bg = new Graphics();
  const text = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
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
  (c as Container & { buttonWidth: number; redraw: () => void }).buttonWidth = w;
  (c as Container & { redraw: () => void }).redraw = () => draw(false);
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
  /** fixed anchor at the toolbar row's right edge (repositioned on every
   *  `resize()`), `TOOLBAR_TRAILING_SLOT_WIDTH` px wide — external controls
   *  (stfu's keyboard-shortcuts button) add their own child here at local
   *  (0, 0) rather than computing their own x position. */
  toolbarTrailingSlot: Container;
  /** unscaled layer the reference/diarization track draws its colored
   *  speaker segments into — same coordinate convention as
   *  `trackContentLayer` (reposition from scratch on every
   *  `onViewChange()`, x=0 is the visible content area's left edge). */
  referenceContentLayer: Container;
  /** background of the reference track row — external code (stfu's
   *  reference-track.ts) attaches its own drag/hover pointer handling here. */
  referenceHitArea: Container;
  /** lives in the reserved `TRACK_LABEL_COLUMN_WIDTH` column to the left of
   *  the row's own content (not masked by it) — the "REFERENCE" label
   *  button mounts here. positioned at (0, row's own y); local (0, 0) is
   *  the row's own top-left corner, same convention as if it were still a
   *  child of the row itself. */
  referenceLabelLayer: Container;
  /** unscaled layer the audio-clips track draws its clip graphics into —
   *  same coordinate convention as `trackContentLayer` (reposition from
   *  scratch on every `onViewChange()`, x=0 is the visible content area's
   *  left edge). */
  audioClipsContentLayer: Container;
  /** background of the audio-clips track row — external code
   *  (`audio-clips-track.ts`) attaches its own create/drag/trim/delete
   *  pointer handling here, mirroring `trackHitArea`. */
  audioClipsHitArea: Container;
  /** call whenever the widget's own width changes. */
  resize(contentWidth: number): void;
  setDuration(duration: number): void;
  /** move the playhead line and, if it's now outside the visible window,
   *  recenter the camera on it (mirrors editor.js's scrollTimeIntoView). */
  setCurrentTime(t: number): void;
  getCurrentTime(): number;
  zoomIn(): void;
  zoomOut(): void;
  zoomFit(): void;
  /** whether the "snap" toolbar toggle is on — track rows should consult
   *  this before snapping a drag/create/resize to a nearby edge (mirrors
   *  editor.js's `snapEnabled` gating `maybeSnap()`). */
  isSnapEnabled(): boolean;
  timeToScreenX(t: number): number;
  screenXToTime(x: number): number;
  /** fires after any pan/zoom/resize — track rows re-draw their content here. */
  onViewChange(handler: () => void): () => void;
  destroy(): void;
}

export function createVideoTimeline(
  initialContentWidth: number,
  canvasElement: HTMLCanvasElement,
  onSeek?: (t: number) => void
): VideoTimelineHandle {
  const container = new Container();

  let contentWidth = Math.max(0, initialContentWidth);
  /** the actual width available to track content/ruler/scrollbar, once the
   *  left `TRACK_LABEL_COLUMN_WIDTH` label column is reserved. */
  let rowWidth = Math.max(0, contentWidth - TRACK_LABEL_COLUMN_WIDTH);
  let duration = 0;
  let viewStartTime = 0;
  let viewDuration = 0;
  let pxPerSecond = 0;
  let zoomIndex = 0;
  let currentTime = 0;
  let snapEnabled = readSnapEnabledPref();

  const viewChangeHandlers: Array<() => void> = [];

  // -- toolbar row (zoom out / label / level / in / fit / snap) ----------------

  const toolbarRow = new Container();
  container.addChild(toolbarRow);

  const toolbarTrailingSlot = new Container();
  toolbarTrailingSlot.x = Math.max(0, contentWidth - TOOLBAR_TRAILING_SLOT_WIDTH);
  toolbarRow.addChild(toolbarTrailingSlot);

  // "ZOOM" stacked just above the numeric level, matching editor.js's
  // `zoomLabelText`/`zoomLevelText` layout between the out/in buttons.
  const zoomLabelText = new Text({
    text: "ZOOM",
    style: { fontFamily: FONT_FAMILY, fontSize: 7, fill: 0x707090, letterSpacing: 0.4 },
    resolution: TEXT_RESOLUTION,
  });
  zoomLabelText.anchor.set(0.5, 1);
  zoomLabelText.y = TOOLBAR_HEIGHT / 2;

  const zoomLevelText = new Text({
    text: "1x",
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0x9090b0 },
    resolution: TEXT_RESOLUTION,
  });
  zoomLevelText.anchor.set(0.5, 0);
  zoomLevelText.y = TOOLBAR_HEIGHT / 2;

  const zoomOutBtn = makeTextButton("\u2212", () => zoomOut());
  const zoomInBtn = makeTextButton("+", () => zoomIn());
  const fitBtn = makeTextButton("fit", () => zoomFit());
  const snapBtn = makeToggleButton(
    "snap",
    () => snapEnabled,
    () => setSnapEnabled(!snapEnabled)
  );
  toolbarRow.addChild(zoomOutBtn, zoomLabelText, zoomLevelText, zoomInBtn, fitBtn, snapBtn);

  // reserved space at the row's start for an externally-mounted control
  // (stfu's cut-mode-control sits leftmost, matching editor.js's own
  // `layoutToolbar()` order) — set via `reserveToolbarStart()`.
  let toolbarLeadingWidth = 0;

  function layoutToolbar(): void {
    let x = toolbarLeadingWidth;
    zoomOutBtn.x = x;
    x += (zoomOutBtn as any).buttonWidth + 4;
    zoomLabelText.x = x + 14;
    zoomLevelText.x = x + 14;
    x += 32;
    zoomInBtn.x = x;
    x += (zoomInBtn as any).buttonWidth + 8;
    fitBtn.x = x;
    x += (fitBtn as any).buttonWidth + 8;
    snapBtn.x = x;
  }
  layoutToolbar();

  function setSnapEnabled(next: boolean): void {
    snapEnabled = next;
    writeSnapEnabledPref(next);
    (snapBtn as any).redraw();
  }

  // -- reference/diarization track row (background + content layer) -----------

  const referenceRow = new Container();
  // "wheel" listener lives on the row (below), not `referenceBg` — a
  // descendant-only listener never fires while hovering a segment inside
  // `referenceContentLayer`, since bubbling only walks up through shared
  // ancestors, not sideways to siblings.
  referenceRow.eventMode = "static";
  referenceRow.x = TRACK_LABEL_COLUMN_WIDTH;
  referenceRow.y = TOOLBAR_HEIGHT + ROW_GAP;
  container.addChild(referenceRow);

  const referenceBg = new Graphics();
  referenceBg.eventMode = "static";
  referenceRow.addChild(referenceBg);

  const referenceContentLayer = new Container();
  referenceRow.addChild(referenceContentLayer);

  // a mask must live outside the container it clips — pixi's hit-testing
  // treats a mask that's also a descendant of the masked container as
  // self-referential, which silently breaks hit-testing on the masked
  // content underneath it. so this is a *sibling* of referenceRow (both
  // children of `container`), positioned to match its on-screen rect.
  const referenceMask = new Graphics();
  // a plain "passive" Graphics with real drawn geometry still answers
  // hitTestRecursive's leaf test once an ancestor (the widget root) is
  // interactive — the inherited eventMode, not this object's own, is what
  // gets checked there — and since it isn't itself interactive, that
  // returns `[]` (empty but truthy), which stops the reverse children loop
  // dead before `referenceRow` (added earlier, tested later) is ever tried.
  // `eventMode = "none"` hard-blocks it in `_interactivePrune()` instead.
  referenceMask.eventMode = "none";
  referenceMask.x = referenceRow.x;
  referenceMask.y = referenceRow.y;
  container.addChild(referenceMask);
  referenceRow.mask = referenceMask;

  // lives in the reserved label column to the row's *left* (a sibling of
  // referenceRow, not a child of it — so it isn't clipped by
  // `referenceMask` and doesn't overlap the row's own content). positioned
  // at (0, referenceRow.y) so its own local (0, 0) still means "row's own
  // top-left corner", same convention `reference-track.ts` already expects.
  const referenceLabelLayer = new Container();
  referenceLabelLayer.y = referenceRow.y;
  container.addChild(referenceLabelLayer);

  // -- cut-segments track row (background + scaled content layer) --------------

  const trackRow = new Container();
  trackRow.eventMode = "static"; // see comment on referenceRow.eventMode.
  trackRow.x = TRACK_LABEL_COLUMN_WIDTH;
  trackRow.y = TOOLBAR_HEIGHT + ROW_GAP + REFERENCE_TRACK_HEIGHT + ROW_GAP;
  container.addChild(trackRow);

  const trackBg = new Graphics();
  trackBg.eventMode = "static";
  trackRow.addChild(trackBg);

  const trackContentLayer = new Container();
  trackRow.addChild(trackContentLayer);

  // sibling of trackRow, not a child of it — see comment on referenceMask.
  const trackMask = new Graphics();
  trackMask.eventMode = "none"; // see comment on referenceMask.eventMode.
  trackMask.x = trackRow.x;
  trackMask.y = trackRow.y;
  container.addChild(trackMask);
  trackRow.mask = trackMask;

  const trackLabelLayer = new Container();
  trackLabelLayer.y = trackRow.y;
  container.addChild(trackLabelLayer);
  const trackLabelText = new Text({
    text: "CUT LIST",
    style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: 0x888888, letterSpacing: 0.3 },
    resolution: TEXT_RESOLUTION,
  });
  trackLabelText.anchor.set(0, 0.5);
  trackLabelText.x = 8;
  trackLabelText.y = CUT_TRACK_HEIGHT / 2;
  trackLabelLayer.addChild(trackLabelText);

  // -- audio-clips track row (background + unscaled content layer) -------------

  const audioClipsRow = new Container();
  audioClipsRow.eventMode = "static"; // see comment on referenceRow.eventMode.
  audioClipsRow.x = TRACK_LABEL_COLUMN_WIDTH;
  audioClipsRow.y = TOOLBAR_HEIGHT + ROW_GAP + REFERENCE_TRACK_HEIGHT + ROW_GAP + CUT_TRACK_HEIGHT + ROW_GAP;
  container.addChild(audioClipsRow);

  const audioClipsBg = new Graphics();
  audioClipsBg.eventMode = "static";
  audioClipsRow.addChild(audioClipsBg);

  const audioClipsContentLayer = new Container();
  audioClipsRow.addChild(audioClipsContentLayer);

  const audioClipsLabelLayer = new Container();
  audioClipsLabelLayer.y = audioClipsRow.y;
  container.addChild(audioClipsLabelLayer);
  const audioClipsLabelText = new Text({
    text: "AUDIO CLIPS",
    style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: 0x888888, letterSpacing: 0.3 },
    resolution: TEXT_RESOLUTION,
  });
  audioClipsLabelText.anchor.set(0, 0.5);
  audioClipsLabelText.x = 8;
  audioClipsLabelText.y = AUDIO_CLIP_TRACK_HEIGHT / 2;
  audioClipsLabelLayer.addChild(audioClipsLabelText);

  // sibling of audioClipsRow, not a child of it — see comment on referenceMask.
  const audioClipsMask = new Graphics();
  audioClipsMask.eventMode = "none"; // see comment on referenceMask.eventMode.
  audioClipsMask.x = audioClipsRow.x;
  audioClipsMask.y = audioClipsRow.y;
  container.addChild(audioClipsMask);
  audioClipsRow.mask = audioClipsMask;

  // -- ruler row (pooled labels + tick marks) -----------------------------------

  const rulerRow = new Container();
  // clicking the ruler (timestamps + ticks strip) seeks the player, same
  // pattern as `referenceRow`/`trackRow`'s own eventMode comment above.
  rulerRow.eventMode = "static";
  rulerRow.x = TRACK_LABEL_COLUMN_WIDTH;
  rulerRow.y =
    TOOLBAR_HEIGHT +
    ROW_GAP +
    REFERENCE_TRACK_HEIGHT +
    ROW_GAP +
    CUT_TRACK_HEIGHT +
    ROW_GAP +
    AUDIO_CLIP_TRACK_HEIGHT +
    ROW_GAP;
  container.addChild(rulerRow);

  rulerRow.on("pointerdown", (e: FederatedPointerEvent) => {
    const local = e.getLocalPosition(rulerRow);
    onSeek?.(Math.max(0, Math.min(duration, screenXToTime(local.x))));
  });

  const rulerTicks = new Graphics();
  rulerTicks.eventMode = "none"; // see comment on referenceMask.eventMode.
  rulerRow.addChild(rulerTicks);

  // sibling of rulerRow, not a child of it — see comment on referenceMask.
  const rulerMask = new Graphics();
  rulerMask.eventMode = "none"; // see comment on referenceMask.eventMode.
  rulerMask.x = rulerRow.x;
  rulerMask.y = rulerRow.y;
  container.addChild(rulerMask);
  rulerRow.mask = rulerMask;

  function updateRulerMask(): void {
    rulerMask.clear().rect(0, 0, Math.max(0, rowWidth), RULER_HEIGHT).fill({ color: 0xffffff });
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

  // -- playhead: one solid vertical line spanning the whole shell (reference
  //    row through the ruler), a sibling of the rows rather than drawn once
  //    per row -- an earlier version drew a separate short line per row,
  //    which (with `ROW_GAP` between rows) read as a dashed/broken line
  //    rather than one continuous playhead. --

  const playhead = new Graphics();
  playhead.eventMode = "none"; // see comment on referenceMask.eventMode.
  playhead.x = TRACK_LABEL_COLUMN_WIDTH;
  playhead.y = referenceRow.y;
  container.addChild(playhead);

  // -- scrollbar row -------------------------------------------------------------

  const scrollbarRow = new Container();
  scrollbarRow.x = TRACK_LABEL_COLUMN_WIDTH;
  scrollbarRow.y =
    TOOLBAR_HEIGHT +
    ROW_GAP +
    REFERENCE_TRACK_HEIGHT +
    ROW_GAP +
    CUT_TRACK_HEIGHT +
    ROW_GAP +
    AUDIO_CLIP_TRACK_HEIGHT +
    ROW_GAP +
    RULER_HEIGHT +
    SCROLLBAR_GAP;
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
    const clickRatio = rowWidth > 0 ? local.x / rowWidth : 0;
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
    const thumbWidthPx = Math.max(20, (viewDuration / duration) * rowWidth);
    const maxThumbLeft = rowWidth - thumbWidthPx;
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

  // -- horizontal wheel/trackpad pan (deltaX, or shift+deltaY for a plain
  //    vertical mouse wheel) — not in editor.js (whose own `onWheel` only
  //    redirects ctrl+wheel pinch-zoom), but a clear usability gap: without
  //    it, panning long timelines requires dragging the thin scrollbar
  //    thumb every time. ---------------------------------------------------

  function onWheelPan(e: FederatedWheelEvent): void {
    if (duration <= 0 || viewDuration >= duration) return;
    const deltaX = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (deltaX === 0) return;
    e.preventDefault();
    const deltaTime = pxPerSecond > 0 ? deltaX / pxPerSecond : 0;
    viewStartTime = clampViewStart(viewStartTime + deltaTime);
    applyViewChange(false);
  }
  referenceRow.on("wheel", onWheelPan);
  trackRow.on("wheel", onWheelPan);
  audioClipsRow.on("wheel", onWheelPan);

  // `onWheelPan()`'s own `e.preventDefault()` (above) only stops the
  // *pixi* event from bubbling to pixi ancestors -- it does NOT stop
  // `viewport.ts`'s own, separately-registered native `wheel` listener on
  // the same `<canvas>` element from ALSO firing and panning/zooming the
  // whole canvas underneath us. that listener opts out early when it sees
  // `_skeinWidgetScroll === true` on the native event (the same convention
  // `scrollable-content.ts` uses for its own scrollboxes) -- so claim it
  // here, in a document-capture-phase listener that's guaranteed to run
  // BEFORE the canvas's own bubble-phase listener, whenever the pointer is
  // over one of the 3 track rows AND the gesture is a horizontal pan (the
  // same condition `onWheelPan()` itself uses).
  function onNativeWheel(e: WheelEvent): void {
    const deltaX = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (deltaX === 0) return;
    const rect = canvasElement.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const g = referenceRow.getGlobalPosition();
    // local widget dimensions and screen/global dimensions only match at
    // 1x canvas zoom -- correct for the canvas's own zoom via the row's
    // world transform scale, same technique `scrollable-content.ts` uses.
    const scaleX = referenceRow.worldTransform.a;
    const scaleY = referenceRow.worldTransform.d;
    const totalHeight = REFERENCE_TRACK_HEIGHT + ROW_GAP + CUT_TRACK_HEIGHT + ROW_GAP + AUDIO_CLIP_TRACK_HEIGHT;
    const inside =
      px >= g.x && px <= g.x + rowWidth * scaleX && py >= g.y && py <= g.y + totalHeight * scaleY;
    if (inside) (e as WheelEvent & { _skeinWidgetScroll?: boolean })._skeinWidgetScroll = true;
  }
  document.addEventListener("wheel", onNativeWheel, { capture: true, passive: true });

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
    trackBg.rect(0, 0, rowWidth, CUT_TRACK_HEIGHT).fill({ color: 0x1c1c28 });
    trackBg.hitArea = new Rectangle(0, 0, rowWidth, CUT_TRACK_HEIGHT);
    trackMask.clear().rect(0, 0, rowWidth, CUT_TRACK_HEIGHT).fill({ color: 0xffffff });

    audioClipsBg.clear();
    audioClipsBg.rect(0, 0, rowWidth, AUDIO_CLIP_TRACK_HEIGHT).fill({ color: 0x181c24 });
    audioClipsBg.hitArea = new Rectangle(0, 0, rowWidth, AUDIO_CLIP_TRACK_HEIGHT);
    audioClipsMask.clear().rect(0, 0, rowWidth, AUDIO_CLIP_TRACK_HEIGHT).fill({ color: 0xffffff });

    referenceBg.clear();
    // matches editor.js's `refBackground` (0x262626)
    referenceBg.rect(0, 0, rowWidth, REFERENCE_TRACK_HEIGHT).fill({ color: 0x262626 });
    referenceBg.hitArea = new Rectangle(0, 0, rowWidth, REFERENCE_TRACK_HEIGHT);
    referenceMask.clear().rect(0, 0, rowWidth, REFERENCE_TRACK_HEIGHT).fill({ color: 0xffffff });
  }

  function updateRuler(): void {
    rulerTicks.clear();
    rulerLabelPool.forEach((t) => (t.visible = false));
    if (duration <= 0 || rowWidth <= 0) return;
    const approxTicks = Math.max(2, Math.floor(rowWidth / 60));
    const step = niceStep(viewDuration / approxTicks);
    const startT = Math.max(0, Math.floor(viewStartTime / step) * step);
    let poolIndex = 0;
    for (let t = startT; t <= viewStartTime + viewDuration + step; t += step) {
      const x = timeToScreenX(t);
      if (x < -40 || x > rowWidth + 40) continue;
      if (x >= 0 && x <= rowWidth) {
        rulerTicks.moveTo(x, 0).lineTo(x, 3);
      }
      if (poolIndex < rulerLabelPool.length) {
        const label = rulerLabelPool[poolIndex++];
        label.text = formatTime(t);
        label.anchor.set(0.5, 0);
        label.x = Math.max(label.width / 2, Math.min(rowWidth - label.width / 2, x));
        label.y = 4;
        label.visible = true;
      }
    }
    rulerTicks.stroke({ width: 1, color: 0x444460 });
  }

  function updateScrollbarVisual(): void {
    scrollbarTrack.clear();
    scrollbarTrack.rect(0, 0, rowWidth, SCROLLBAR_HEIGHT).fill({ color: 0x22222e });
    if (duration <= 0 || viewDuration >= duration - 0.0001) {
      scrollbarThumb.clear();
      scrollbarThumb
        .roundRect(0, 0, rowWidth, SCROLLBAR_HEIGHT, 4)
        .fill({ color: 0x555570, alpha: 0.35 });
      scrollbarThumb.eventMode = "none";
      return;
    }
    scrollbarThumb.eventMode = "static";
    const thumbWidthPx = Math.max(20, (viewDuration / duration) * rowWidth);
    const maxThumbLeft = rowWidth - thumbWidthPx;
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
    if (x < 0 || x > rowWidth) return;
    // spans from the reference row's own top down through the bottom of the
    // ruler row (i.e. the whole shell minus the toolbar/scrollbar), so it
    // reads as one solid line rather than one dashed segment per row.
    const totalHeight = rulerRow.y + RULER_HEIGHT - referenceRow.y;
    playhead.moveTo(x, 0).lineTo(x, totalHeight).stroke({ width: 1, color: 0xd946ef });
  }

  function applyViewChange(zoomChanged: boolean): void {
    pxPerSecond = viewDuration > 0 ? rowWidth / viewDuration : 0;
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
    toolbarTrailingSlot,
    referenceContentLayer,
    referenceHitArea: referenceBg,
    referenceLabelLayer,
    audioClipsContentLayer,
    audioClipsHitArea: audioClipsBg,

    reserveToolbarStart(width: number) {
      toolbarLeadingWidth = Math.max(0, width);
      layoutToolbar();
    },

    resize(newContentWidth: number) {
      contentWidth = Math.max(0, newContentWidth);
      rowWidth = Math.max(0, contentWidth - TRACK_LABEL_COLUMN_WIDTH);
      toolbarTrailingSlot.x = Math.max(0, contentWidth - TOOLBAR_TRAILING_SLOT_WIDTH);
      updateRulerMask();
      applyViewChange(false);
    },

    setDuration(newDuration: number) {
      const next = Math.max(0, newDuration);
      // called on every doc change (e.g. `refreshTimelineFromDoc()` after
      // any segment edit), not just when the video's own duration actually
      // changes — recentering the camera on every single one of those would
      // yank the view back to the playhead on every edit. only an actual
      // duration change (a fresh video load) should recenter.
      if (next === duration) return;
      duration = next;
      setZoom(zoomIndex, currentTime);
    },

    setCurrentTime(t: number) {
      currentTime = t;
      scrollTimeIntoView(t);
      updatePlayhead();
    },
    getCurrentTime() {
      return currentTime;
    },

    zoomIn,
    zoomOut,
    zoomFit,
    isSnapEnabled() {
      return snapEnabled;
    },
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
      document.removeEventListener("wheel", onNativeWheel, { capture: true });
      container.destroy({ children: true });
    },
  };
}

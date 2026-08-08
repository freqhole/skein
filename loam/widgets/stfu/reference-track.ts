/**
 * stfu's reference/diarization track — renders per-speaker colored segments
 * (once reference data has been loaded, see `reference-data.ts` + the
 * "load reference data..." widget action in `index.ts`) into
 * `video-timeline.ts`'s `referenceContentLayer`. the row's label column
 * hosts two separate buttons: the whole column toggles the segments
 * panel's "reference" source (mirrors the CUT LIST/AUDIO CLIPS labels in
 * `video-timeline.ts`), and a bigger caret-only button opens a
 * speaker-visibility popover (also reachable via right-click anywhere on
 * the row). direct design-port of `editor.js`'s
 * `rebuildReferenceGraphics()`/`createRefLabelButton()`/
 * `openSpeakerDialog()` — the popover itself is built with the generic
 * `expanding-panel.ts` helper (no full-modal dialog infra exists yet in
 * skein) rather than editor.js's own dialog system, but the row layout
 * (checkbox/swatch/label), "select all"/"clear all" buttons, and empty
 * state copy match it closely.
 *
 * this track needs zero reference data to mount cleanly — an empty track
 * row and an empty-state popover are both valid states.
 */

import { Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from "pixi.js";
import { createExpandingPanel, type ExpandingPanelHandle } from "../../src/widgets/expanding-panel";
import { createScrollableContent, type ScrollableContent } from "../../src/widgets/scrollable-content";
import {
  AUDIO_CLIP_TRACK_HEIGHT,
  CUT_TRACK_HEIGHT,
  REFERENCE_TRACK_HEIGHT,
  TRACK_LABEL_COLUMN_WIDTH,
  type VideoTimelineHandle,
} from "./video-timeline";
import type { ReferenceSpeaker, TranscriptSegment } from "./types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

// matches trek-minus-paris's --color-magenta custom property
const MAGENTA = 0xe619b3;

const MARGIN_Y = 4;
const LABEL_PAD_X = 8;
const DIALOG_WIDTH = 220;
const ROW_HEIGHT = 26;
const HEADER_BTN_HEIGHT = 24;
const HEADER_BTN_GAP = 8;

export interface ReferenceTrackOptions {
  timeline: VideoTimelineHandle;
  overlayParent: Container;
  /** canvas element the widget is rendered on — the speaker list's
   *  scrollable area needs this for wheel-event hit testing (see
   *  `createScrollableContent()`). */
  canvasElement: HTMLCanvasElement;
  getReferenceSpeakers: () => Record<string, ReferenceSpeaker>;
  getTranscriptSegments: () => TranscriptSegment[];
  /** localStorage key for the visible-speakers preference (browser-local UI
   *  state, mirrors editor.js's `trek-editor-visible-speakers`). */
  storageKey: string;
  /** how tall the speaker popover is allowed to get, in `overlayParent`'s
   *  local space, before it runs into the widget's own clipping bounds —
   *  pass the space available below the reference row (timeline shell +
   *  segments panel), since the popover is allowed to cover them while open. */
  overlayMaxHeight: number;
  /** called when the user drags a reference/diarization segment down into
   *  the cut-list row and releases it there — the new cut segment should
   *  snap exactly to the dragged segment's own [start, end] (it can be
   *  resized like any other cut-list segment afterwards). */
  onCreateCutSegment?: (start: number, end: number) => void;
  /** same as `onCreateCutSegment`, but for dropping onto the audio-clips
   *  row instead — the new clip should snap to the same [start, end]. */
  onCreateAudioClip?: (start: number, end: number) => void;
  /** called on a plain click (no drag) on a reference segment — matches
   *  editor.js's own reference-track click behavior (`video.currentTime =
   *  hit.start`), which this is a direct port of. */
  onSeek?: (time: number) => void;
  /** fires when the reference row's own label area (the whole
   *  `TRACK_LABEL_COLUMN_WIDTH` column, minus the caret button) is
   *  clicked — wired to `SegmentsPanelHandle.toggleViewMode("reference")`. */
  onToggleVisible?: () => void;
  /** whether reference data is currently a visible segments-panel source —
   *  drives the label area's highlight. */
  isReferenceActive?: () => boolean;
}

export interface ReferenceTrackHandle {
  /** re-draw segment graphics and the (if open) speaker popover — call
   *  after `referenceSpeakers`/`transcriptSegments` change for any reason. */
  refresh(): void;
  /** call whenever the widget's own width changes. */
  resize(contentWidth: number): void;
  destroy(): void;
}

function makeSecondaryButton(label: string, onClick: () => void): { container: Container; draw(width: number): void } {
  const container = new Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  const bg = new Graphics();
  const text = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xdddddd },
    resolution: TEXT_RESOLUTION,
  });
  text.anchor.set(0.5);
  container.addChild(bg, text);

  let currentWidth = 0;
  const paint = (color: number) => {
    bg.clear();
    bg.roundRect(0, 0, currentWidth, HEADER_BTN_HEIGHT, 4).fill({ color });
  };
  container.on("pointerover", () => paint(0x4a4a4a));
  container.on("pointerout", () => paint(0x3a3a3a));
  container.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onClick();
  });

  return {
    container,
    draw(width: number) {
      currentWidth = width;
      paint(0x3a3a3a);
      text.x = width / 2;
      text.y = HEADER_BTN_HEIGHT / 2;
      container.hitArea = new Rectangle(0, 0, width, HEADER_BTN_HEIGHT);
    },
  };
}

export function createReferenceTrack(options: ReferenceTrackOptions): ReferenceTrackHandle {
  const {
    timeline,
    overlayParent,
    canvasElement,
    getReferenceSpeakers,
    getTranscriptSegments,
    storageKey,
    overlayMaxHeight,
    onCreateCutSegment,
    onCreateAudioClip,
    onSeek,
    onToggleVisible,
    isReferenceActive,
  } = options;

  let contentWidth = 0;
  let visibleSpeakers = new Set<string>();
  let knownSpeakers: string[] = [];
  let initializedVisibility = false;
  /** the segment currently under the pointer (no active drag) — drawn with
   *  a white hover outline, mirroring cut-segments-track.ts's/
   *  audio-clips-track.ts's own hover styling. compared by value, not
   *  identity, since `getTranscriptSegments()` isn't guaranteed to return
   *  the exact same object reference across calls. */
  let hoveredSeg: TranscriptSegment | null = null;

  function sameSegment(a: TranscriptSegment | null, b: TranscriptSegment | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.start === b.start && a.end === b.end && a.speaker === b.speaker;
  }

  function loadVisibility(): void {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return;
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) {
        visibleSpeakers = new Set(arr.filter((l): l is string => typeof l === "string"));
        initializedVisibility = true;
      }
    } catch {
      // malformed/unavailable storage — fall through to the "all visible" default
    }
  }

  function persistVisibility(): void {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...visibleSpeakers]));
    } catch {
      // private browsing / quota — not fatal, just doesn't persist
    }
  }

  loadVisibility();

  // -- segment graphics (pooled, redrawn from scratch on every refresh) --------

  const segmentPool: Graphics[] = [];

  function segmentGraphicsAt(i: number): Graphics {
    while (segmentPool.length <= i) {
      const g = new Graphics();
      // purely visual — see cut-segments-track.ts's `g.eventMode` comment.
      g.eventMode = "none";
      timeline.referenceContentLayer.addChild(g);
      segmentPool.push(g);
    }
    return segmentPool[i];
  }

  function redrawSegments(): void {
    const speakers = getReferenceSpeakers();
    const segments = getTranscriptSegments();

    const allLabels = Object.keys(speakers).sort();
    if (!initializedVisibility) {
      visibleSpeakers = new Set(allLabels);
      initializedVisibility = true;
    }
    knownSpeakers = allLabels;

    let i = 0;
    for (const seg of segments) {
      if (!seg.speaker || !visibleSpeakers.has(seg.speaker)) continue;
      const x1 = timeline.timeToScreenX(seg.start);
      const x2 = timeline.timeToScreenX(seg.end);
      if (x2 < 0 || x1 > contentWidth) continue; // fully offscreen
      const w = Math.max(2, x2 - x1);
      const color = speakers[seg.speaker]?.color ?? 0x60a5fa;
      const height = Math.max(1, REFERENCE_TRACK_HEIGHT - 2 * MARGIN_Y);
      const g = segmentGraphicsAt(i++);
      const hovered = sameSegment(seg, hoveredSeg);
      g.clear();
      // hover just saturates this segment's own color (brighter fill +
      // a border in the same hue) — mirrors cut-segments-track.ts's/
      // audio-clips-track.ts's own hover treatment, no white accent (that's
      // reserved for a "selected" state, which reference segments don't have).
      g.rect(0, MARGIN_Y, w, height).fill({ color, alpha: hovered ? 0.85 : 0.55 });
      if (hovered) {
        g.rect(0, MARGIN_Y, w, height).stroke({ width: 1, color });
      }
      g.x = x1;
      g.visible = true;
    }
    for (; i < segmentPool.length; i++) segmentPool[i].visible = false;
  }

  const offViewChange = timeline.onViewChange(() => redrawSegments());

  // -- drag a reference segment down into the cut list -------------------------
  //
  // there's no snapping-to-pointer-position here: the new cut segment must
  // land exactly on the dragged reference segment's own [start, end] (per
  // spec), so the only thing the drag gesture itself needs to figure out is
  // *which* reference segment was grabbed and *whether* it was dropped over
  // the cut-list row — the actual [start, end] values just ride along
  // unmodified from `hitTestReferenceEntry()`'s result to `onCreateCutSegment`.

  const REF_DRAG_THRESHOLD_PX = 4;

  interface RefDragState {
    seg: TranscriptSegment;
    startGlobalX: number;
    startGlobalY: number;
    moved: boolean;
  }
  let refDrag: RefDragState | null = null;
  let dragGhost: Graphics | null = null;

  /** mirrors `redrawSegments()`'s own filtering/positioning exactly, so a
   *  drag can only ever pick up a segment that's actually visible — padded
   *  a few px past the drawn edges since real speech segments are often
   *  only a few screen-px wide at typical zoom, making the un-padded
   *  bounding box an impractically small drag target. */
  function hitTestReferenceEntry(localX: number): TranscriptSegment | null {
    const REF_HIT_PAD_PX = 4;
    const segments = getTranscriptSegments();
    for (let idx = segments.length - 1; idx >= 0; idx--) {
      const seg = segments[idx];
      if (!seg.speaker || !visibleSpeakers.has(seg.speaker)) continue;
      const x1 = timeline.timeToScreenX(seg.start);
      const x2 = timeline.timeToScreenX(seg.end);
      const w = Math.max(2, x2 - x1);
      if (localX >= x1 - REF_HIT_PAD_PX && localX <= x1 + w + REF_HIT_PAD_PX) return seg;
    }
    return null;
  }

  function ensureGhost(): Graphics {
    if (!dragGhost) {
      dragGhost = new Graphics();
      dragGhost.eventMode = "none"; // purely visual — see cut-segments-track.ts's `g.eventMode` comment.
      timeline.container.addChild(dragGhost);
    }
    return dragGhost;
  }

  function destroyGhost(): void {
    dragGhost?.destroy();
    dragGhost = null;
  }

  type DropTarget = "cut-list" | "audio-clips" | null;

  /** `globalPoint` in `toLocal(...)`'s expected space (i.e. an event's own
   *  `.global`) — identifies which (if any) of the two valid drop rows it
   *  currently falls within. */
  function hitDropTarget(globalPoint: { x: number; y: number }): DropTarget {
    const cutLocal = timeline.trackHitArea.toLocal(globalPoint);
    if (cutLocal.y >= 0 && cutLocal.y <= CUT_TRACK_HEIGHT) return "cut-list";
    const clipsLocal = timeline.audioClipsHitArea.toLocal(globalPoint);
    if (clipsLocal.y >= 0 && clipsLocal.y <= AUDIO_CLIP_TRACK_HEIGHT) return "audio-clips";
    return null;
  }

  function onReferencePointerDown(e: FederatedPointerEvent): void {
    const local = e.getLocalPosition(timeline.referenceHitArea);
    const seg = hitTestReferenceEntry(local.x);
    if (!seg) return;
    // the drag ghost conveys "grabbed" on its own — drop the hover outline
    // so it doesn't sit stacked underneath the ghost for the rest of the drag.
    if (hoveredSeg) {
      hoveredSeg = null;
      redrawSegments();
    }
    refDrag = { seg, startGlobalX: e.global.x, startGlobalY: e.global.y, moved: false };
  }

  function onGlobalPointerMove(e: FederatedPointerEvent): void {
    if (!refDrag) return;
    const dx = e.global.x - refDrag.startGlobalX;
    const dy = e.global.y - refDrag.startGlobalY;
    if (!refDrag.moved) {
      if (Math.hypot(dx, dy) <= REF_DRAG_THRESHOLD_PX) return;
      refDrag.moved = true;

      // ghost is pinned to the segment's own time range for its entire
      // life — only its y follows the pointer from here on, so dragging can
      // only ever choose *which row* to drop into, never retime the copy in
      // flight (direct port of editor.js's showRefDragGhost(), which fixes
      // x/width once and only ever updates y via updateRefDragGhostPosition()).
      const seg = refDrag.seg;
      const speakers = getReferenceSpeakers();
      const color = (seg.speaker && speakers[seg.speaker]?.color) ?? 0x60a5fa;
      const x1 = timeline.timeToScreenX(seg.start);
      const x2 = timeline.timeToScreenX(seg.end);
      const width = Math.max(2, x2 - x1);
      const height = Math.max(1, REFERENCE_TRACK_HEIGHT - 2 * MARGIN_Y);
      // `timeToScreenX()` is in `referenceContentLayer`'s own local frame,
      // not `timeline.container`'s (the ghost's parent) — bridge the two via
      // pixi's own transform chain rather than assuming a fixed offset
      // between them.
      const topLeftGlobal = timeline.referenceContentLayer.toGlobal({ x: x1, y: 0 });
      const topLeftLocal = timeline.container.toLocal(topLeftGlobal);

      const ghost = ensureGhost();
      ghost.clear();
      ghost.roundRect(0, 0, width, height, 3).fill({ color, alpha: 0.85 }).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
      ghost.x = topLeftLocal.x;
    }

    // only y tracks the pointer, centered on it (matches editor.js's
    // `globalY - (TRACK_HEIGHT - 2*MARGIN_Y)/2`).
    const height = Math.max(1, REFERENCE_TRACK_HEIGHT - 2 * MARGIN_Y);
    const local = timeline.container.toLocal(e.global);
    const ghost = ensureGhost();
    ghost.y = local.y - height / 2;
  }

  function onGlobalPointerUp(e: FederatedPointerEvent): void {
    if (!refDrag) return;
    const finished = refDrag;
    refDrag = null;
    destroyGhost();
    if (!finished.moved) {
      onSeek?.(finished.seg.start);
      return;
    }
    const target = hitDropTarget(e.global);
    if (target === "cut-list") onCreateCutSegment?.(finished.seg.start, finished.seg.end);
    else if (target === "audio-clips") onCreateAudioClip?.(finished.seg.start, finished.seg.end);
  }

  // hover (no active drag) — mirrors cut-segments-track.ts's/
  // audio-clips-track.ts's own hover handling, independent of the drag
  // gesture above.
  function onReferenceTrackPointerMove(e: FederatedPointerEvent): void {
    if (refDrag) return;
    const local = e.getLocalPosition(timeline.referenceHitArea);
    const seg = hitTestReferenceEntry(local.x);
    timeline.referenceHitArea.cursor = seg ? "grab" : "default";
    if (sameSegment(seg, hoveredSeg)) return;
    hoveredSeg = seg;
    redrawSegments();
  }

  function onReferenceTrackPointerOut(): void {
    if (refDrag) return;
    timeline.referenceHitArea.cursor = "default";
    if (!hoveredSeg) return;
    hoveredSeg = null;
    redrawSegments();
  }

  timeline.referenceHitArea.on("pointerdown", onReferencePointerDown);
  timeline.referenceHitArea.on("globalpointermove", onGlobalPointerMove);
  timeline.referenceHitArea.on("pointerup", onGlobalPointerUp);
  timeline.referenceHitArea.on("pointerupoutside", onGlobalPointerUp);
  timeline.referenceHitArea.on("pointermove", onReferenceTrackPointerMove);
  timeline.referenceHitArea.on("pointerout", onReferenceTrackPointerOut);

  // right-click anywhere on the reference row (content area AND label
  // column) opens the speaker popover — `expandingPanel` is declared
  // further down, but this handler only reads it once actually invoked,
  // well after the whole function has finished initializing (same pattern
  // the caret button's own handler already relies on).
  function openSpeakerPopoverFromRightClick(e: FederatedPointerEvent): void {
    e.stopPropagation();
    expandingPanel.toggle();
    if (expandingPanel.isOpen) refreshPanel();
  }
  timeline.referenceHitArea.on("rightclick", openSpeakerPopoverFromRightClick);
  // the canvas has no other use for a native context menu (this is a fully
  // custom-rendered pixi surface) — suppress it everywhere so right-click
  // reads as "open the speaker popover" instead of flashing the browser's
  // own menu first.
  function onCanvasContextMenu(e: MouseEvent): void {
    e.preventDefault();
  }
  canvasElement.addEventListener("contextmenu", onCanvasContextMenu);

  // -- reference-row label column ------------------------------------------------
  // two separate buttons, mirroring `video-timeline.ts`'s own CUT LIST /
  // AUDIO CLIPS labels: (1) the whole column (including its "REFERENCE"
  // text) toggles the segments panel's "reference" source, (2) a bigger,
  // caret-only button at the column's right edge opens the
  // speaker-visibility popover — layered on top so its own smaller hit area
  // intercepts clicks before they reach the column-wide toggle underneath.
  // right-click anywhere in the column (either button) also opens the
  // popover, matching the content area's own right-click handler above.

  const visibilityToggle = new Container();
  visibilityToggle.eventMode = "static";
  visibilityToggle.cursor = "pointer";
  visibilityToggle.hitArea = new Rectangle(0, 0, TRACK_LABEL_COLUMN_WIDTH, REFERENCE_TRACK_HEIGHT);
  timeline.referenceLabelLayer.addChild(visibilityToggle);

  const visibilityBg = new Graphics();
  const visibilityLabel = new Text({
    text: "REFERENCE",
    style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: 0x888888, letterSpacing: 0.3 },
    resolution: TEXT_RESOLUTION,
  });
  visibilityLabel.anchor.set(0, 0.5);
  visibilityLabel.x = 8;
  visibilityLabel.y = REFERENCE_TRACK_HEIGHT / 2;
  visibilityToggle.addChild(visibilityBg, visibilityLabel);

  function drawVisibilityToggle(hover: boolean): void {
    const active = isReferenceActive?.() ?? false;
    visibilityBg.clear();
    if (active) {
      visibilityBg
        .roundRect(2, 2, TRACK_LABEL_COLUMN_WIDTH - 6, REFERENCE_TRACK_HEIGHT - 4, 3)
        .fill({ color: 0x3a1a30, alpha: 0.85 });
    } else if (hover) {
      visibilityBg
        .roundRect(2, 2, TRACK_LABEL_COLUMN_WIDTH - 6, REFERENCE_TRACK_HEIGHT - 4, 3)
        .stroke({ width: 1, color: 0x444444 });
    }
    visibilityLabel.style.fill = active ? 0xf5b8e8 : 0x888888;
  }
  drawVisibilityToggle(false);
  visibilityToggle.on("pointerover", () => drawVisibilityToggle(true));
  visibilityToggle.on("pointerout", () => drawVisibilityToggle(false));
  visibilityToggle.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onToggleVisible?.();
    drawVisibilityToggle(false);
  });
  visibilityToggle.on("rightclick", openSpeakerPopoverFromRightClick);

  const CARET_BUTTON_SIZE = 24;
  const caretButton = new Container();
  caretButton.eventMode = "static";
  caretButton.cursor = "pointer";
  caretButton.hitArea = new Rectangle(0, 0, CARET_BUTTON_SIZE, CARET_BUTTON_SIZE);
  caretButton.x = TRACK_LABEL_COLUMN_WIDTH - CARET_BUTTON_SIZE - 2;
  caretButton.y = (REFERENCE_TRACK_HEIGHT - CARET_BUTTON_SIZE) / 2;
  timeline.referenceLabelLayer.addChild(caretButton);

  const caretBg = new Graphics();
  const caret = new Graphics();
  caretButton.addChild(caretBg, caret);

  function drawCaretButton(hover: boolean): void {
    const caretW = 10;
    const caretH = 7;
    const cx = CARET_BUTTON_SIZE / 2;
    const cy = CARET_BUTTON_SIZE / 2;
    caret
      .clear()
      .moveTo(cx - caretW / 2, cy - caretH / 2)
      .lineTo(cx + caretW / 2, cy - caretH / 2)
      .lineTo(cx, cy + caretH / 2)
      .closePath()
      .fill({ color: 0xaaaaaa });
    caretBg.clear();
    if (hover) {
      caretBg
        .roundRect(1, 1, CARET_BUTTON_SIZE - 2, CARET_BUTTON_SIZE - 2, 4)
        .fill({ color: 0x1a1a1a, alpha: 0.6 })
        .stroke({ width: 1, color: 0x555555 });
    }
  }
  drawCaretButton(false);
  caretButton.on("pointerover", () => drawCaretButton(true));
  caretButton.on("pointerout", () => drawCaretButton(false));
  caretButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    expandingPanel.toggle();
    if (expandingPanel.isOpen) refreshPanel();
  });
  caretButton.on("rightclick", openSpeakerPopoverFromRightClick);

  // -- speaker-visibility popover -------------------------------------------------


  const panel = new Container();
  const panelBg = new Graphics();
  panel.addChild(panelBg);

  const selectAllBtn = makeSecondaryButton("select all", () => {
    visibleSpeakers = new Set(knownSpeakers);
    onVisibleSpeakersChanged();
  });
  const clearAllBtn = makeSecondaryButton("clear all", () => {
    visibleSpeakers = new Set();
    onVisibleSpeakersChanged();
  });
  panel.addChild(selectAllBtn.container, clearAllBtn.container);

  // fixed y where the (scrollable) speaker row list starts, below the
  // select-all/clear-all header — the header never scrolls.
  const ROWS_AREA_Y = LABEL_PAD_X + HEADER_BTN_HEIGHT + LABEL_PAD_X;
  const ROWS_AREA_WIDTH = DIALOG_WIDTH - LABEL_PAD_X * 2;

  // the row list scrolls internally once there are more speakers than fit
  // in `overlayMaxHeight` — otherwise a long speaker list simply got
  // clipped by the widget's own bounds with no way to reach the rest.
  const scrollable: ScrollableContent = createScrollableContent(
    panel,
    canvasElement,
    LABEL_PAD_X,
    ROWS_AREA_Y,
    ROWS_AREA_WIDTH,
    Math.max(1, overlayMaxHeight - ROWS_AREA_Y - LABEL_PAD_X),
  );

  const emptyText = new Text({
    text: "no diarization data found for this video",
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      fill: 0x888888,
      wordWrap: true,
      wordWrapWidth: ROWS_AREA_WIDTH,
    },
    resolution: TEXT_RESOLUTION,
  });
  scrollable.content.addChild(emptyText);

  interface SpeakerRow {
    container: Container;
    bg: Graphics;
    checkbox: Graphics;
    swatch: Graphics;
    label: Text;
  }
  const rowPool: SpeakerRow[] = [];

  function rowAt(i: number): SpeakerRow {
    while (rowPool.length <= i) {
      const container = new Container();
      container.eventMode = "static";
      container.cursor = "pointer";
      const bg = new Graphics();
      const checkbox = new Graphics();
      const swatch = new Graphics();
      const label = new Text({
        text: "",
        style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0xdddddd },
        resolution: TEXT_RESOLUTION,
      });
      container.addChild(bg, checkbox, swatch, label);
      scrollable.content.addChild(container);
      rowPool.push({ container, bg, checkbox, swatch, label });
    }
    return rowPool[i];
  }

  function onVisibleSpeakersChanged(): void {
    persistVisibility();
    redrawSegments();
    refreshPanel();
  }

  function refreshPanel(): void {
    const speakers = getReferenceSpeakers();
    const labels = Object.keys(speakers).sort();
    knownSpeakers = labels;

    const w = DIALOG_WIDTH;
    const btnW = (w - LABEL_PAD_X * 2 - HEADER_BTN_GAP) / 2;
    selectAllBtn.draw(btnW);
    clearAllBtn.draw(btnW);
    selectAllBtn.container.x = LABEL_PAD_X;
    selectAllBtn.container.y = LABEL_PAD_X;
    clearAllBtn.container.x = LABEL_PAD_X + btnW + HEADER_BTN_GAP;
    clearAllBtn.container.y = LABEL_PAD_X;

    emptyText.visible = labels.length === 0;
    emptyText.x = 0;
    emptyText.y = 0;

    labels.forEach((label, i) => {
      const row = rowAt(i);
      row.container.visible = true;
      row.container.x = 0;
      row.container.y = i * ROW_HEIGHT;
      row.container.hitArea = new Rectangle(0, 0, ROWS_AREA_WIDTH, ROW_HEIGHT);

      const checked = visibleSpeakers.has(label);
      row.checkbox.clear();
      row.checkbox
        .roundRect(0, (ROW_HEIGHT - 14) / 2, 14, 14, 3)
        .fill({ color: checked ? MAGENTA : 0x1a1a1a })
        .stroke({ width: 1, color: checked ? MAGENTA : 0x555555 });
      if (checked) {
        row.checkbox
          .moveTo(3, ROW_HEIGHT / 2)
          .lineTo(6, ROW_HEIGHT / 2 + 3)
          .lineTo(11, ROW_HEIGHT / 2 - 4)
          .stroke({ width: 1.5, color: 0xffffff });
      }

      const color = speakers[label]?.color ?? 0x60a5fa;
      row.swatch.clear().roundRect(22, (ROW_HEIGHT - 10) / 2, 10, 10, 2).fill({ color });

      row.label.text = label;
      row.label.x = 40;
      row.label.y = (ROW_HEIGHT - row.label.height) / 2;

      row.bg.clear();
      row.container.off("pointerover").on("pointerover", () => {
        row.bg.clear().rect(0, 0, ROWS_AREA_WIDTH, ROW_HEIGHT).fill({ color: 0x2c2c2c });
      });
      row.container.off("pointerout").on("pointerout", () => row.bg.clear());
      row.container.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        if (visibleSpeakers.has(label)) visibleSpeakers.delete(label);
        else visibleSpeakers.add(label);
        onVisibleSpeakersChanged();
      });
    });
    for (let i = labels.length; i < rowPool.length; i++) rowPool[i].container.visible = false;

    const rowsContentHeight = labels.length > 0 ? labels.length * ROW_HEIGHT : emptyText.height;
    const maxRowsAreaHeight = Math.max(0, overlayMaxHeight - ROWS_AREA_Y - LABEL_PAD_X);
    const rowsAreaHeight = Math.min(rowsContentHeight, maxRowsAreaHeight);
    scrollable.resize(ROWS_AREA_WIDTH, Math.max(1, rowsAreaHeight));
    scrollable.reflow(ROWS_AREA_WIDTH, rowsContentHeight);

    const panelHeight = ROWS_AREA_Y + rowsAreaHeight + LABEL_PAD_X;

    panelBg.clear();
    panelBg.roundRect(0, 0, w, panelHeight, 6).fill({ color: 0x1e1e1e }).stroke({ width: 1, color: 0x333333 });

    panel.x = LABEL_PAD_X;
    panel.y = REFERENCE_TRACK_HEIGHT + 4;

    expandingPanel.resize(contentWidth, overlayMaxHeight);
  }

  const expandingPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent,
    panel,
    onOpenChange: (open) => {
      if (open) refreshPanel();
    },
  });

  redrawSegments();

  return {
    refresh() {
      redrawSegments();
      if (expandingPanel.isOpen) refreshPanel();
    },

    resize(newContentWidth: number) {
      contentWidth = Math.max(0, newContentWidth);
      redrawSegments();
      if (expandingPanel.isOpen) refreshPanel();
    },

    destroy() {
      offViewChange();
      timeline.referenceHitArea.off("pointerdown", onReferencePointerDown);
      timeline.referenceHitArea.off("globalpointermove", onGlobalPointerMove);
      timeline.referenceHitArea.off("pointerup", onGlobalPointerUp);
      timeline.referenceHitArea.off("pointerupoutside", onGlobalPointerUp);
      timeline.referenceHitArea.off("pointermove", onReferenceTrackPointerMove);
      timeline.referenceHitArea.off("pointerout", onReferenceTrackPointerOut);
      timeline.referenceHitArea.off("rightclick");
      canvasElement.removeEventListener("contextmenu", onCanvasContextMenu);
      destroyGhost();
      scrollable.destroy();
      expandingPanel.destroy();
      visibilityToggle.destroy({ children: true });
      caretButton.destroy({ children: true });
      segmentPool.forEach((g) => g.destroy());
    },
  };
}

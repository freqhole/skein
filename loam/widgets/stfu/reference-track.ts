/**
 * stfu's reference/diarization track — one instance per `ReferenceTrack`
 * (see `reference-dialog.ts`'s speaker grouping), each rendering only its
 * own members' colored segments (once reference data has been loaded, see
 * `reference-data.ts` + the "load reference data..." widget action in
 * `index.ts`) into its own stacked row —
 * `video-timeline.ts`'s `VideoTimelineHandle.getReferenceRow(index)`. the
 * row's label column hosts two separate buttons: the whole column toggles
 * the segments panel's "reference" source (mirrors the CUT LIST/AUDIO
 * CLIPS labels in `video-timeline.ts`), and a bigger caret-only button
 * opens the reference dialog (`reference-dialog.ts`, also reachable via
 * right-click anywhere on the row) — this track only draws segments and
 * owns the row's own buttons/drag gestures; all speaker-grouping/
 * visibility UI lives in that separate, centered, full-widget dialog
 * instead.
 *
 * this track needs zero reference data to mount cleanly — an empty track
 * row is a valid state.
 */

import { Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from "pixi.js";
import {
  AUDIO_CLIP_TRACK_HEIGHT,
  CUT_TRACK_HEIGHT,
  REFERENCE_TRACK_HEIGHT,
  TRACK_LABEL_COLUMN_WIDTH,
  type ReferenceRowHandle,
  type VideoTimelineHandle,
} from "./video-timeline";
import { resolveReferenceTrackId, type ReferenceSpeaker, type ReferenceTrack, type TranscriptSegment } from "./types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

const MARGIN_Y = 4;

export interface ReferenceTrackOptions {
  timeline: VideoTimelineHandle;
  /** which `ReferenceTrack` this row instance renders — only segments
   *  whose speaker resolves to this track id (via `resolveReferenceTrackId`)
   *  are drawn/draggable here. */
  trackId: string;
  /** the stacked row (layers + hit area) this instance should draw into —
   *  obtained via `timeline.getReferenceRow(rowIndex)` after the caller has
   *  already called `timeline.setReferenceRowCount()` for the current
   *  number of reference tracks. */
  row: ReferenceRowHandle;
  /** the row's own label text — reference-dialog.ts's own fallback
   *  (`track.label || "track N"`) for a mult-track doc, or "REFERENCE" for
   *  the single-track case. re-read on every `refresh()` so a rename in
   *  the dialog shows up here too. */
  getTrackLabel: () => string;
  /** canvas element the widget is rendered on — used only to suppress the
   *  browser's native context menu on right-click (see below). */
  canvasElement: HTMLCanvasElement;
  getReferenceSpeakers: () => Record<string, ReferenceSpeaker>;
  getReferenceTracks: () => ReferenceTrack[];
  getTranscriptSegments: () => TranscriptSegment[];
  /** whether a speaker's segments should currently be drawn/draggable — the
   *  reference dialog (`reference-dialog.ts`) owns this preference (and its
   *  localStorage persistence); this track just reads it. */
  isSpeakerVisible: (label: string) => boolean;
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
  /** opens the reference dialog (`reference-dialog.ts`) — wired to the
   *  caret button, right-click, and the label column's own right-click. */
  onOpenDialog?: () => void;
}

export interface ReferenceTrackHandle {
  /** re-draw segment graphics — call after `referenceSpeakers`/
   *  `transcriptSegments` change for any reason. */
  refresh(): void;
  /** call whenever the widget's own width changes. */
  resize(contentWidth: number): void;
  destroy(): void;
}

export function createReferenceTrack(options: ReferenceTrackOptions): ReferenceTrackHandle {
  const {
    timeline,
    trackId,
    row,
    getTrackLabel,
    canvasElement,
    getReferenceSpeakers,
    getReferenceTracks,
    getTranscriptSegments,
    isSpeakerVisible,
    onCreateCutSegment,
    onCreateAudioClip,
    onSeek,
    onToggleVisible,
    isReferenceActive,
    onOpenDialog,
  } = options;

  let contentWidth = 0;
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

  /** whether `seg` belongs on *this* row — its speaker must both be visible
   *  (the dialog's per-speaker preference) AND resolve (via
   *  `resolveReferenceTrackId`) to this row's own `trackId`. */
  function segmentBelongsHere(seg: TranscriptSegment): boolean {
    if (!seg.speaker || !isSpeakerVisible(seg.speaker)) return false;
    const speaker = getReferenceSpeakers()[seg.speaker];
    if (!speaker) return false;
    return resolveReferenceTrackId(speaker, getReferenceTracks()) === trackId;
  }

  // -- segment graphics (pooled, redrawn from scratch on every refresh) --------

  const segmentPool: Graphics[] = [];

  function segmentGraphicsAt(i: number): Graphics {
    while (segmentPool.length <= i) {
      const g = new Graphics();
      // purely visual — see cut-segments-track.ts's `g.eventMode` comment.
      g.eventMode = "none";
      row.contentLayer.addChild(g);
      segmentPool.push(g);
    }
    return segmentPool[i];
  }

  function redrawSegments(): void {
    const speakers = getReferenceSpeakers();
    const segments = getTranscriptSegments();

    let i = 0;
    for (const seg of segments) {
      if (!segmentBelongsHere(seg)) continue;
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
      if (!segmentBelongsHere(seg)) continue;
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
    const local = e.getLocalPosition(row.hitArea);
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
      // `timeToScreenX()` is in `row.contentLayer`'s own local frame,
      // not `timeline.container`'s (the ghost's parent) — bridge the two via
      // pixi's own transform chain rather than assuming a fixed offset
      // between them.
      const topLeftGlobal = row.contentLayer.toGlobal({ x: x1, y: 0 });
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
    const local = e.getLocalPosition(row.hitArea);
    const seg = hitTestReferenceEntry(local.x);
    row.hitArea.cursor = seg ? "grab" : "default";
    if (sameSegment(seg, hoveredSeg)) return;
    hoveredSeg = seg;
    redrawSegments();
  }

  function onReferenceTrackPointerOut(): void {
    if (refDrag) return;
    row.hitArea.cursor = "default";
    if (!hoveredSeg) return;
    hoveredSeg = null;
    redrawSegments();
  }

  row.hitArea.on("pointerdown", onReferencePointerDown);
  row.hitArea.on("globalpointermove", onGlobalPointerMove);
  row.hitArea.on("pointerup", onGlobalPointerUp);
  row.hitArea.on("pointerupoutside", onGlobalPointerUp);
  row.hitArea.on("pointermove", onReferenceTrackPointerMove);
  row.hitArea.on("pointerout", onReferenceTrackPointerOut);

  // right-click anywhere on the reference row (content area AND label
  // column) opens the reference dialog.
  function openReferenceDialogFromRightClick(e: FederatedPointerEvent): void {
    e.stopPropagation();
    onOpenDialog?.();
  }
  row.hitArea.on("rightclick", openReferenceDialogFromRightClick);
  // the canvas has no other use for a native context menu (this is a fully
  // custom-rendered pixi surface) — suppress it everywhere so right-click
  // reads as "open the reference dialog" instead of flashing the browser's
  // own menu first.
  function onCanvasContextMenu(e: MouseEvent): void {
    e.preventDefault();
  }
  canvasElement.addEventListener("contextmenu", onCanvasContextMenu);

  // -- reference-row label column ------------------------------------------------
  // two separate buttons, mirroring `video-timeline.ts`'s own CUT LIST /
  // AUDIO CLIPS labels: (1) the whole column (including its "REFERENCE"
  // text) toggles the segments panel's "reference" source, (2) a bigger,
  // caret-only button at the column's right edge opens the reference
  // dialog — layered on top so its own smaller hit area intercepts clicks
  // before they reach the column-wide toggle underneath. right-click
  // anywhere in the column (either button) also opens the dialog, matching
  // the content area's own right-click handler above.

  const visibilityToggle = new Container();
  visibilityToggle.eventMode = "static";
  visibilityToggle.cursor = "pointer";
  visibilityToggle.hitArea = new Rectangle(0, 0, TRACK_LABEL_COLUMN_WIDTH, REFERENCE_TRACK_HEIGHT);
  row.labelLayer.addChild(visibilityToggle);

  const visibilityBg = new Graphics();
  const visibilityLabel = new Text({
    text: getTrackLabel(),
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
  visibilityToggle.on("rightclick", openReferenceDialogFromRightClick);

  const CARET_BUTTON_SIZE = 24;
  const caretButton = new Container();
  caretButton.eventMode = "static";
  caretButton.cursor = "pointer";
  caretButton.hitArea = new Rectangle(0, 0, CARET_BUTTON_SIZE, CARET_BUTTON_SIZE);
  caretButton.x = TRACK_LABEL_COLUMN_WIDTH - CARET_BUTTON_SIZE - 2;
  caretButton.y = (REFERENCE_TRACK_HEIGHT - CARET_BUTTON_SIZE) / 2;
  row.labelLayer.addChild(caretButton);

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
    onOpenDialog?.();
  });
  caretButton.on("rightclick", openReferenceDialogFromRightClick);

  redrawSegments();

  return {
    refresh() {
      visibilityLabel.text = getTrackLabel();
      redrawSegments();
    },

    resize(newContentWidth: number) {
      contentWidth = Math.max(0, newContentWidth);
      redrawSegments();
    },

    destroy() {
      offViewChange();
      row.hitArea.off("pointerdown", onReferencePointerDown);
      row.hitArea.off("globalpointermove", onGlobalPointerMove);
      row.hitArea.off("pointerup", onGlobalPointerUp);
      row.hitArea.off("pointerupoutside", onGlobalPointerUp);
      row.hitArea.off("pointermove", onReferenceTrackPointerMove);
      row.hitArea.off("pointerout", onReferenceTrackPointerOut);
      row.hitArea.off("rightclick");
      canvasElement.removeEventListener("contextmenu", onCanvasContextMenu);
      destroyGhost();
      visibilityToggle.destroy({ children: true });
      caretButton.destroy({ children: true });
      segmentPool.forEach((g) => g.destroy());
    },
  };
}


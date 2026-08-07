/**
 * stfu's cut-segments track — create/drag/trim/delete editable cut regions
 * (`editableSegments`) drawn against `video-timeline.ts`'s camera. ports the
 * _design_ (not the code) of trek-minus-paris's `editor.js` edit track: click
 * empty space to start a new segment, drag a segment's body to move it, drag
 * near an edge to trim it, click its delete glyph to remove it. snaps to
 * other segments' own start/end times while dragging/trimming/creating —
 * this track needs zero reference data to be fully usable.
 *
 * all geometry is computed in screen px from scratch on every redraw (via
 * `timeline.timeToScreenX()`/`screenXToTime()`) rather than riding a scaled
 * pixi transform — see `video-timeline.ts`'s `trackContentLayer` doc comment
 * for why. redraws happen on every camera change (pan/zoom/resize) and
 * whenever the underlying segments array changes.
 */

import type { FederatedPointerEvent } from "pixi.js";
import { Graphics } from "pixi.js";
import { CUT_TRACK_HEIGHT, type VideoTimelineHandle } from "./video-timeline";

export type EditableSegment = [number, number];

const MARGIN_Y = 3;
const HANDLE_PX = 6; // screen px near a segment's edge that counts as a trim grab, not a move
const DELETE_GLYPH_SIZE = 12;
const SNAP_PX = 8; // screen px within which a dragged/created edge snaps to another segment's edge
const MIN_SEGMENT_SEC = 0.05;
const DRAG_THRESHOLD_PX = 3; // pointer movement past this counts as a drag, not a click

type DragMode = "create" | "move" | "resize-left" | "resize-right";

interface DragState {
  mode: DragMode;
  /** index into the committed segments array; -1 while creating a new one. */
  index: number;
  startClientX: number;
  startSeg: EditableSegment;
  /** live (possibly unordered/unclamped) value tracked across pointermove,
   *  finalized (ordered + clamped) into the committed array on pointerup. */
  pending: EditableSegment;
  moved: boolean;
}

export interface CutSegmentsTrackOptions {
  timeline: VideoTimelineHandle;
  getSegments: () => EditableSegment[];
  /** called with the full next array whenever a create/move/trim/delete
   *  completes — the caller persists it (e.g. into the widget's automerge
   *  doc) and should call `refresh()` once that lands. */
  onChange: (next: EditableSegment[]) => void;
  getDuration: () => number;
}

export interface CutSegmentsTrackHandle {
  /** re-draw all segment graphics — call after the segments array changes
   *  for any reason (this track's own `onChange`, or a remote peer's edit
   *  landing via the doc's change subscription). */
  refresh(): void;
  destroy(): void;
}

export function createCutSegmentsTrack(options: CutSegmentsTrackOptions): CutSegmentsTrackHandle {
  const { timeline, getSegments, onChange, getDuration } = options;

  const rows: Graphics[] = []; // parallel to getSegments(), rebuilt each refresh()
  let createPreviewRow: Graphics | null = null;
  let drag: DragState | null = null;

  function pxPerSecond(): number {
    return timeline.timeToScreenX(1) - timeline.timeToScreenX(0);
  }

  function snapTime(t: number, excludeIndex: number): number {
    const pps = pxPerSecond();
    if (pps <= 0) return t;
    const toleranceSec = SNAP_PX / pps;
    let best = t;
    let bestDelta = toleranceSec;
    getSegments().forEach((seg, i) => {
      if (i === excludeIndex) return;
      for (const edge of seg) {
        const delta = Math.abs(edge - t);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = edge;
        }
      }
    });
    return best;
  }

  function clampSegment(seg: EditableSegment): EditableSegment {
    const duration = getDuration();
    let [start, end] = seg;
    if (end < start) [start, end] = [end, start];
    start = Math.max(0, start);
    end = duration > 0 ? Math.min(duration, end) : end;
    if (end - start < MIN_SEGMENT_SEC) end = start + MIN_SEGMENT_SEC;
    return [start, end];
  }

  function drawDeleteGlyph(g: Graphics, right: number): void {
    const size = DELETE_GLYPH_SIZE;
    const pad = 2;
    g.rect(right - size - pad, pad, size, size).fill({ color: 0x3a1a2a });
    const cx = right - size / 2 - pad;
    const cy = pad + size / 2;
    const r = size / 2 - 3;
    g.moveTo(cx - r, cy - r)
      .lineTo(cx + r, cy + r)
      .moveTo(cx + r, cy - r)
      .lineTo(cx - r, cy + r)
      .stroke({ width: 1.5, color: 0xe08080 });
  }

  function drawSegment(g: Graphics, seg: EditableSegment, hovered: boolean): void {
    g.clear();
    const x1 = timeline.timeToScreenX(seg[0]);
    const x2 = timeline.timeToScreenX(seg[1]);
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const width = Math.max(1, right - left);
    const top = MARGIN_Y;
    const height = CUT_TRACK_HEIGHT - MARGIN_Y * 2;
    g.roundRect(left, top, width, height, 3).fill({ color: hovered ? 0x5a2a4a : 0x4a1a3a });
    g.roundRect(left, top, width, height, 3).stroke({ color: 0xd946ef, width: 1 });
    if (hovered && width > DELETE_GLYPH_SIZE + 8) {
      drawDeleteGlyph(g, right);
    }
  }

  function hitDeleteGlyph(seg: EditableSegment, localX: number, localY: number): boolean {
    const x1 = timeline.timeToScreenX(seg[0]);
    const x2 = timeline.timeToScreenX(seg[1]);
    const right = Math.max(x1, x2);
    const size = DELETE_GLYPH_SIZE;
    const pad = 2;
    return localX >= right - size - pad && localX <= right - pad && localY >= pad && localY <= pad + size;
  }

  function modeForLocalX(seg: EditableSegment, localX: number): DragMode {
    const x1 = timeline.timeToScreenX(seg[0]);
    const x2 = timeline.timeToScreenX(seg[1]);
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    if (Math.abs(localX - left) <= HANDLE_PX) return "resize-left";
    if (Math.abs(localX - right) <= HANDLE_PX) return "resize-right";
    return "move";
  }

  function commit(next: EditableSegment[]): void {
    onChange(next);
    refresh();
  }

  function onTrackPointerDown(e: FederatedPointerEvent): void {
    const local = e.getLocalPosition(timeline.trackHitArea);
    const segments = getSegments();
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      const x1 = timeline.timeToScreenX(seg[0]);
      const x2 = timeline.timeToScreenX(seg[1]);
      const left = Math.min(x1, x2) - HANDLE_PX;
      const right = Math.max(x1, x2) + HANDLE_PX;
      if (local.x < left || local.x > right) continue;
      if (hitDeleteGlyph(seg, local.x, local.y)) {
        commit(segments.filter((_, idx) => idx !== i));
        return;
      }
      drag = {
        mode: modeForLocalX(seg, local.x),
        index: i,
        startClientX: e.global.x,
        startSeg: [...seg],
        pending: [...seg],
        moved: false,
      };
      return;
    }
    // empty space — anchor a new segment at the click point; it grows as the pointer moves
    const t = timeline.screenXToTime(local.x);
    drag = { mode: "create", index: -1, startClientX: e.global.x, startSeg: [t, t], pending: [t, t], moved: false };
  }

  function onGlobalPointerMove(e: FederatedPointerEvent): void {
    if (!drag) return;
    const deltaPx = e.global.x - drag.startClientX;
    if (!drag.moved && Math.abs(deltaPx) <= DRAG_THRESHOLD_PX) return;
    drag.moved = true;

    const pps = pxPerSecond();
    const deltaSec = pps > 0 ? deltaPx / pps : 0;

    if (drag.mode === "create") {
      drag.pending = [drag.startSeg[0], drag.startSeg[0] + deltaSec];
      if (!createPreviewRow) {
        createPreviewRow = new Graphics();
        timeline.trackContentLayer.addChild(createPreviewRow);
      }
      drawSegment(createPreviewRow, clampSegment(drag.pending), true);
      return;
    }

    const row = rows[drag.index];
    if (drag.mode === "move") {
      const dur = drag.startSeg[1] - drag.startSeg[0];
      const movedStart = drag.startSeg[0] + deltaSec;
      const snappedStart = snapTime(movedStart, drag.index);
      let start = snappedStart;
      if (snappedStart === movedStart) {
        const movedEnd = drag.startSeg[1] + deltaSec;
        const snappedEnd = snapTime(movedEnd, drag.index);
        if (snappedEnd !== movedEnd) start = snappedEnd - dur;
      }
      drag.pending = [start, start + dur];
    } else if (drag.mode === "resize-left") {
      drag.pending = [snapTime(drag.startSeg[0] + deltaSec, drag.index), drag.startSeg[1]];
    } else {
      drag.pending = [drag.startSeg[0], snapTime(drag.startSeg[1] + deltaSec, drag.index)];
    }
    if (row) drawSegment(row, clampSegment(drag.pending), true);
  }

  function onGlobalPointerUp(): void {
    if (!drag) return;
    const finished = drag;
    drag = null;

    if (!finished.moved) {
      refresh(); // clears any stray hover state, no-op for the data itself
      return;
    }

    if (finished.mode === "create") {
      const clamped = clampSegment(finished.pending);
      if (clamped[1] - clamped[0] >= MIN_SEGMENT_SEC) {
        commit([...getSegments(), clamped]);
      } else {
        refresh();
      }
      return;
    }

    const segments = [...getSegments()];
    segments[finished.index] = clampSegment(finished.pending);
    commit(segments);
  }

  timeline.trackHitArea.eventMode = "static";
  timeline.trackHitArea.on("pointerdown", onTrackPointerDown);
  timeline.trackHitArea.on("globalpointermove", onGlobalPointerMove);
  timeline.trackHitArea.on("pointerup", onGlobalPointerUp);
  timeline.trackHitArea.on("pointerupoutside", onGlobalPointerUp);

  const offViewChange = timeline.onViewChange(() => refresh());

  function refresh(): void {
    createPreviewRow?.destroy();
    createPreviewRow = null;

    const segments = getSegments();
    while (rows.length > segments.length) {
      rows.pop()?.destroy();
    }
    while (rows.length < segments.length) {
      const g = new Graphics();
      timeline.trackContentLayer.addChild(g);
      rows.push(g);
    }
    segments.forEach((seg, i) => drawSegment(rows[i], seg, false));
  }

  refresh();

  return {
    refresh,
    destroy() {
      offViewChange();
      timeline.trackHitArea.off("pointerdown", onTrackPointerDown);
      timeline.trackHitArea.off("globalpointermove", onGlobalPointerMove);
      timeline.trackHitArea.off("pointerup", onGlobalPointerUp);
      timeline.trackHitArea.off("pointerupoutside", onGlobalPointerUp);
      createPreviewRow?.destroy();
      createPreviewRow = null;
      rows.forEach((g) => g.destroy());
      rows.length = 0;
    },
  };
}

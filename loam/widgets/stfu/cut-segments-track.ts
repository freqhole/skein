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
const HANDLE_PX = 8; // screen px near a segment's edge that counts as a trim grab, not a move
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
  /** extra snap targets (seconds) placement should stick to besides other
   *  segments' own edges — e.g. the reference/diarization track's segment
   *  edges and the current playhead position, matching editor.js's
   *  `maybeSnap()` (which snaps to the playhead or any visible reference
   *  segment's edge, not just other cut-list segments). */
  getSnapTimes?: () => number[];
  /** called whenever the selected segment changes (including to `null`,
   *  e.g. on delete or a click on empty space) — the caller uses this to
   *  drive UI that depends on "which segment would keyboard shortcuts like
   *  `[`/`]` affect", e.g. highlighting/scrolling the matching row in the
   *  segments panel. */
  onSelectionChange?: (seg: EditableSegment | null) => void;
}

export interface CutSegmentsTrackHandle {
  /** re-draw all segment graphics — call after the segments array changes
   *  for any reason (this track's own `onChange`, or a remote peer's edit
   *  landing via the doc's change subscription). */
  refresh(): void;
  destroy(): void;
}

export function createCutSegmentsTrack(options: CutSegmentsTrackOptions): CutSegmentsTrackHandle {
  const { timeline, getSegments, onChange, getDuration, getSnapTimes, onSelectionChange } = options;

  const rows: Graphics[] = []; // parallel to getSegments(), rebuilt each refresh()
  let createPreviewRow: Graphics | null = null;
  let drag: DragState | null = null;
  /** index of the segment currently hovered (no active drag) — drives the
   *  delete-glyph/highlight visibility and cursor, matching editor.js's
   *  `wireTrackInteraction()` "globalpointermove" hover handling (which is
   *  independent of any active drag). */
  let hoveredIndex: number | null = null;
  /** which region of `hoveredIndex` is hovered — used to render a visual
   *  resize-handle affordance (see `drawSegment()`'s white left-edge
   *  stripe) instead of relying solely on the CSS cursor, which is
   *  unreliable in Safari/WebKit for canvas elements. */
  let hoveredRegion: "delete" | DragMode | null = null;
  /** the segment the user last clicked/dragged — shown with a white
   *  outline so it's clear which segment keyboard shortcuts (e.g. `[`/`]`)
   *  would affect; also drives the segments panel's row highlight via
   *  `onSelectionChange`. */
  let selectedIndex: number | null = null;

  function pxPerSecond(): number {
    return timeline.timeToScreenX(1) - timeline.timeToScreenX(0);
  }

  function snapTime(t: number, excludeIndex: number): number {
    if (!timeline.isSnapEnabled()) return t;
    const pps = pxPerSecond();
    if (pps <= 0) return t;
    const toleranceSec = SNAP_PX / pps;
    let best = t;
    let bestDelta = toleranceSec;
    const consider = (edge: number) => {
      const delta = Math.abs(edge - t);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = edge;
      }
    };
    getSegments().forEach((seg, i) => {
      if (i === excludeIndex) return;
      seg.forEach(consider);
    });
    (getSnapTimes?.() ?? []).forEach(consider);
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

  // circular glyph + hit test (matches editor.js's `drawDeleteGlyph()`/
  // inline delete hit-test exactly) rather than a square — a square's
  // corners reach ~40% farther from center than a circle of the same
  // "radius", which was silently poaching clicks meant for a resize-right
  // drag just below the glyph's own row.
  function drawDeleteGlyph(g: Graphics, right: number): void {
    const cx = right - 2;
    const cy = MARGIN_Y;
    g.circle(cx, cy, 7).fill({ color: 0x000000, alpha: 0.75 });
    const r = 2.6;
    g.moveTo(cx - r, cy - r)
      .lineTo(cx + r, cy + r)
      .moveTo(cx + r, cy - r)
      .lineTo(cx - r, cy + r)
      .stroke({ width: 1.3, color: 0xe08080 });
  }

  function drawSegment(
    g: Graphics,
    seg: EditableSegment,
    hovered: boolean,
    hoveredRegion: "delete" | DragMode | null,
    selected: boolean
  ): void {
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
    if (hovered && hoveredRegion === "resize-left") {
      // the CSS cursor swap (`cursorForRegion()`) is unreliable in
      // Safari/WebKit for canvas elements, so give a positive visual
      // affordance instead: paint the trim edge itself white.
      g.rect(left, top, 3, height).fill({ color: 0xffffff });
    } else if (hovered && hoveredRegion === "resize-right") {
      g.rect(right - 3, top, 3, height).fill({ color: 0xffffff });
    }
    if (selected) {
      g.roundRect(left - 1, top - 1, width + 2, height + 2, 3).stroke({ width: 2, color: 0xffffff });
    }
    // no width gate (matches editor.js, which shows/hit-tests its delete
    // glyph unconditionally on hover) — a previous width gate here hid
    // delete entirely on narrow/typical segments instead of fixing the
    // real overlap-with-resize-right cause, which is the circular hit test
    // above plus the adaptive handle sizing below.
    if (hovered) {
      drawDeleteGlyph(g, right);
    }
  }

  function hitDeleteGlyph(seg: EditableSegment, localX: number, localY: number): boolean {
    const x1 = timeline.timeToScreenX(seg[0]);
    const x2 = timeline.timeToScreenX(seg[1]);
    const right = Math.max(x1, x2);
    return Math.hypot(localX - (right - 2), localY - MARGIN_Y) <= 8;
  }

  function modeForLocalX(seg: EditableSegment, localX: number): DragMode {
    const x1 = timeline.timeToScreenX(seg[0]);
    const x2 = timeline.timeToScreenX(seg[1]);
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    // cap the resize-handle zone to a third of the segment's own width so a
    // narrow segment (common at typical zoom levels) still has a reachable
    // "move" region in the middle, rather than both edges' zones
    // overlapping and swallowing the whole segment — previously this always
    // favored resize-left (checked first), making "move"/"resize-right"
    // functionally unreachable on any segment narrower than ~16px.
    const handlePx = Math.max(2, Math.min(HANDLE_PX, (right - left) / 3));
    const distLeft = Math.abs(localX - left);
    const distRight = Math.abs(localX - right);
    if (distLeft <= handlePx && distLeft <= distRight) return "resize-left";
    if (distRight <= handlePx) return "resize-right";
    return "move";
  }

  /** resolves a point (in `timeline.trackHitArea`'s local space) to the
   *  topmost segment under it and which region of it was hit — shared by
   *  `onTrackPointerDown()` (click/drag-start) and the hover handler below
   *  (cursor + delete-glyph), matching editor.js's single `hitTestEditable()`
   *  used by both `wireTrackInteraction()`'s "pointerdown" and
   *  "globalpointermove" handlers. */
  function hitTest(localX: number, localY: number): { index: number; region: "delete" | DragMode } | null {
    const segments = getSegments();
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      const x1 = timeline.timeToScreenX(seg[0]);
      const x2 = timeline.timeToScreenX(seg[1]);
      const left = Math.min(x1, x2) - HANDLE_PX;
      const right = Math.max(x1, x2) + HANDLE_PX;
      if (localX < left || localX > right) continue;
      if (hitDeleteGlyph(seg, localX, localY)) return { index: i, region: "delete" };
      return { index: i, region: modeForLocalX(seg, localX) };
    }
    return null;
  }

  /** matches editor.js's `wireTrackInteraction()` cursor assignment:
   *  "pointer" over the delete glyph, "w-resize"/"e-resize" over a trim
   *  handle, "grab" over a segment's body, else "crosshair" (click empty
   *  space to start a new segment). */
  function cursorForRegion(region: "delete" | DragMode | null): string {
    switch (region) {
      case "delete":
        return "pointer";
      case "resize-left":
        return "w-resize";
      case "resize-right":
        return "e-resize";
      case "move":
        return "grab";
      default:
        return "crosshair";
    }
  }

  function setHoveredIndex(index: number | null, region: "delete" | DragMode | null = null): void {
    if (hoveredIndex === index && hoveredRegion === region) return;
    const segments = getSegments();
    if (hoveredIndex !== null && rows[hoveredIndex] && segments[hoveredIndex]) {
      drawSegment(rows[hoveredIndex], segments[hoveredIndex], false, null, hoveredIndex === selectedIndex);
    }
    hoveredIndex = index;
    hoveredRegion = region;
    if (hoveredIndex !== null && rows[hoveredIndex] && segments[hoveredIndex]) {
      drawSegment(rows[hoveredIndex], segments[hoveredIndex], true, hoveredRegion, hoveredIndex === selectedIndex);
    }
  }

  function setSelectedIndex(index: number | null): void {
    if (selectedIndex === index) return;
    const segments = getSegments();
    const prevIndex = selectedIndex;
    selectedIndex = index;
    if (prevIndex !== null && rows[prevIndex] && segments[prevIndex]) {
      drawSegment(rows[prevIndex], segments[prevIndex], prevIndex === hoveredIndex, hoveredRegion, false);
    }
    if (selectedIndex !== null && rows[selectedIndex] && segments[selectedIndex]) {
      drawSegment(
        rows[selectedIndex],
        segments[selectedIndex],
        selectedIndex === hoveredIndex,
        hoveredRegion,
        true
      );
    }
    onSelectionChange?.(selectedIndex !== null ? (segments[selectedIndex] ?? null) : null);
  }

  function commit(next: EditableSegment[]): void {
    onChange(next);
    refresh();
  }

  function onTrackPointerDown(e: FederatedPointerEvent): void {
    const local = e.getLocalPosition(timeline.trackHitArea);
    const hit = hitTest(local.x, local.y);
    if (hit) {
      if (hit.region === "delete") {
        commit(getSegments().filter((_, idx) => idx !== hit.index));
        setSelectedIndex(null);
        return;
      }
      // selecting happens at drag-start (not just on a plain click) so a
      // move/resize drag also marks its segment as the one keyboard
      // shortcuts would affect — matches the prototype's own behavior.
      setSelectedIndex(hit.index);
      const seg = getSegments()[hit.index];
      drag = {
        mode: hit.region,
        index: hit.index,
        startClientX: e.global.x,
        startSeg: [...seg],
        pending: [...seg],
        moved: false,
      };
      return;
    }
    // empty space — anchor a new segment at the click point; it grows as the pointer moves
    setSelectedIndex(null);
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
        createPreviewRow.eventMode = "none"; // purely visual — see trackRow's `g` fix.
        timeline.trackContentLayer.addChild(createPreviewRow);
      }
      drawSegment(createPreviewRow, clampSegment(drag.pending), true, null, false);
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
    const previewRegion = drag.mode === "resize-left" || drag.mode === "resize-right" ? drag.mode : null;
    if (row) drawSegment(row, clampSegment(drag.pending), true, previewRegion, true);
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

  // hover (no active drag) — matches editor.js's "globalpointermove" branch
  // taken when `drag` is null: updates the cursor + reveals the shared
  // delete glyph for whichever segment/region is under the pointer.
  function onTrackPointerMove(e: FederatedPointerEvent): void {
    if (drag) return; // an active drag already draws its own hover/preview state
    const local = e.getLocalPosition(timeline.trackHitArea);
    const hit = hitTest(local.x, local.y);
    setHoveredIndex(hit ? hit.index : null, hit ? hit.region : null);
    timeline.trackHitArea.cursor = cursorForRegion(hit ? hit.region : null);
  }

  function onTrackPointerOut(): void {
    if (drag) return;
    setHoveredIndex(null);
    timeline.trackHitArea.cursor = "crosshair";
  }

  timeline.trackHitArea.eventMode = "static";
  timeline.trackHitArea.cursor = "crosshair";
  timeline.trackHitArea.on("pointerdown", onTrackPointerDown);
  timeline.trackHitArea.on("globalpointermove", onGlobalPointerMove);
  timeline.trackHitArea.on("pointerup", onGlobalPointerUp);
  timeline.trackHitArea.on("pointerupoutside", onGlobalPointerUp);
  timeline.trackHitArea.on("pointermove", onTrackPointerMove);
  timeline.trackHitArea.on("pointerout", onTrackPointerOut);

  const offViewChange = timeline.onViewChange(() => refresh());

  function refresh(): void {
    createPreviewRow?.destroy();
    createPreviewRow = null;

    const segments = getSegments();
    if (hoveredIndex !== null && hoveredIndex >= segments.length) hoveredIndex = null;
    if (selectedIndex !== null && selectedIndex >= segments.length) selectedIndex = null;
    while (rows.length > segments.length) {
      rows.pop()?.destroy();
    }
    while (rows.length < segments.length) {
      const g = new Graphics();
      // purely visual — real interaction all routes through
      // `timeline.trackHitArea`'s own manual pointer handlers above, so a
      // default "passive" `eventMode` here would inherit "interactive" from
      // the widget root and can silently swallow pixi's hit-test (an
      // empty-but-truthy `[]` return) whenever a click lands on a drawn
      // segment, before the walk ever reaches `trackBg`.
      g.eventMode = "none";
      timeline.trackContentLayer.addChild(g);
      rows.push(g);
    }
    segments.forEach((seg, i) =>
      drawSegment(rows[i], seg, i === hoveredIndex, i === hoveredIndex ? hoveredRegion : null, i === selectedIndex)
    );
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
      timeline.trackHitArea.off("pointermove", onTrackPointerMove);
      timeline.trackHitArea.off("pointerout", onTrackPointerOut);
      createPreviewRow?.destroy();
      createPreviewRow = null;
      rows.forEach((g) => g.destroy());
      rows.length = 0;
    },
  };
}

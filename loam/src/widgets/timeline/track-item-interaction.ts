/**
 * generic create/move/resize-left/resize-right/delete/hover/select/snap
 * pointer-interaction engine for one timeline track row — extracted from
 * `stfu/cut-segments-track.ts` (the original had this logic duplicated a
 * 2nd time, near-identically, in `audio-clips-track.ts`; this module is
 * the shared core so a 3rd copy isn't needed for animaniac's own tracks).
 *
 * operates on a generic item type `T` via a small `TrackItemAdapter<T>`
 * (see `timeline-types.ts`) so callers with different item shapes — bare
 * `[start, end]` tuples (stfu's `EditableSegment`) or richer objects with
 * an `id` (animaniac's `Clip` union) — can share one engine. items are
 * tracked by `id` (not array index), so overlapping items and
 * insert/delete-in-the-middle are handled naturally — this is a slight
 * generalization beyond the original index-based implementation, needed
 * because animaniac's tracks allow overlap by design (see
 * docs/animaniac-media-segments-plan.md's decision D).
 *
 * drawing is entirely the caller's own `drawItem()` callback — this module
 * only computes screen geometry + drag/hover/selection state and hands it
 * over, so different track kinds (waveform thumbnail, snapshot thumbnail,
 * plain cut-list bar) can look different while sharing 100% of the
 * interaction logic.
 */

import { Graphics } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import type {
  TrackCameraView,
  TrackDragMode,
  TrackHitRegion,
  TrackItemAdapter,
  TrackItemDrawState,
  TrackRowContainers,
} from "./timeline-types";
import { cursorForRegion, hitDeleteGlyph, modeForLocalX } from "./track-item-render";

const DEFAULT_HANDLE_PX = 8;
const DEFAULT_SNAP_PX = 8;
const DEFAULT_MIN_DURATION_SEC = 0.05;
const DEFAULT_DRAG_THRESHOLD_PX = 3;
const DEFAULT_MARGIN_Y = 3;

export interface Span {
  start: number;
  end: number;
}

interface DragState<T> {
  mode: TrackDragMode;
  /** null while creating a brand-new item (nothing committed yet). */
  id: string | null;
  /** the full item being dragged, captured at drag-start — null for "create". */
  item: T | null;
  startClientX: number;
  startSpan: Span;
  pending: Span;
  moved: boolean;
  /** last seen `e.global.y`/`e.global.x` during the drag — used by
   *  `onMoveOutOfRow` at release time to let the caller check whether the
   *  pointer ended up over a different track's row (cross-track move), or
   *  outside the whole widget entirely (drag-out-to-canvas). */
  lastGlobalY: number;
  lastGlobalX: number;
  /** true if this item was already part of the caller's own multi-
   *  selection (`isSelected()`) when the drag started — see `onPointerDown`'s
   *  own comment for why selection-collapse is deferred to release in this
   *  case, and `onBatchDragDelta`/`onBatchDragEnd` for the group-move it
   *  triggers. always false for "create". */
  isGroupMember: boolean;
}

export interface TrackItemInteractionOptions<T> {
  row: TrackRowContainers;
  camera: TrackCameraView;
  adapter: TrackItemAdapter<T>;
  getItems: () => T[];
  getDuration: () => number;
  isSnapEnabled: () => boolean;
  /** extra snap targets (seconds) besides other items' own edges — e.g. a
   *  reference track's edges, or the playhead. */
  getSnapTimes?: () => number[];
  minDurationSec?: number;
  handlePx?: number;
  snapPx?: number;
  dragThresholdPx?: number;
  marginY?: number;
  /** whether clicking empty track space starts a new item via drag (stfu's
   *  cut-list/audio-clips behavior). when false, "create" is disabled
   *  entirely — e.g. animaniac's clips are only ever created by dragging
   *  another widget in (see `frame-capture.ts`), never by an empty-space
   *  drag on the track itself. */
  allowCreateByDrag?: boolean;
  /** whether a moved/resized item's end is clamped to `getDuration()` — on
   *  by default (matches stfu's own tracks, where duration is a real fixed
   *  media length nothing can play past). set to `false` for a track whose
   *  timeline length is itself derived FROM its items (e.g. animaniac,
   *  where dragging a clip past the current end should be allowed to grow
   *  the timeline, not get clamped to it). */
  clampEndToDuration?: boolean;
  /** when true, a move/resize drag can't push an item into an overlap
   *  with another item already on this same track — the drag is clamped
   *  to whatever gap the item originally occupied (its neighbors' own
   *  edges), rather than allowed to slide over/through them. off by
   *  default (matches every existing consumer's prior behavior, where
   *  overlap was always allowed). doesn't affect items that already
   *  overlap from before this was enabled or from an external drop —
   *  only constrains NEW interactive edits. */
  preventOverlap?: boolean;
  /** called once, at the end of a completed "move" drag, with the item's
   *  own resolved [start,end] and the pointer's final global Y — lets the
   *  caller move an item to a DIFFERENT track (this engine only ever
   *  operates on one track's own items, it has no idea other rows exist).
   *  return `true` if the caller claimed/handled the move itself (e.g. it
   *  reassigned the item to another track's own clips array) — this
   *  engine then skips its own normal same-track commit entirely (the
   *  item no longer belongs in `getItems()`'s array). return `false`/
   *  `undefined` for a normal same-track move. */
  onMoveOutOfRow?: (item: T, span: Span, globalY: number, globalX: number) => boolean;
  /** called continuously (on every pointer-move) during an in-progress
   *  "move" drag, with the item's own live (unsnapped-to-a-track) [start,
   *  end] and the pointer's current global Y — lets the caller draw/
   *  update a live ghost-segment preview in whichever row the pointer is
   *  currently over, mirroring `drop-controller.ts`'s drag-IN placeholder
   *  but for an item already on one of this widget's own tracks. called
   *  with `null` once the drag ends (committed or not) so the caller can
   *  hide its ghost — always paired, never left dangling. */
  onDraggingMove?: (item: T, span: Span | null, globalY: number, globalX: number) => void;
  /** builds a brand-new item from a create-drag's clamped [start,end] —
   *  required when `allowCreateByDrag` is true (also used to render the
   *  live create-preview, so the preview looks exactly like the real
   *  thing once committed). */
  createItem?: (span: Span) => T;
  /** called with the full next array whenever a create/move/resize/delete
   *  completes — persist it, then the caller's own doc-change subscription
   *  (or a direct `refresh()` call) redraws. */
  onChange: (next: T[]) => void;
  onSelectionChange?: (item: T | null) => void;
  /** true if `id` is part of the caller's own multi-selection (spanning
   *  possibly multiple tracks, which this engine has no visibility into on
   *  its own) — omit entirely for a caller with no multi-select concept
   *  (single-select behavior, including immediate select-on-click, is then
   *  100% unchanged). when true for the item under a plain click-drag:
   *  selection-collapse is deferred until release (so starting a drag on
   *  an already-multi-selected item doesn't first flicker the selection
   *  down to just that one item), and the drag is also treated as a group
   *  move — see `onBatchDragDelta`/`onBatchDragEnd`. */
  isSelected?: (id: string) => boolean;
  /** a Cmd/Ctrl+click on an item — called INSTEAD of the normal select-
   *  and-start-drag handling (no drag is started for this click); the
   *  caller toggles its own multi-selection set. */
  onToggleSelect?: (id: string) => void;
  /** called on every pointer-move tick during an in-progress "move" drag
   *  whose item `isSelected` (i.e. a group move), with the raw (unsnapped)
   *  delta in seconds from drag-start — lets the caller apply the same
   *  delta to every OTHER selected item, each via that item's OWN track's
   *  `beginExternalMove`/`previewExternalMove` (see those methods on
   *  `TrackItemInteractionHandle`). */
  onBatchDragDelta?: (draggedId: string, deltaSec: number) => void;
  /** called once when a group-move drag ends — `committed` is false if the
   *  pointer never moved past the drag threshold (a plain click, not an
   *  actual move) or if the primary item's own move was itself rejected;
   *  the caller should commit (or cancel) every companion item's own
   *  pending external move accordingly, via that item's own track's
   *  `commitExternalMove`/`cancelExternalMove`. */
  onBatchDragEnd?: (draggedId: string, committed: boolean) => void;
  /** draws one item's Graphics, given its current screen geometry +
   *  hover/selection state — also used (with a transient, not-yet-
   *  committed item) to render live drag/create previews. */
  drawItem: (g: Graphics, item: T, state: TrackItemDrawState) => void;
}

export interface TrackItemInteractionHandle<T> {
  /** re-draw every item — call after the items array changes for any
   *  reason (this track's own `onChange`, or a remote peer's edit landing
   *  via the doc's change subscription, or a camera pan/zoom). */
  refresh(): void;
  getSelectedId(): string | null;
  getSelected(): T | null;
  deleteSelected(): void;
  clearSelection(): void;
  /** select the item with this id, if it currently exists — no-op otherwise. */
  selectId(id: string): void;
  /** show/update a transient (not-yet-committed) preview item — e.g. a
   *  mark-in/mark-out range picked via keyboard shortcuts before it's
   *  confirmed. pass `null` to hide it. */
  showPreview(item: T | null): void;
  /** begin an externally-driven (group) move for `id` — a companion item
   *  on THIS track being moved because a DIFFERENT track's item is the one
   *  actually being dragged (see `onBatchDragDelta`). captures `id`'s
   *  current span as the anchor for `previewExternalMove`/`commitExternalMove`.
   *  no-op if `id` doesn't exist on this track. */
  beginExternalMove(id: string): void;
  /** live-preview an externally-driven move at `deltaSec` from the anchor
   *  captured by `beginExternalMove` (subject to this track's own
   *  `preventOverlap`/duration clamping) — does not commit. no-op if
   *  `beginExternalMove` wasn't called first (or already committed/cancelled). */
  previewExternalMove(id: string, deltaSec: number): void;
  /** commit an externally-driven move at `deltaSec`, then clear the anchor. */
  commitExternalMove(id: string, deltaSec: number): void;
  /** cancel an externally-driven move without committing (redraws `id` back
   *  at its original position), then clears the anchor. */
  cancelExternalMove(id: string): void;
  destroy(): void;
}

export function createTrackItemInteraction<T>(options: TrackItemInteractionOptions<T>): TrackItemInteractionHandle<T> {
  const {
    row,
    camera,
    adapter,
    getItems,
    getDuration,
    isSnapEnabled,
    getSnapTimes,
    minDurationSec = DEFAULT_MIN_DURATION_SEC,
    handlePx = DEFAULT_HANDLE_PX,
    snapPx = DEFAULT_SNAP_PX,
    dragThresholdPx = DEFAULT_DRAG_THRESHOLD_PX,
    marginY = DEFAULT_MARGIN_Y,
    allowCreateByDrag = false,
    clampEndToDuration = true,
    preventOverlap = false,
    onMoveOutOfRow,
    onDraggingMove,
    createItem,
    onChange,
    onSelectionChange,
    isSelected,
    onToggleSelect,
    onBatchDragDelta,
    onBatchDragEnd,
    drawItem,
  } = options;

  const rows = new Map<string, Graphics>();
  let createPreviewRow: Graphics | null = null;
  let previewItem: T | null = null;
  let previewRow: Graphics | null = null;
  let drag: DragState<T> | null = null;
  let hoveredId: string | null = null;
  let hoveredRegion: TrackHitRegion | null = null;
  let selectedId: string | null = null;
  /** anchor spans for in-progress externally-driven (group) moves — see
   *  `beginExternalMove()`. */
  const externalMoves = new Map<string, Span>();

  function idOf(item: T, index: number): string {
    return adapter.getId(item, index);
  }

  function findById(id: string): { item: T; index: number } | null {
    const items = getItems();
    for (let i = 0; i < items.length; i++) {
      if (idOf(items[i], i) === id) return { item: items[i], index: i };
    }
    return null;
  }

  function pxPerSecond(): number {
    return camera.timeToScreenX(1) - camera.timeToScreenX(0);
  }

  function snapTime(t: number, excludeId: string | null): number {
    if (!isSnapEnabled()) return t;
    const pps = pxPerSecond();
    if (pps <= 0) return t;
    const toleranceSec = snapPx / pps;
    let best = t;
    let bestDelta = toleranceSec;
    const consider = (edge: number) => {
      const delta = Math.abs(edge - t);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = edge;
      }
    };
    const items = getItems();
    items.forEach((item, i) => {
      if (idOf(item, i) === excludeId) return;
      const span = adapter.getSpan(item);
      consider(span.start);
      consider(span.end);
    });
    (getSnapTimes?.() ?? []).forEach(consider);
    return best;
  }

  /** nearest OTHER item's `end` that is <= `beforeTime` (0 if none) — the
   *  left wall a `preventOverlap` drag can't cross. */
  function overlapLeftBound(excludeId: string | null, beforeTime: number): number {
    let bound = 0;
    getItems().forEach((item, i) => {
      if (idOf(item, i) === excludeId) return;
      const end = adapter.getSpan(item).end;
      if (end <= beforeTime && end > bound) bound = end;
    });
    return bound;
  }

  /** nearest OTHER item's `start` that is >= `afterTime` (+Infinity if
   *  none) — the right wall a `preventOverlap` drag can't cross. */
  function overlapRightBound(excludeId: string | null, afterTime: number): number {
    let bound = Infinity;
    getItems().forEach((item, i) => {
      if (idOf(item, i) === excludeId) return;
      const start = adapter.getSpan(item).start;
      if (start >= afterTime && start < bound) bound = start;
    });
    return bound;
  }

  function clampSpan(span: Span): Span {
    const duration = getDuration();
    let { start, end } = span;
    if (end < start) [start, end] = [end, start];
    start = Math.max(0, start);
    if (clampEndToDuration) end = duration > 0 ? Math.min(duration, end) : end;
    if (end - start < minDurationSec) end = start + minDurationSec;
    return { start, end };
  }

  /** resolves a "move" drag's pending span into a valid (non-negative,
   *  non-overlapping-if-`preventOverlap`) resting span while ALWAYS
   *  preserving the item's own duration — unlike `clampSpan()` (which
   *  independently clamps `start`/`end`, appropriate for a resize, where
   *  the two edges are meant to move independently). applying plain
   *  `clampSpan()` to a move's pending span whose `start` went negative
   *  (e.g. dragging an item sitting at `start: 0` further left) clamped
   *  `start` up to `0` without touching `end`, silently shrinking the
   *  item's live-preview duration — `clip-track-adapter.ts`'s `withSpan()`
   *  then misread that shrunk span as a RESIZE (only one edge moved) and
   *  trimmed the clip's own source range instead of leaving it parked at
   *  the wall, so the item visually looked "stuck"/broken mid-drag even
   *  though the eventual commit (which already used this same resolve
   *  logic) landed correctly. */
  function resolveMoveSpan(pending: Span, excludeId: string | null): Span {
    if (!preventOverlap) return pending;
    const dur = pending.end - pending.start;
    const leftBound = overlapLeftBound(excludeId, pending.start);
    const rightBound = overlapRightBound(excludeId, pending.end);
    const clampedStart = Math.max(leftBound, Math.min(rightBound - dur, pending.start));
    return { start: clampedStart, end: clampedStart + dur };
  }

  function spanToScreen(span: Span): { left: number; right: number } {
    const x1 = camera.timeToScreenX(span.start);
    const x2 = camera.timeToScreenX(span.end);
    return { left: Math.min(x1, x2), right: Math.max(x1, x2) };
  }

  function hitTest(localX: number, localY: number): { id: string; region: TrackHitRegion } | null {
    const items = getItems();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const id = idOf(item, i);
      const span = adapter.getSpan(item);
      const { left, right } = spanToScreen(span);
      const extendedLeft = left - handlePx;
      const extendedRight = right + handlePx;
      if (localX < extendedLeft || localX > extendedRight) continue;
      if (hitDeleteGlyph(right, marginY, localX, localY)) return { id, region: "delete" };
      return { id, region: modeForLocalX(left, right, localX, handlePx) };
    }
    return null;
  }

  function redrawItem(id: string | null): void {
    if (!id) return;
    const found = findById(id);
    const g = rows.get(id);
    if (!found || !g) return;
    const span = clampSpan(adapter.getSpan(found.item));
    const { left, right } = spanToScreen(span);
    const hovered = id === hoveredId;
    const selected = id === selectedId || (isSelected?.(id) ?? false);
    // an unclipped hovered/selected label (see the caller's own `drawItem`)
    // can overflow past this item's own bounds — bring it fully to the
    // front so that overflow isn't hidden under a neighboring item, above
    // even `refresh()`'s own later-start-on-top stacking order.
    if (hovered || selected) row.contentLayer.addChild(g);
    drawItem(g, found.item, {
      left,
      right,
      hovered,
      hoveredRegion: hovered ? hoveredRegion : null,
      selected,
    });
  }

  function setHoveredId(id: string | null, region: TrackHitRegion | null = null): void {
    if (hoveredId === id && hoveredRegion === region) return;
    const prev = hoveredId;
    hoveredId = id;
    hoveredRegion = region;
    redrawItem(prev);
    redrawItem(id);
  }

  function setSelectedId(id: string | null): void {
    if (selectedId === id) return;
    const prev = selectedId;
    selectedId = id;
    redrawItem(prev);
    redrawItem(id);
    onSelectionChange?.(id ? (findById(id)?.item ?? null) : null);
  }

  function commit(next: T[]): void {
    onChange(next);
    refresh();
  }

  function emptyCursor(): string {
    return allowCreateByDrag ? "crosshair" : "default";
  }

  function onPointerDown(e: FederatedPointerEvent): void {
    const local = e.getLocalPosition(row.hitArea);
    const hit = hitTest(local.x, local.y);
    if (hit) {
      if (hit.region === "delete") {
        const items = getItems();
        commit(items.filter((item, i) => idOf(item, i) !== hit.id));
        setSelectedId(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
        onToggleSelect(hit.id);
        return;
      }
      const found = findById(hit.id);
      if (!found) return;
      // an already-multi-selected item's click doesn't collapse the
      // selection immediately — it might turn into a group-move drag
      // instead (see onGlobalPointerUp's own deferred setSelectedId call
      // for the "turned out to be a plain click" case).
      const isGroupMember = isSelected?.(hit.id) ?? false;
      if (!isGroupMember) setSelectedId(hit.id);
      const span = adapter.getSpan(found.item);
      drag = {
        mode: hit.region,
        id: hit.id,
        item: found.item,
        startClientX: e.global.x,
        startSpan: span,
        pending: span,
        moved: false,
        lastGlobalY: e.global.y,
        lastGlobalX: e.global.x,
        isGroupMember,
      };
      return;
    }
    setSelectedId(null);
    if (!allowCreateByDrag) return;
    const t = camera.screenXToTime(local.x);
    drag = {
      mode: "create",
      id: null,
      item: null,
      startClientX: e.global.x,
      startSpan: { start: t, end: t },
      pending: { start: t, end: t },
      moved: false,
      lastGlobalY: e.global.y,
      lastGlobalX: e.global.x,
      isGroupMember: false,
    };
  }

  function onGlobalPointerMove(e: FederatedPointerEvent): void {
    if (!drag) return;
    drag.lastGlobalY = e.global.y;
    drag.lastGlobalX = e.global.x;
    const deltaPx = e.global.x - drag.startClientX;
    if (!drag.moved && Math.abs(deltaPx) <= dragThresholdPx) return;
    drag.moved = true;

    const pps = pxPerSecond();
    const deltaSec = pps > 0 ? deltaPx / pps : 0;

    if (drag.mode === "create") {
      drag.pending = { start: drag.startSpan.start, end: drag.startSpan.start + deltaSec };
      if (!createPreviewRow) {
        createPreviewRow = new Graphics();
        createPreviewRow.eventMode = "none"; // purely visual, never a hit-test target
        row.contentLayer.addChild(createPreviewRow);
      }
      if (createItem) {
        const clamped = clampSpan(drag.pending);
        const { left, right } = spanToScreen(clamped);
        drawItem(createPreviewRow, createItem(clamped), { left, right, hovered: true, hoveredRegion: null, selected: false });
      }
      return;
    }

    if (drag.mode === "move") {
      const dur = drag.startSpan.end - drag.startSpan.start;
      const movedStart = drag.startSpan.start + deltaSec;
      const snappedStart = snapTime(movedStart, drag.id);
      let start = snappedStart;
      if (snappedStart === movedStart) {
        const movedEnd = drag.startSpan.end + deltaSec;
        const snappedEnd = snapTime(movedEnd, drag.id);
        if (snappedEnd !== movedEnd) start = snappedEnd - dur;
      }
      drag.pending = { start, end: start + dur };
      // NOTE: no preventOverlap clamp here (unlike resize below) — a move
      // is allowed to slide freely past a neighbor while dragging (so the
      // user can actually REORDER two items, not just get stuck against
      // whichever neighbor it started next to); the final resting spot is
      // resolved into a real non-overlapping gap at commit time in
      // `onGlobalPointerUp()`, anchored to wherever it was actually
      // dropped rather than where the drag began.
    } else if (drag.mode === "resize-left") {
      drag.pending = { start: snapTime(drag.startSpan.start + deltaSec, drag.id), end: drag.startSpan.end };
      if (preventOverlap) {
        const leftBound = overlapLeftBound(drag.id, drag.startSpan.start);
        drag.pending = { start: Math.max(leftBound, drag.pending.start), end: drag.pending.end };
      }
    } else {
      drag.pending = { start: drag.startSpan.start, end: snapTime(drag.startSpan.end + deltaSec, drag.id) };
      if (preventOverlap) {
        const rightBound = overlapRightBound(drag.id, drag.startSpan.end);
        drag.pending = { start: drag.pending.start, end: Math.min(rightBound, drag.pending.end) };
      }
    }

    const g = drag.id ? rows.get(drag.id) : undefined;
    if (g && drag.item) {
      const clamped = clampSpan(drag.mode === "move" ? resolveMoveSpan(drag.pending, drag.id) : drag.pending);
      const resizedItem = adapter.withSpan(drag.item, clamped);
      // re-derive the drawn box from the ADAPTER's own resulting span, not
      // straight from `clamped` — an adapter can clamp further on its own
      // terms (e.g. a trim resize capped against the source's real known
      // duration, see clip-track-adapter.ts's `sourceDurationSec` ceiling)
      // and the live preview must reflect THAT, or the box looks like it
      // never clamped at all until commit silently snaps it back.
      const { left, right } = spanToScreen(adapter.getSpan(resizedItem));
      const region = drag.mode === "resize-left" || drag.mode === "resize-right" ? drag.mode : null;
      drawItem(g, resizedItem, { left, right, hovered: true, hoveredRegion: region, selected: true });
    }

    if (drag.mode === "move" && drag.item) {
      onDraggingMove?.(drag.item, drag.pending, drag.lastGlobalY, drag.lastGlobalX);
      if (drag.isGroupMember) onBatchDragDelta?.(drag.id!, deltaSec);
    }
  }

  function onGlobalPointerUp(): void {
    if (!drag) return;
    const finished = drag;
    drag = null;
    if (finished.mode === "move" && finished.item) {
      onDraggingMove?.(finished.item, null, finished.lastGlobalY, finished.lastGlobalX);
      if (finished.isGroupMember) onBatchDragEnd?.(finished.id!, finished.moved);
    }

    if (!finished.moved) {
      // a plain click (never crossed the drag threshold) on an already-
      // multi-selected item — now safe to collapse to just this one.
      if (finished.isGroupMember && finished.id) setSelectedId(finished.id);
      refresh();
      return;
    }

    if (finished.mode === "create") {
      const clamped = clampSpan(finished.pending);
      if (clamped.end - clamped.start >= minDurationSec && createItem) {
        commit([...getItems(), createItem(clamped)]);
      } else {
        refresh();
      }
      return;
    }

    if (!finished.id || !finished.item) {
      refresh();
      return;
    }
    const items = [...getItems()];
    const idx = items.findIndex((item, i) => idOf(item, i) === finished.id);
    if (idx === -1) {
      refresh();
      return;
    }
    let resolvedPending = finished.pending;
    if (finished.mode === "move") {
      // resolve into whichever gap the item actually landed in (anchored to
      // the DROP position, not drag-start) — this is what lets a move drag
      // actually reorder past a neighbor instead of being walled in at its
      // original position. same duration-preserving resolve the live
      // preview above already used, so the final commit never surprises
      // the user with a different result than what they were shown.
      resolvedPending = resolveMoveSpan(resolvedPending, finished.id);
    }
    if (finished.mode === "move" && onMoveOutOfRow?.(items[idx], clampSpan(resolvedPending), finished.lastGlobalY, finished.lastGlobalX)) {
      // caller moved this item to a different track's own clips array —
      // this row's own commit must NOT also write it back (it no longer
      // belongs in `getItems()`'s array at all); just clear selection/
      // redraw whatever's left.
      setSelectedId(null);
      refresh();
      return;
    }
    items[idx] = adapter.withSpan(items[idx], clampSpan(resolvedPending));
    commit(items);
  }

  function onTrackPointerMove(e: FederatedPointerEvent): void {
    if (drag) return; // an active drag already draws its own hover/preview state
    const local = e.getLocalPosition(row.hitArea);
    const hit = hitTest(local.x, local.y);
    setHoveredId(hit ? hit.id : null, hit ? hit.region : null);
    row.hitArea.cursor = cursorForRegion(hit ? hit.region : null, emptyCursor());
  }

  function onTrackPointerOut(): void {
    if (drag) return;
    setHoveredId(null);
    row.hitArea.cursor = emptyCursor();
  }

  row.hitArea.eventMode = "static";
  row.hitArea.cursor = emptyCursor();
  row.hitArea.on("pointerdown", onPointerDown);
  row.hitArea.on("globalpointermove", onGlobalPointerMove);
  row.hitArea.on("pointerup", onGlobalPointerUp);
  row.hitArea.on("pointerupoutside", onGlobalPointerUp);
  row.hitArea.on("pointermove", onTrackPointerMove);
  row.hitArea.on("pointerout", onTrackPointerOut);

  function refresh(): void {
    createPreviewRow?.destroy({ children: true });
    createPreviewRow = null;

    const items = getItems();
    const liveIds = new Set(items.map((item, i) => idOf(item, i)));
    if (hoveredId !== null && !liveIds.has(hoveredId)) hoveredId = null;
    if (selectedId !== null && !liveIds.has(selectedId)) selectedId = null;
    for (const id of externalMoves.keys()) {
      if (!liveIds.has(id)) externalMoves.delete(id);
    }

    for (const [id, g] of rows) {
      if (!liveIds.has(id)) {
        g.destroy({ children: true });
        rows.delete(id);
      }
    }
    items.forEach((item, i) => {
      const id = idOf(item, i);
      if (!rows.has(id)) {
        const g = new Graphics();
        // purely visual — real interaction routes entirely through
        // `row.hitArea`'s own manual pointer handlers above. a default
        // "passive" eventMode here would inherit "interactive" from an
        // interactive ancestor and can silently swallow pixi's hit-test
        // (an empty-but-truthy `[]` return) whenever a click lands on a
        // drawn item, before the walk ever reaches `row.hitArea`.
        g.eventMode = "none";
        row.contentLayer.addChild(g);
        rows.set(id, g);
      }
    });

    // stacking order: later-starting items render on top of earlier ones
    // (matters when an unclipped hovered/selected label — see
    // `redrawItem()`'s own bring-to-front — overflows into a neighboring
    // item's screen space). `addChild()` on an already-parented child just
    // moves it to the end of the display list, no duplicate/re-parent.
    // ids are computed against each item's OWN original index in `items`
    // (never a post-sort position) — some adapters fall back to the index
    // for an item with no stable id of its own.
    items
      .map((item, i) => ({ id: idOf(item, i), start: adapter.getSpan(item).start }))
      .sort((a, b) => a.start - b.start)
      .forEach(({ id }) => {
        const g = rows.get(id);
        if (g) row.contentLayer.addChild(g);
      });

    items.forEach((item, i) => {
      const id = idOf(item, i);
      const g = rows.get(id);
      if (!g) return;
      const span = clampSpan(adapter.getSpan(item));
      const { left, right } = spanToScreen(span);
      drawItem(g, item, {
        left,
        right,
        hovered: id === hoveredId,
        hoveredRegion: id === hoveredId ? hoveredRegion : null,
        selected: id === selectedId || (isSelected?.(id) ?? false),
      });
    });

    if (previewItem) {
      if (!previewRow) {
        previewRow = new Graphics();
        previewRow.eventMode = "none";
        row.contentLayer.addChild(previewRow);
      }
      const span = clampSpan(adapter.getSpan(previewItem));
      const { left, right } = spanToScreen(span);
      drawItem(previewRow, previewItem, { left, right, hovered: false, hoveredRegion: null, selected: false });
    }
  }

  refresh();

  return {
    refresh,
    getSelectedId() {
      return selectedId;
    },
    getSelected() {
      return selectedId ? (findById(selectedId)?.item ?? null) : null;
    },
    deleteSelected() {
      if (!selectedId) return;
      const id = selectedId;
      const items = getItems();
      commit(items.filter((item, i) => idOf(item, i) !== id));
      setSelectedId(null);
    },
    clearSelection() {
      setSelectedId(null);
    },
    selectId(id: string) {
      if (findById(id)) setSelectedId(id);
    },
    beginExternalMove(id: string) {
      const found = findById(id);
      if (!found) return;
      externalMoves.set(id, adapter.getSpan(found.item));
    },
    previewExternalMove(id: string, deltaSec: number) {
      const anchor = externalMoves.get(id);
      const found = findById(id);
      if (!anchor || !found) return;
      const dur = anchor.end - anchor.start;
      const start = anchor.start + deltaSec;
      const pending = resolveMoveSpan({ start, end: start + dur }, id);
      const clamped = clampSpan(pending);
      const g = rows.get(id);
      if (!g) return;
      const { left, right } = spanToScreen(clamped);
      drawItem(g, adapter.withSpan(found.item, clamped), { left, right, hovered: id === hoveredId, hoveredRegion: null, selected: true });
    },
    commitExternalMove(id: string, deltaSec: number) {
      const anchor = externalMoves.get(id);
      externalMoves.delete(id);
      if (!anchor) return;
      const items = [...getItems()];
      const idx = items.findIndex((item, i) => idOf(item, i) === id);
      if (idx === -1) return;
      const dur = anchor.end - anchor.start;
      const start = anchor.start + deltaSec;
      const resolved = clampSpan(resolveMoveSpan({ start, end: start + dur }, id));
      items[idx] = adapter.withSpan(items[idx], resolved);
      commit(items);
    },
    cancelExternalMove(id: string) {
      const had = externalMoves.delete(id);
      if (had) redrawItem(id);
    },
    showPreview(item: T | null) {
      previewItem = item;
      if (!item) {
        previewRow?.destroy({ children: true });
        previewRow = null;
        return;
      }
      if (!previewRow) {
        previewRow = new Graphics();
        previewRow.eventMode = "none";
        row.contentLayer.addChild(previewRow);
      }
      const span = clampSpan(adapter.getSpan(item));
      const { left, right } = spanToScreen(span);
      drawItem(previewRow, item, { left, right, hovered: false, hoveredRegion: null, selected: false });
    },
    destroy() {
      row.hitArea.off("pointerdown", onPointerDown);
      row.hitArea.off("globalpointermove", onGlobalPointerMove);
      row.hitArea.off("pointerup", onGlobalPointerUp);
      row.hitArea.off("pointerupoutside", onGlobalPointerUp);
      row.hitArea.off("pointermove", onTrackPointerMove);
      row.hitArea.off("pointerout", onTrackPointerOut);
      createPreviewRow?.destroy({ children: true });
      createPreviewRow = null;
      previewRow?.destroy({ children: true });
      previewRow = null;
      for (const g of rows.values()) g.destroy({ children: true });
      rows.clear();
    },
  };
}

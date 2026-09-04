/**
 * interactive position/resize/rotate editor for whatever's currently shown
 * in animaniac's preview area — doodle-frame/image/label/video-segment
 * sprites AND a voice-recording clip's animated mouth (anything
 * `compositor.ts` renders). lets the user click a clip in the preview (or
 * an already-selected timeline clip, kept in sync bidirectionally) to see
 * a selection outline + 8 resize handles, drag the body to reposition, and
 * drag a corner/edge handle to resize — corner handles free both axes
 * (uneven aspect ratio, e.g. stretching wider than tall) unless cmd/ctrl
 * is held, which locks them to a uniform scale; holding SHIFT while
 * dragging a CORNER handle rotates instead of resizing (edge handles
 * always resize a single axis only, shift has no effect there).
 *
 * resizing is CENTER-anchored (matches every clip kind's own anchor(0.5)
 * convention already used throughout `compositor.ts`) — a clip's x/y
 * position never changes during a resize, only its scaleX/scaleY do.
 * rotating is also center-anchored (pixi's own `Container.rotation`
 * pivots around its own anchor point, i.e. the clip's center here).
 *
 * mirrors `track-item-interaction.ts`'s own "live preview during drag,
 * commit once on release" convention: dragging directly mutates the
 * clip's real pixi node (via `compositor.ts`'s `beginLiveEdit()`/
 * `endLiveEdit()`, so the actual content visibly moves/resizes/rotates in
 * real time) without writing to the doc until the pointer is released —
 * keeps undo history + automerge op count sane and avoids fighting a live
 * playback tick mid-drag.
 *
 * pure pixi/pointer-event code — NOT unit-testable per this codebase's
 * established convention (pixi construction/interaction is never unit
 * tested here, only typecheck+lint+manual QA verify it).
 */

import { Container, Graphics, Rectangle, type FederatedPointerEvent } from "pixi.js";
import { activeClipsAt, clipsForTrack, sortedTracks } from "./track-model";
import { resolveTransformAt } from "./transform";
import { VISUAL_CLIP_KINDS, type Clip, type Track } from "./types";

const HANDLE_SIZE = 9;
const MIN_SCALE = 0.05;
const OUTLINE_COLOR = 0x45c9e6;
const HANDLE_COLOR = 0xffffff;

/** every clip kind `compositor.ts` actually renders something for in the
 *  preview area — the only kinds this editor ever needs to consider. */
const PREVIEWABLE_KINDS = new Set(["doodle-frame", "image", "label", "video-segment", "voice-recording"]);

function isPreviewableClip(clip: Clip): boolean {
  return PREVIEWABLE_KINDS.has(clip.kind);
}

type HandleKind = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

function isCornerHandle(kind: HandleKind): boolean {
  return kind === "nw" || kind === "ne" || kind === "sw" || kind === "se";
}

interface ScreenRect {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  /** radians — same convention as pixi's own `Container.rotation`. */
  rotation: number;
}

export interface TransformPatch {
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
}

export interface PreviewTransformEditorOptions {
  /** added ABOVE the compositor's own content — caller positions/sizes
   *  this exactly like the compositor's own container (same preview area). */
  container: Container;
  getPreviewSize: () => { width: number; height: number };
  getClips: () => Clip[];
  getTracks: () => Track[];
  getCurrentTime: () => number;
  getNaturalSize: (clipId: string) => { width: number; height: number } | null;
  getSelectedClipId: () => string | null;
  /** fires when the user clicks a clip in the preview (selecting it), or
   *  clicks empty preview space (deselecting, `null`). caller should keep
   *  its own selection state (and the relevant track row's selection) in
   *  sync — see `index.ts`. */
  onSelect: (clipId: string | null) => void;
  beginLiveEdit: (clipId: string) => Container | null;
  endLiveEdit: (clipId: string) => void;
  /** called once, on pointer release, with the finished drag's new
   *  values — caller writes this into the clip's first keyframe and
   *  pushes undo history (see `index.ts`'s `commitClipTransform()`). */
  onTransformCommit: (clipId: string, patch: TransformPatch) => void;
}

export interface PreviewTransformEditorHandle {
  /** redraw the selection outline/handles for the current selection/time
   *  — call after any camera/doc/selection change (mirrors compositor's
   *  own `update()` call sites). */
  refresh(): void;
  destroy(): void;
}

interface DragState {
  clipId: string;
  mode: "move" | HandleKind;
  /** true only for a corner-handle drag started with shift held — fixed
   *  for the whole gesture (checked once at pointerdown, not re-checked
   *  every move, so releasing shift mid-drag doesn't flip modes). */
  rotating: boolean;
  node: Container;
  startLocal: { x: number; y: number };
  startTransform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
  /** angle (radians) from the clip's center to the pointer at drag start
   *  — only used when `rotating`. */
  startAngle: number;
  natural: { width: number; height: number };
  centerScreen: { x: number; y: number };
  moved: boolean;
}

/** topmost-first z-order for hit-testing: mouths (voice-recording clips)
 *  are always drawn on top by the compositor's own always-on-top mouth
 *  layer, then visual clips in REVERSE of the compositor's own draw order
 *  (last-drawn visual clip = topmost). */
function visibleClipsTopmostFirst(clips: Clip[], tracks: Track[], t: number): Clip[] {
  const active = activeClipsAt(clips, t).filter(isPreviewableClip);
  const mouths = active.filter((c) => c.kind === "voice-recording");
  // a track may now hold a mix of visual + voice-recording clips (tracks
  // are unified, see docs/animaniac-plan.md) — mouths are already pulled
  // out above and drawn on their own always-on-top layer, so exclude them
  // here to avoid drawing/hit-testing them twice.
  const visual = active.filter((c) => (VISUAL_CLIP_KINDS as readonly string[]).includes(c.kind));
  const visualOrdered: Clip[] = [];
  // same track-iteration order as compositor.ts's own z-order build (the
  // top-of-track-list track ends up drawn topmost) — walked in REVERSE of
  // `sortedTracks()`'s ascending-`order` result, see that module's own
  // comment for why.
  for (const track of sortedTracks(tracks.filter((tr) => !tr.hidden)).reverse()) {
    visualOrdered.push(...clipsForTrack(visual, track.id));
  }
  return [...mouths, ...visualOrdered.reverse()];
}

function screenRectFor(
  clip: Clip,
  t: number,
  previewSize: { width: number; height: number },
  natural: { width: number; height: number }
): ScreenRect {
  const transform = resolveTransformAt(clip.keyframes, t - clip.start);
  return {
    cx: previewSize.width / 2 + transform.x,
    cy: previewSize.height / 2 + transform.y,
    hw: (natural.width / 2) * Math.abs(transform.scaleX),
    hh: (natural.height / 2) * Math.abs(transform.scaleY),
    rotation: transform.rotation,
  };
}

/** rotates a vector (radians, same convention as pixi's `Container.rotation`). */
function rotateVector(x: number, y: number, angle: number): { x: number; y: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** every handle's position in SCREEN space, accounting for the rect's own
 *  rotation (each handle sits at a fixed LOCAL offset from center, rotated
 *  into screen space). */
function handlePositions(r: ScreenRect): Record<HandleKind, { x: number; y: number }> {
  const local: Record<HandleKind, { x: number; y: number }> = {
    nw: { x: -r.hw, y: -r.hh },
    ne: { x: r.hw, y: -r.hh },
    sw: { x: -r.hw, y: r.hh },
    se: { x: r.hw, y: r.hh },
    n: { x: 0, y: -r.hh },
    s: { x: 0, y: r.hh },
    e: { x: r.hw, y: 0 },
    w: { x: -r.hw, y: 0 },
  };
  const result = {} as Record<HandleKind, { x: number; y: number }>;
  for (const kind of Object.keys(local) as HandleKind[]) {
    const rotated = rotateVector(local[kind].x, local[kind].y, r.rotation);
    result[kind] = { x: r.cx + rotated.x, y: r.cy + rotated.y };
  }
  return result;
}

/** point-in-(possibly rotated)-rect test: projects the point into the
 *  rect's own LOCAL (unrotated) frame around its center first. */
function pointInRect(px: number, py: number, r: ScreenRect): boolean {
  const local = rotateVector(px - r.cx, py - r.cy, -r.rotation);
  return Math.abs(local.x) <= r.hw && Math.abs(local.y) <= r.hh;
}

function hitHandle(px: number, py: number, r: ScreenRect): HandleKind | null {
  const half = HANDLE_SIZE / 2;
  const positions = handlePositions(r);
  for (const kind of Object.keys(positions) as HandleKind[]) {
    const p = positions[kind];
    if (Math.abs(px - p.x) <= half && Math.abs(py - p.y) <= half) return kind;
  }
  return null;
}

/** draws the (possibly rotated) selection outline + its 8 handles into `g`
 *  (already `.clear()`-ed by the caller). */
function drawSelectionOverlay(g: Graphics, r: ScreenRect): void {
  const positions = handlePositions(r);
  g.moveTo(positions.nw.x, positions.nw.y)
    .lineTo(positions.ne.x, positions.ne.y)
    .lineTo(positions.se.x, positions.se.y)
    .lineTo(positions.sw.x, positions.sw.y)
    .closePath()
    .stroke({ width: 1.5, color: OUTLINE_COLOR });
  for (const kind of Object.keys(positions) as HandleKind[]) {
    const p = positions[kind];
    g.rect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
      .fill({ color: HANDLE_COLOR })
      .stroke({ width: 1, color: OUTLINE_COLOR });
  }
}

export function createPreviewTransformEditor(options: PreviewTransformEditorOptions): PreviewTransformEditorHandle {
  const {
    container,
    getPreviewSize,
    getClips,
    getTracks,
    getCurrentTime,
    getNaturalSize,
    getSelectedClipId,
    onSelect,
    beginLiveEdit,
    endLiveEdit,
    onTransformCommit,
  } = options;

  container.eventMode = "static";
  container.cursor = "default";
  const gfx = new Graphics();
  gfx.eventMode = "none";
  container.addChild(gfx);

  let drag: DragState | null = null;

  function selectedActiveClip(): { clip: Clip; rect: ScreenRect } | null {
    const id = getSelectedClipId();
    if (!id) return null;
    const t = getCurrentTime();
    const clips = getClips();
    const clip = clips.find((c) => c.id === id && isPreviewableClip(c));
    if (!clip) return null;
    const active = activeClipsAt(clips, t).some((c) => c.id === id);
    if (!active) return null;
    const natural = getNaturalSize(id);
    if (!natural) return null;
    return { clip, rect: screenRectFor(clip, t, getPreviewSize(), natural) };
  }

  function draw(): void {
    gfx.clear();
    const size = getPreviewSize();
    container.hitArea = new Rectangle(0, 0, size.width, size.height);

    const selected = drag ? null : selectedActiveClip();
    if (!selected) return;
    drawSelectionOverlay(gfx, selected.rect);
  }

  /** redraws the overlay mid-drag from the drag's own pending state
   *  (never re-reads the doc, which hasn't been written to yet). */
  function drawDragOverlay(rect: ScreenRect): void {
    gfx.clear();
    drawSelectionOverlay(gfx, rect);
  }

  function startDrag(clipId: string, mode: DragState["mode"], local: { x: number; y: number }, shiftKeyAtStart: boolean): void {
    const t = getCurrentTime();
    const clip = getClips().find((c) => c.id === clipId);
    const natural = getNaturalSize(clipId);
    if (!clip || !natural) return;
    const transform = resolveTransformAt(clip.keyframes, t - clip.start);
    const node = beginLiveEdit(clipId);
    if (!node) return;
    const size = getPreviewSize();
    const centerScreen = { x: size.width / 2 + transform.x, y: size.height / 2 + transform.y };
    drag = {
      clipId,
      mode,
      rotating: mode !== "move" && isCornerHandle(mode) && shiftKeyAtStart,
      node,
      startLocal: local,
      startTransform: { x: transform.x, y: transform.y, scaleX: transform.scaleX, scaleY: transform.scaleY, rotation: transform.rotation },
      startAngle: Math.atan2(local.y - centerScreen.y, local.x - centerScreen.x),
      natural,
      centerScreen,
      moved: false,
    };
  }

  function onPointerDown(e: FederatedPointerEvent): void {
    const local = e.getLocalPosition(container);
    const selected = selectedActiveClip();
    if (selected) {
      const handle = hitHandle(local.x, local.y, selected.rect);
      if (handle) {
        startDrag(selected.clip.id, handle, local, e.shiftKey);
        return;
      }
      if (pointInRect(local.x, local.y, selected.rect)) {
        startDrag(selected.clip.id, "move", local, e.shiftKey);
        return;
      }
    }
    const t = getCurrentTime();
    const size = getPreviewSize();
    for (const clip of visibleClipsTopmostFirst(getClips(), getTracks(), t)) {
      const natural = getNaturalSize(clip.id);
      if (!natural) continue;
      const rect = screenRectFor(clip, t, size, natural);
      if (pointInRect(local.x, local.y, rect)) {
        onSelect(clip.id);
        startDrag(clip.id, "move", local, e.shiftKey);
        return;
      }
    }
    onSelect(null);
    draw();
  }

  function onGlobalPointerMove(e: FederatedPointerEvent): void {
    if (!drag) return;
    const local = e.getLocalPosition(container);
    const deltaX = local.x - drag.startLocal.x;
    const deltaY = local.y - drag.startLocal.y;
    if (!drag.moved && Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
    drag.moved = true;

    if (drag.mode === "move") {
      const x = drag.startTransform.x + deltaX;
      const y = drag.startTransform.y + deltaY;
      const size = getPreviewSize();
      drag.node.x = size.width / 2 + x;
      drag.node.y = size.height / 2 + y;
      drawDragOverlay({
        cx: drag.node.x,
        cy: drag.node.y,
        hw: (drag.natural.width / 2) * Math.abs(drag.node.scale.x),
        hh: (drag.natural.height / 2) * Math.abs(drag.node.scale.y),
        rotation: drag.node.rotation,
      });
      return;
    }

    const halfW = Math.max(1, drag.natural.width / 2);
    const halfH = Math.max(1, drag.natural.height / 2);

    if (drag.rotating) {
      const currentAngle = Math.atan2(local.y - drag.centerScreen.y, local.x - drag.centerScreen.x);
      const newRotation = drag.startTransform.rotation + (currentAngle - drag.startAngle);
      drag.node.rotation = newRotation;
      drawDragOverlay({ cx: drag.node.x, cy: drag.node.y, hw: halfW * drag.node.scale.x, hh: halfH * drag.node.scale.y, rotation: newRotation });
      return;
    }

    // resize: always center-anchored — position never changes, only scale.
    // project the pointer into the clip's own (fixed-for-this-gesture)
    // rotated frame first — screen-space dx/dy would be wrong for anything
    // other than an unrotated clip.
    const localPointer = rotateVector(local.x - drag.centerScreen.x, local.y - drag.centerScreen.y, -drag.startTransform.rotation);
    const distX = Math.abs(localPointer.x);
    const distY = Math.abs(localPointer.y);
    let scaleX = drag.startTransform.scaleX;
    let scaleY = drag.startTransform.scaleY;
    const affectsX = drag.mode === "nw" || drag.mode === "ne" || drag.mode === "sw" || drag.mode === "se" || drag.mode === "e" || drag.mode === "w";
    const affectsY = drag.mode === "nw" || drag.mode === "ne" || drag.mode === "sw" || drag.mode === "se" || drag.mode === "n" || drag.mode === "s";
    const lockAspect = isCornerHandle(drag.mode as HandleKind) && (e.ctrlKey || e.metaKey);

    if (lockAspect) {
      const uniform = Math.max(distX / halfW, distY / halfH, MIN_SCALE);
      scaleX = uniform;
      scaleY = uniform;
    } else {
      if (affectsX) scaleX = Math.max(MIN_SCALE, distX / halfW);
      if (affectsY) scaleY = Math.max(MIN_SCALE, distY / halfH);
    }

    drag.node.scale.set(scaleX, scaleY);
    drawDragOverlay({ cx: drag.node.x, cy: drag.node.y, hw: halfW * scaleX, hh: halfH * scaleY, rotation: drag.startTransform.rotation });
  }

  function onPointerUpLike(): void {
    if (!drag) return;
    const finished = drag;
    drag = null;
    endLiveEdit(finished.clipId);
    if (finished.moved) {
      const patch: TransformPatch = {
        x: finished.node.x - getPreviewSize().width / 2,
        y: finished.node.y - getPreviewSize().height / 2,
        scaleX: finished.node.scale.x,
        scaleY: finished.node.scale.y,
      };
      if (finished.rotating) patch.rotation = finished.node.rotation;
      onTransformCommit(finished.clipId, patch);
    }
    draw();
  }

  container.on("pointerdown", onPointerDown);
  container.on("globalpointermove", onGlobalPointerMove);
  container.on("pointerup", onPointerUpLike);
  container.on("pointerupoutside", onPointerUpLike);

  return {
    refresh: draw,
    destroy() {
      container.off("pointerdown", onPointerDown);
      container.off("globalpointermove", onGlobalPointerMove);
      container.off("pointerup", onPointerUpLike);
      container.off("pointerupoutside", onPointerUpLike);
      gfx.destroy();
    },
  };
}

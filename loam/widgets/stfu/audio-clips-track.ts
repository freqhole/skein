/**
 * stfu's audio-clips track — create/drag/trim/delete `AudioClip` entries on
 * their own timeline row, distinct from the cut-segments track. ports the
 * _design_ (not the code) of trek-minus-paris's `editor.js` dub/audio track:
 * click empty space to drop a new (initially content-less) clip, drag a
 * clip's body to move it, drag near an edge to trim it (once it has a real
 * duration), click its delete glyph to remove it. no stored link back to a
 * cut segment is kept (see the plan's audio-clips-track design note) — the
 * timeline just snaps placement to nearby cut-segment edges and other
 * clips' own edges as a placement aid.
 *
 * a clip with no `audioBlobId` yet (a tts clip awaiting generation, or a
 * freshly created placeholder before any of the "audio clip authoring" flows
 * have filled it in) renders with a hatched pattern instead of a solid fill,
 * and — since its real duration is unknown — displays at a fixed nominal
 * width (`PENDING_DISPLAY_SEC`) rather than a trimmable one.
 *
 * geometry is computed in screen px from scratch on every redraw (via
 * `timeline.timeToScreenX()`/`screenXToTime()`), same as `cut-segments-
 * track.ts` — see `video-timeline.ts`'s `trackContentLayer` doc comment for
 * why an unscaled, redraw-on-view-change layer is used instead of a scaled
 * pixi transform.
 */

import type { FederatedPointerEvent } from "pixi.js";
import { Container, Graphics, Text } from "pixi.js";
import { AUDIO_CLIP_TRACK_HEIGHT, type VideoTimelineHandle } from "./video-timeline";
import type { AudioClip } from "./types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

const MARGIN_Y = 3;
const HANDLE_PX = 8; // screen px near a clip's edge that counts as a trim grab, not a move
const SNAP_PX = 8; // screen px within which a dragged/created edge snaps to a nearby edge
const MIN_CLIP_SEC = 0.05;
const DRAG_THRESHOLD_PX = 3; // pointer movement past this counts as a drag, not a click
/** how far (screen px) a moved clip must stray above/below the track row
 *  before it counts as being lifted "out" onto the open canvas, rather than
 *  just an imprecise horizontal move. */
const DRAG_OUT_VERTICAL_PX = 20;
/** nominal display width (seconds) for a clip with no known real duration
 *  yet (durationSec 0, i.e. audio not yet recorded/generated). */
const PENDING_DISPLAY_SEC = 1;

type DragMode = "create" | "move" | "resize-left" | "resize-right";

interface DragState {
  mode: DragMode;
  /** index into the committed clips array; -1 while creating a new one. */
  index: number;
  startClientX: number;
  startStart: number;
  startDuration: number;
  /** live (possibly unclamped) start time tracked across pointermove,
   *  finalized (clamped) into the committed array on pointerup. */
  pendingStart: number;
  moved: boolean;
  /** once true (a "move" drag that strayed far enough vertically), release
   *  lifts the clip off the track entirely instead of committing a move. */
  draggingOut: boolean;
}

export interface AudioClipsTrackOptions {
  timeline: VideoTimelineHandle;
  getClips: () => AudioClip[];
  /** called with the full next array whenever a create/move/trim/delete
   *  completes — the caller persists it (e.g. into the widget's automerge
   *  doc) and should call `refresh()` once that lands. */
  onChange: (next: AudioClip[]) => void;
  getDuration: () => number;
  /** extra snap targets (seconds) placement should stick to besides other
   *  audio clips' own edges — the cut-segments track's own edge times. */
  getSnapTimes?: () => number[];
  /** id generator for a newly created placeholder clip — injectable for
   *  tests; defaults to `crypto.randomUUID()`. */
  genId?: () => string;
  /** the canvas's pan/zoom-independent "world" container — used to convert
   *  the drag-out ghost's screen position into world coordinates. omit to
   *  disable the "track → widget" drag-out gesture entirely (e.g. in a
   *  read-only viewer). */
  getWorldContainer?: () => Container;
  /** called once a clip is lifted far enough above/below the track row and
   *  released — the clip has already been removed from the committed
   *  array (via the normal `onChange`) by the time this fires; the caller
   *  is responsible for turning it into a standalone widget at the given
   *  world coordinates (see stfu/index.ts). */
  onDragOut?: (clip: AudioClip, worldX: number, worldY: number) => void;
  /** called on a plain click (no drag) of an existing clip — opens the
   *  per-clip "author this clip" popover (see clip-editor-panel.ts). */
  onClipTap?: (clip: AudioClip, screenX: number, screenY: number) => void;
}

export interface AudioClipsTrackHandle {
  /** re-draw all clip graphics — call after the clips array changes for
   *  any reason (this track's own `onChange`, or a remote peer's edit
   *  landing via the doc's change subscription). */
  refresh(): void;
  destroy(): void;
}

export function createAudioClipsTrack(options: AudioClipsTrackOptions): AudioClipsTrackHandle {
  const {
    timeline,
    getClips,
    onChange,
    getDuration,
    getSnapTimes,
    genId = () => crypto.randomUUID(),
    getWorldContainer,
    onDragOut,
    onClipTap,
  } = options;

  const rows: Graphics[] = []; // parallel to getClips(), rebuilt each refresh()
  let createPreviewRow: Graphics | null = null;
  let drag: DragState | null = null;
  let ghost: Container | null = null;
  /** index of the clip currently hovered (no active drag) — drives the
   *  delete-glyph/highlight visibility and cursor, independent of dragging;
   *  mirrors `cut-segments-track.ts`'s `hoveredIndex`. */
  let hoveredIndex: number | null = null;

  function buildGhost(clip: AudioClip): Container {
    const c = new Container();
    const bg = new Graphics();
    const label = clip.ttsText || clip.label || "audio clip";
    const text = new Text({
      text: label.length > 40 ? `${label.slice(0, 40)}\u2026` : label,
      style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 },
      resolution: TEXT_RESOLUTION,
    });
    const w = Math.max(60, text.width + 16);
    const h = 24;
    bg.roundRect(0, 0, w, h, 4).fill({ color: 0x1a3a5a, alpha: 0.9 }).stroke({ color: 0x60a5fa, width: 1 });
    text.x = 8;
    text.y = h / 2 - text.height / 2;
    c.addChild(bg, text);
    c.alpha = 0.9;
    return c;
  }

  function updateGhostPosition(worldContainer: Container, e: FederatedPointerEvent): void {
    const local = worldContainer.toLocal(e.global);
    if (ghost) {
      ghost.x = local.x + 12;
      ghost.y = local.y + 12;
    }
  }

  function destroyGhost(): void {
    ghost?.destroy({ children: true });
    ghost = null;
  }

  function pxPerSecond(): number {
    return timeline.timeToScreenX(1) - timeline.timeToScreenX(0);
  }

  function displayDuration(clip: AudioClip): number {
    return clip.durationSec > 0 ? clip.durationSec : PENDING_DISPLAY_SEC;
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
    getClips().forEach((clip, i) => {
      if (i === excludeIndex) return;
      consider(clip.start);
      consider(clip.start + displayDuration(clip));
    });
    (getSnapTimes?.() ?? []).forEach(consider);
    return best;
  }

  function clampStart(start: number, duration: number): number {
    const total = getDuration();
    let s = Math.max(0, start);
    if (total > 0) s = Math.min(Math.max(0, total - duration), s);
    return s;
  }

  // circular glyph + hit test (mirrors cut-segments-track.ts's identical
  // fix) rather than a square — a square's corners reach ~40% farther from
  // center than a circle of the same "radius", silently poaching clicks
  // meant for a resize-right drag just below the glyph's own row.
  function drawDeleteGlyph(g: Graphics, right: number): void {
    const cx = right - 2;
    const cy = MARGIN_Y;
    g.circle(cx, cy, 7).fill({ color: 0x000000, alpha: 0.75 });
    const r = 2.6;
    g.moveTo(cx - r, cy - r)
      .lineTo(cx + r, cy + r)
      .moveTo(cx + r, cy - r)
      .lineTo(cx - r, cy + r)
      .stroke({ width: 1.3, color: 0x80b0e0 });
  }

  function drawClip(g: Graphics, clip: AudioClip, start: number, hovered: boolean): void {
    g.visible = true; // undoes any drag-out-gesture hiding (see onGlobalPointerMove)
    g.clear();
    const dur = displayDuration(clip);
    const x1 = timeline.timeToScreenX(start);
    const x2 = timeline.timeToScreenX(start + dur);
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const width = Math.max(1, right - left);
    const top = MARGIN_Y;
    const height = AUDIO_CLIP_TRACK_HEIGHT - MARGIN_Y * 2;
    const pending = !clip.audioBlobId;

    if (pending) {
      g.roundRect(left, top, width, height, 3).fill({ color: hovered ? 0x2a3242 : 0x222836 });
      // diagonal hatch, clamped to the clip's own rect
      const step = 6;
      for (let x = left - height; x < right; x += step) {
        const x0 = Math.max(left, x);
        const x1h = Math.min(right, x + height);
        if (x1h <= x0) continue;
        g.moveTo(x0, top + height - (x0 - x)).lineTo(x1h, top + height - (x1h - x));
      }
      g.stroke({ width: 1, color: 0x3b82f6, alpha: 0.45 });
      g.roundRect(left, top, width, height, 3).stroke({ color: 0x3b82f6, width: 1 });
    } else {
      g.roundRect(left, top, width, height, 3).fill({ color: hovered ? 0x2a4a6a : 0x1a3a5a });
      g.roundRect(left, top, width, height, 3).stroke({ color: 0x60a5fa, width: 1 });
    }

    if (hovered) {
      drawDeleteGlyph(g, right);
    }
  }

  function hitDeleteGlyph(clip: AudioClip, localX: number, localY: number): boolean {
    const dur = displayDuration(clip);
    const x1 = timeline.timeToScreenX(clip.start);
    const x2 = timeline.timeToScreenX(clip.start + dur);
    const right = Math.max(x1, x2);
    return Math.hypot(localX - (right - 2), localY - MARGIN_Y) <= 8;
  }

  function modeForLocalX(clip: AudioClip, localX: number): DragMode {
    // a clip with no known real duration yet has nothing meaningful to
    // trim — only moving/deleting applies until it has real audio.
    if (clip.durationSec <= 0) return "move";
    const dur = displayDuration(clip);
    const x1 = timeline.timeToScreenX(clip.start);
    const x2 = timeline.timeToScreenX(clip.start + dur);
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    // cap the resize-handle zone to a third of the clip's own width —
    // mirrors cut-segments-track.ts's identical fix, see there for why.
    const handlePx = Math.max(2, Math.min(HANDLE_PX, (right - left) / 3));
    const distLeft = Math.abs(localX - left);
    const distRight = Math.abs(localX - right);
    if (distLeft <= handlePx && distLeft <= distRight) return "resize-left";
    if (distRight <= handlePx) return "resize-right";
    return "move";
  }

  /** resolves a point (in `timeline.audioClipsHitArea`'s local space) to the
   *  topmost clip under it and which region was hit — shared by
   *  `onTrackPointerDown()` and the hover handler below, mirroring
   *  `cut-segments-track.ts`'s `hitTest()`. */
  function hitTest(localX: number, localY: number): { index: number; region: "delete" | DragMode } | null {
    const clips = getClips();
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i];
      const dur = displayDuration(clip);
      const x1 = timeline.timeToScreenX(clip.start);
      const x2 = timeline.timeToScreenX(clip.start + dur);
      const left = Math.min(x1, x2) - HANDLE_PX;
      const right = Math.max(x1, x2) + HANDLE_PX;
      if (localX < left || localX > right) continue;
      if (hitDeleteGlyph(clip, localX, localY)) return { index: i, region: "delete" };
      return { index: i, region: modeForLocalX(clip, localX) };
    }
    return null;
  }

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

  function setHoveredIndex(index: number | null): void {
    if (hoveredIndex === index) return;
    const clips = getClips();
    if (hoveredIndex !== null && rows[hoveredIndex] && clips[hoveredIndex]) {
      drawClip(rows[hoveredIndex], clips[hoveredIndex], clips[hoveredIndex].start, false);
    }
    hoveredIndex = index;
    if (hoveredIndex !== null && rows[hoveredIndex] && clips[hoveredIndex]) {
      drawClip(rows[hoveredIndex], clips[hoveredIndex], clips[hoveredIndex].start, true);
    }
  }

  function commit(next: AudioClip[]): void {
    onChange(next);
    refresh();
  }

  function onTrackPointerDown(e: FederatedPointerEvent): void {
    const local = e.getLocalPosition(timeline.audioClipsHitArea);
    const hit = hitTest(local.x, local.y);
    if (hit) {
      if (hit.region === "delete") {
        commit(getClips().filter((_, idx) => idx !== hit.index));
        return;
      }
      const clip = getClips()[hit.index];
      drag = {
        mode: hit.region,
        index: hit.index,
        startClientX: e.global.x,
        startStart: clip.start,
        startDuration: clip.durationSec,
        pendingStart: clip.start,
        moved: false,
        draggingOut: false,
      };
      return;
    }
    // empty space — drop a new placeholder clip; dragging before release
    // just fine-tunes where it lands.
    const t = timeline.screenXToTime(local.x);
    drag = {
      mode: "create",
      index: -1,
      startClientX: e.global.x,
      startStart: t,
      startDuration: 0,
      pendingStart: t,
      moved: false,
      draggingOut: false,
    };
  }

  function onGlobalPointerMove(e: FederatedPointerEvent): void {
    if (!drag) return;
    const deltaPx = e.global.x - drag.startClientX;
    if (!drag.moved && Math.abs(deltaPx) <= DRAG_THRESHOLD_PX) return;
    drag.moved = true;

    const pps = pxPerSecond();
    const deltaSec = pps > 0 ? deltaPx / pps : 0;

    if (drag.mode === "create") {
      drag.pendingStart = snapTime(drag.startStart + deltaSec, -1);
      if (!createPreviewRow) {
        createPreviewRow = new Graphics();
        createPreviewRow.eventMode = "none"; // purely visual — see cut-segments-track.ts's `g.eventMode` comment.
        timeline.audioClipsContentLayer.addChild(createPreviewRow);
      }
      const preview: AudioClip = {
        id: "",
        trackId: "default",
        start: 0,
        durationSec: 0,
        label: "",
      };
      drawClip(createPreviewRow, preview, clampStart(drag.pendingStart, PENDING_DISPLAY_SEC), true);
      return;
    }

    const row = rows[drag.index];
    const clip = getClips()[drag.index];
    if (!clip) return;

    if (drag.mode === "move") {
      const worldContainer = getWorldContainer?.();
      const localY = e.getLocalPosition(timeline.audioClipsHitArea).y;
      const outOfBounds = localY < -DRAG_OUT_VERTICAL_PX || localY > AUDIO_CLIP_TRACK_HEIGHT + DRAG_OUT_VERTICAL_PX;
      if (worldContainer && outOfBounds) {
        drag.draggingOut = true;
        if (row) row.visible = false;
        if (!ghost) {
          ghost = buildGhost(clip);
          worldContainer.addChild(ghost);
        }
        updateGhostPosition(worldContainer, e);
        return;
      }
      if (drag.draggingOut) {
        // moved back within bounds — revert to a normal horizontal move.
        drag.draggingOut = false;
        destroyGhost();
        if (row) row.visible = true;
      }
      const moved = drag.startStart + deltaSec;
      drag.pendingStart = snapTime(moved, drag.index);
      if (row) drawClip(row, clip, clampStart(drag.pendingStart, drag.startDuration || displayDuration(clip)), true);
      return;
    }

    // resize-left / resize-right only ever applies to clips with a real
    // duration already (see modeForLocalX).
    if (drag.mode === "resize-left") {
      const newStart = snapTime(drag.startStart + deltaSec, drag.index);
      const newDuration = Math.max(MIN_CLIP_SEC, drag.startStart + drag.startDuration - newStart);
      drag.pendingStart = newStart;
      if (row) drawClip(row, { ...clip, durationSec: newDuration }, newStart, true);
    } else {
      const end = snapTime(drag.startStart + drag.startDuration + deltaSec, drag.index);
      const newDuration = Math.max(MIN_CLIP_SEC, end - drag.startStart);
      drag.pendingStart = drag.startStart;
      if (row) drawClip(row, { ...clip, durationSec: newDuration }, drag.startStart, true);
    }
  }

  function onGlobalPointerUp(e: FederatedPointerEvent): void {
    if (!drag) return;
    const finished = drag;
    drag = null;

    if (finished.draggingOut) {
      const worldContainer = getWorldContainer?.();
      const clips = getClips();
      const clip = clips[finished.index];
      const worldPos = worldContainer ? worldContainer.toLocal(e.global) : null;
      destroyGhost();
      if (clip && worldPos) {
        commit(clips.filter((_, idx) => idx !== finished.index));
        onDragOut?.(clip, worldPos.x, worldPos.y);
      } else {
        refresh();
      }
      return;
    }

    if (finished.mode === "create") {
      createPreviewRow?.destroy();
      createPreviewRow = null;
      const start = clampStart(finished.pendingStart, PENDING_DISPLAY_SEC);
      commit([
        ...getClips(),
        {
          id: genId(),
          trackId: "default",
          start,
          durationSec: 0,
          label: "",
        },
      ]);
      return;
    }

    if (!finished.moved) {
      const clip = getClips()[finished.index];
      if (clip) onClipTap?.(clip, e.global.x, e.global.y);
      refresh(); // clears any stray hover state, no-op for the data itself
      return;
    }

    const clips = [...getClips()];
    const clip = clips[finished.index];
    if (!clip) {
      refresh();
      return;
    }

    if (finished.mode === "move") {
      const dur = finished.startDuration || displayDuration(clip);
      clips[finished.index] = { ...clip, start: clampStart(finished.pendingStart, dur) };
    } else if (finished.mode === "resize-left") {
      const newDuration = Math.max(
        MIN_CLIP_SEC,
        finished.startStart + finished.startDuration - finished.pendingStart,
      );
      clips[finished.index] = {
        ...clip,
        start: clampStart(finished.pendingStart, newDuration),
        durationSec: newDuration,
      };
    } else {
      const newDuration = Math.max(MIN_CLIP_SEC, finished.pendingStart - finished.startStart);
      clips[finished.index] = { ...clip, start: finished.startStart, durationSec: newDuration };
    }
    commit(clips);
  }

  // hover (no active drag) — matches editor.js's "globalpointermove" branch
  // taken when nothing is being dragged: updates the cursor + reveals the
  // shared delete glyph for whichever clip/region is under the pointer.
  function onTrackPointerMove(e: FederatedPointerEvent): void {
    if (drag) return; // an active drag already draws its own hover/preview state
    const local = e.getLocalPosition(timeline.audioClipsHitArea);
    const hit = hitTest(local.x, local.y);
    setHoveredIndex(hit ? hit.index : null);
    timeline.audioClipsHitArea.cursor = cursorForRegion(hit ? hit.region : null);
  }

  function onTrackPointerOut(): void {
    if (drag) return;
    setHoveredIndex(null);
    timeline.audioClipsHitArea.cursor = "crosshair";
  }

  timeline.audioClipsHitArea.eventMode = "static";
  timeline.audioClipsHitArea.cursor = "crosshair";
  timeline.audioClipsHitArea.on("pointerdown", onTrackPointerDown);
  timeline.audioClipsHitArea.on("globalpointermove", onGlobalPointerMove);
  timeline.audioClipsHitArea.on("pointerup", onGlobalPointerUp);
  timeline.audioClipsHitArea.on("pointerupoutside", onGlobalPointerUp);
  timeline.audioClipsHitArea.on("pointermove", onTrackPointerMove);
  timeline.audioClipsHitArea.on("pointerout", onTrackPointerOut);

  const offViewChange = timeline.onViewChange(() => refresh());

  function refresh(): void {
    createPreviewRow?.destroy();
    createPreviewRow = null;

    const clips = getClips();
    if (hoveredIndex !== null && hoveredIndex >= clips.length) hoveredIndex = null;
    while (rows.length > clips.length) {
      rows.pop()?.destroy();
    }
    while (rows.length < clips.length) {
      const g = new Graphics();
      g.eventMode = "none"; // purely visual — see cut-segments-track.ts's `g.eventMode` comment.
      timeline.audioClipsContentLayer.addChild(g);
      rows.push(g);
    }
    clips.forEach((clip, i) => drawClip(rows[i], clip, clip.start, i === hoveredIndex));
  }

  refresh();

  return {
    refresh,
    destroy() {
      offViewChange();
      timeline.audioClipsHitArea.off("pointerdown", onTrackPointerDown);
      timeline.audioClipsHitArea.off("globalpointermove", onGlobalPointerMove);
      timeline.audioClipsHitArea.off("pointerup", onGlobalPointerUp);
      timeline.audioClipsHitArea.off("pointerupoutside", onGlobalPointerUp);
      timeline.audioClipsHitArea.off("pointermove", onTrackPointerMove);
      timeline.audioClipsHitArea.off("pointerout", onTrackPointerOut);
      createPreviewRow?.destroy();
      createPreviewRow = null;
      destroyGhost();
      rows.forEach((g) => g.destroy());
      rows.length = 0;
    },
  };
}

/**
 * visual track row adapter — same shape as `audio-track.ts` but for
 * doodle-frame/image/label/video-segment clips. see that file's own doc
 * comment for the shared design (id-keyed generic engine, no
 * create-by-drag, `mergeTrackClips()` reassembly pattern).
 */

import { Graphics, Text } from "pixi.js";
import { createTrackItemInteraction, type Span, type TrackItemInteractionHandle } from "../../../src/widgets/timeline/track-item-interaction";
import { drawTrackItemBody } from "../../../src/widgets/timeline/track-item-render";
import type { TrackCameraView, TrackRowContainers } from "../../../src/widgets/timeline/timeline-types";
import { clipTrackAdapter } from "../clip-track-adapter";
import type { Clip, LabelClip } from "../types";

export const VISUAL_TRACK_ROW_HEIGHT = 40;

const VISUAL_CLIP_COLORS = { fill: 0x3a1a3a, fillHover: 0x5a2a5a, stroke: 0xd946ef };

function labelFor(clip: Clip): string {
  switch (clip.kind) {
    case "doodle-frame":
      return "doodle";
    case "image":
      return "image";
    case "label":
      return (clip as LabelClip).text || "label";
    case "video-segment":
      return "video";
    default:
      return "";
  }
}

export interface VisualTrackOptions {
  trackId: string;
  row: TrackRowContainers;
  camera: TrackCameraView;
  getDuration: () => number;
  isSnapEnabled: () => boolean;
  getSnapTimes?: () => number[];
  getClips: () => Clip[];
  onClipsChange: (next: Clip[]) => void;
  onSelectionChange?: (clip: Clip | null) => void;
  /** lets a move drag reassign this clip to a DIFFERENT track (this row
   *  doesn't know other rows exist) — return `true` if handled, matching
   *  `track-item-interaction.ts`'s own `onMoveOutOfRow` contract. */
  onMoveOutOfRow?: (clip: Clip, span: Span, globalY: number) => boolean;
  /** live ghost-preview hook, fired continuously during a move drag — see
   *  `track-item-interaction.ts`'s own `onDraggingMove` contract. */
  onDraggingMove?: (clip: Clip, span: Span | null, globalY: number) => void;
  /** whether this clip's own backing media blob isn't local yet — drawn
   *  as a dashed border instead of solid (see snatch-controller.ts). */
  isClipRemote?: (clip: Clip) => boolean;
  /** 0..1 live download progress for a remote clip — fills the dashed
   *  border's faint background up to full opacity as it downloads. */
  getClipProgress?: (clip: Clip) => number;
}

export type VisualTrackHandle = Pick<TrackItemInteractionHandle<Clip>, "refresh" | "getSelected" | "deleteSelected" | "clearSelection" | "selectId" | "destroy">;

function clipsForThisTrack(all: Clip[], trackId: string): Clip[] {
  return all.filter(
    (c) => c.trackId === trackId && (c.kind === "doodle-frame" || c.kind === "image" || c.kind === "label" || c.kind === "video-segment")
  );
}

function mergeTrackClips(all: Clip[], trackId: string, next: Clip[]): Clip[] {
  const others = all.filter((c) => c.trackId !== trackId);
  return [...others, ...next];
}

export function createVisualTrack(options: VisualTrackOptions): VisualTrackHandle {
  const { trackId, row, camera, getDuration, isSnapEnabled, getSnapTimes, getClips, onClipsChange, onSelectionChange, onMoveOutOfRow, onDraggingMove, isClipRemote, getClipProgress } = options;

  const labels = new WeakMap<Graphics, Text>();

  return createTrackItemInteraction<Clip>({
    row,
    camera,
    adapter: clipTrackAdapter,
    getItems: () => clipsForThisTrack(getClips(), trackId),
    getDuration,
    isSnapEnabled,
    getSnapTimes,
    allowCreateByDrag: false,
    clampEndToDuration: false,
    // items on a single strip must not overlap each other — overlap is
    // still allowed ACROSS separate tracks (add another track for that);
    // see docs/animaniac-media-segments-plan.md's decision D update.
    preventOverlap: true,
    onMoveOutOfRow,
    onDraggingMove,
    onChange: (nextForTrack) => onClipsChange(mergeTrackClips(getClips(), trackId, nextForTrack)),
    onSelectionChange,
    drawItem(g: Graphics, item: Clip, state) {
      drawTrackItemBody(
        g,
        state.left,
        state.right,
        VISUAL_TRACK_ROW_HEIGHT,
        VISUAL_CLIP_COLORS,
        state.hovered,
        state.hoveredRegion,
        state.selected,
        undefined,
        isClipRemote?.(item),
        getClipProgress?.(item)
      );
      // real thumbnails (a rendered doodle/image/video frame preview) are a
      // follow-up — a plain kind/text label is enough to distinguish clips
      // for the phase-1 static-cel-playback goal.
      let label = labels.get(g);
      if (!label) {
        label = new Text({ text: "", style: { fontSize: 10, fill: 0xf5d0fe } });
        label.anchor.set(0, 0.5);
        g.addChild(label);
        labels.set(g, label);
      }
      label.text = labelFor(item).slice(0, 40);
      label.x = state.left + 6;
      label.y = VISUAL_TRACK_ROW_HEIGHT / 2;
    },
  });
}

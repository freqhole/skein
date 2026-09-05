/**
 * a single unified track row adapter — any clip kind (doodle-frame/image/
 * label/video-segment/voice-recording/tts/audio-segment) can live on any
 * track, so there's no more per-track "visual"/"audio" split (see
 * docs/animaniac-plan.md's decision to unify track kinds). replaces the
 * former separate `visual-track.ts`/`audio-track.ts` — coloring/labeling
 * now branches on the CLIP's own kind rather than the track's.
 */

import { Graphics, Text } from "pixi.js";
import { createTrackItemInteraction, type Span, type TrackItemInteractionHandle } from "../../../src/widgets/timeline/track-item-interaction";
import { drawTrackItemBody, type TrackItemColors } from "../../../src/widgets/timeline/track-item-render";
import type { TrackCameraView, TrackRowContainers } from "../../../src/widgets/timeline/timeline-types";
import { clipTrackAdapter } from "../clip-track-adapter";
import type { AudioSegmentClip, Clip, LabelClip, TtsClip } from "../types";

export const TRACK_ROW_HEIGHT = 40;

const VISUAL_CLIP_COLORS: TrackItemColors = { fill: 0x3a1a3a, fillHover: 0x5a2a5a, stroke: 0xd946ef };
const AUDIO_CLIP_COLORS: TrackItemColors = { fill: 0x1a3a4a, fillHover: 0x2a5a6a, stroke: 0x45c9e6 };

function colorsForClip(clip: Clip): TrackItemColors {
  switch (clip.kind) {
    case "voice-recording":
    case "tts":
    case "audio-segment":
      return AUDIO_CLIP_COLORS;
    default:
      return VISUAL_CLIP_COLORS;
  }
}

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
    case "tts":
      return (clip as TtsClip).ttsText || "tts";
    case "voice-recording":
      return "voice";
    case "audio-segment":
      return (clip as AudioSegmentClip).label || "audio";
    default:
      return "";
  }
}

export interface TrackOptions {
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
   *  doesn't know other rows exist), or drag it out of animaniac entirely
   *  onto the bare canvas — return `true` if handled, matching
   *  `track-item-interaction.ts`'s own `onMoveOutOfRow` contract. */
  onMoveOutOfRow?: (clip: Clip, span: Span, globalY: number, globalX: number) => boolean;
  /** live ghost-preview hook, fired continuously during a move drag — see
   *  `track-item-interaction.ts`'s own `onDraggingMove` contract. */
  onDraggingMove?: (clip: Clip, span: Span | null, globalY: number, globalX: number) => void;
  /** whether this clip's own backing media blob isn't local yet — drawn
   *  as a dashed border instead of solid (see snatch-controller.ts). */
  isClipRemote?: (clip: Clip) => boolean;
  /** 0..1 live download progress for a remote clip — fills the dashed
   *  border's faint background up to full opacity as it downloads. */
  getClipProgress?: (clip: Clip) => number;
  /** a video-segment clip whose own embedded audio is muted — drawn with
   *  the same faint/dashed treatment as a not-yet-local remote clip (a
   *  different reason, same "this isn't fully present" visual language). */
  isClipMuted?: (clip: Clip) => boolean;
  /** true if `clipId` is part of the caller's own cross-track multi-
   *  selection — see `track-item-interaction.ts`'s own `isSelected` doc
   *  comment for the exact click/drag semantics this enables. */
  isSelected?: (clipId: string) => boolean;
  /** Cmd/Ctrl+click toggle-select — see `track-item-interaction.ts`'s own
   *  `onToggleSelect`. */
  onToggleSelect?: (clipId: string) => void;
  /** group-move delta ticks — see `track-item-interaction.ts`'s own
   *  `onBatchDragDelta`. */
  onBatchDragDelta?: (draggedClipId: string, deltaSec: number) => void;
  /** group-move end — see `track-item-interaction.ts`'s own `onBatchDragEnd`. */
  onBatchDragEnd?: (draggedClipId: string, committed: boolean) => void;
}

export type TrackHandle = Pick<
  TrackItemInteractionHandle<Clip>,
  | "refresh"
  | "getSelected"
  | "deleteSelected"
  | "clearSelection"
  | "selectId"
  | "destroy"
  | "beginExternalMove"
  | "previewExternalMove"
  | "commitExternalMove"
  | "cancelExternalMove"
>;

/** clips belonging to this track only — any kind, no restriction. */
function clipsForThisTrack(all: Clip[], trackId: string): Clip[] {
  return all.filter((c) => c.trackId === trackId);
}

/** replaces every clip belonging to `trackId` with `next`, leaving every
 *  other track's clips (and ordering, for the ones that stay) untouched. */
function mergeTrackClips(all: Clip[], trackId: string, next: Clip[]): Clip[] {
  const others = all.filter((c) => c.trackId !== trackId);
  return [...others, ...next];
}

export function createTrack(options: TrackOptions): TrackHandle {
  const {
    trackId,
    row,
    camera,
    getDuration,
    isSnapEnabled,
    getSnapTimes,
    getClips,
    onClipsChange,
    onSelectionChange,
    onMoveOutOfRow,
    onDraggingMove,
    isClipRemote,
    getClipProgress,
    isClipMuted,
    isSelected,
    onToggleSelect,
    onBatchDragDelta,
    onBatchDragEnd,
  } = options;

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
    isSelected,
    onToggleSelect,
    onBatchDragDelta,
    onBatchDragEnd,
    drawItem(g: Graphics, item: Clip, state) {
      const remote = isClipRemote?.(item) ?? false;
      drawTrackItemBody(
        g,
        state.left,
        state.right,
        TRACK_ROW_HEIGHT,
        colorsForClip(item),
        state.hovered,
        state.hoveredRegion,
        state.selected,
        undefined,
        remote,
        getClipProgress?.(item),
        !remote && (isClipMuted?.(item) ?? false)
      );
      // real thumbnails (a rendered doodle/image/video frame preview, or a
      // waveform for audio) are a follow-up — a plain kind/text label is
      // enough to distinguish clips for now.
      let label = labels.get(g);
      if (!label) {
        label = new Text({ text: "", style: { fontSize: 10, fill: 0xf5d0fe } });
        label.anchor.set(0, 0.5);
        g.addChild(label);
        labels.set(g, label);
      }
      label.text = labelFor(item).slice(0, 40);
      label.x = state.left + 6;
      label.y = TRACK_ROW_HEIGHT / 2;
    },
  });
}

/**
 * audio track row adapter — wires the shared `timeline/` kit
 * (`track-item-interaction.ts` + `clip-track-adapter.ts`) to one audio
 * track's own clips (voice-recording/tts/audio-segment). no create-by-drag
 * (per docs/animaniac-media-segments-plan.md decision C, clips only ever
 * arrive via `frame-capture.ts`'s drag-in, wired by `drop-controller.ts`)
 * — move/resize/delete/select only.
 */

import { Graphics, Text } from "pixi.js";
import { createTrackItemInteraction, type TrackItemInteractionHandle } from "../../../src/widgets/timeline/track-item-interaction";
import { drawTrackItemBody } from "../../../src/widgets/timeline/track-item-render";
import type { TrackCameraView, TrackRowContainers } from "../../../src/widgets/timeline/timeline-types";
import { clipTrackAdapter } from "../clip-track-adapter";
import type { AudioSegmentClip, Clip, TtsClip } from "../types";

export const AUDIO_TRACK_ROW_HEIGHT = 32;

const AUDIO_CLIP_COLORS = { fill: 0x1a3a4a, fillHover: 0x2a5a6a, stroke: 0x45c9e6 };

function labelFor(clip: Clip): string {
  if (clip.kind === "tts") return (clip as TtsClip).ttsText || "tts";
  if (clip.kind === "voice-recording") return "voice";
  if (clip.kind === "audio-segment") return (clip as AudioSegmentClip).label || "audio";
  return "";
}

export interface AudioTrackOptions {
  trackId: string;
  row: TrackRowContainers;
  camera: TrackCameraView;
  getDuration: () => number;
  isSnapEnabled: () => boolean;
  getSnapTimes?: () => number[];
  getClips: () => Clip[];
  /** persist a new full clips array (this track's own clips replaced,
   *  every other track's clips untouched) — caller writes it to the doc. */
  onClipsChange: (next: Clip[]) => void;
  onSelectionChange?: (clip: Clip | null) => void;
}

export type AudioTrackHandle = Pick<TrackItemInteractionHandle<Clip>, "refresh" | "getSelected" | "deleteSelected" | "clearSelection" | "selectId" | "destroy">;

/** clips belonging to this track only — the interaction engine operates on
 *  a single track's own array, `mergeTrackClips()` below reassembles the
 *  full document array on write. */
function clipsForThisTrack(all: Clip[], trackId: string): Clip[] {
  return all.filter((c) => c.trackId === trackId && (c.kind === "voice-recording" || c.kind === "tts" || c.kind === "audio-segment"));
}

/** replaces every clip belonging to `trackId` with `next`, leaving every
 *  other track's clips (and ordering, for the ones that stay) untouched. */
function mergeTrackClips(all: Clip[], trackId: string, next: Clip[]): Clip[] {
  const others = all.filter((c) => c.trackId !== trackId);
  return [...others, ...next];
}

export function createAudioTrack(options: AudioTrackOptions): AudioTrackHandle {
  const { trackId, row, camera, getDuration, isSnapEnabled, getSnapTimes, getClips, onClipsChange, onSelectionChange } = options;

  // one small label Text per pooled item Graphics — `drawItem()` is called
  // fresh on every redraw with no persistent per-item state of its own, so
  // this cache (keyed by the Graphics instance the engine already pools by
  // clip id) is what lets the label update in place instead of being
  // recreated (expensive — text measurement) on every redraw.
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
    onChange: (nextForTrack) => onClipsChange(mergeTrackClips(getClips(), trackId, nextForTrack)),
    onSelectionChange,
    drawItem(g: Graphics, item: Clip, state) {
      drawTrackItemBody(g, state.left, state.right, AUDIO_TRACK_ROW_HEIGHT, AUDIO_CLIP_COLORS, state.hovered, state.hoveredRegion, state.selected);
      // a waveform-style thumbnail (mirroring stfu's audio-clips-track.ts)
      // is a follow-up, not needed for the audio-mixtape MVP itself — a
      // plain text label is enough to tell clips apart for now.
      let label = labels.get(g);
      if (!label) {
        label = new Text({ text: "", style: { fontSize: 10, fill: 0xd8f4fb } });
        label.anchor.set(0, 0.5);
        g.addChild(label);
        labels.set(g, label);
      }
      label.text = labelFor(item).slice(0, 40);
      label.x = state.left + 6;
      label.y = AUDIO_TRACK_ROW_HEIGHT / 2;
    },
  });
}

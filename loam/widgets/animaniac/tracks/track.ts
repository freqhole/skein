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
import { drawTrackItemBody, DEFAULT_MARGIN_Y, type TrackItemColors } from "../../../src/widgets/timeline/track-item-render";
import type { TrackCameraView, TrackRowContainers } from "../../../src/widgets/timeline/timeline-types";
import type { PeersMap } from "../../../src/file-utils/file-shared";
import { clipTrackAdapter } from "../clip-track-adapter";
import { effectiveAudioRef } from "../audio-playback";
import { getWaveformEnvelope, resampleEnvelopeRange } from "../waveform-cache";
import { ENVELOPE_HZ } from "../../voice-recording-mouth";
import type { AudioSegmentClip, Clip, LabelClip, TtsClip } from "../types";

export const TRACK_ROW_HEIGHT = 40;

const VISUAL_CLIP_COLORS: TrackItemColors = { fill: 0x3a1a3a, fillHover: 0x5a2a5a, stroke: 0xd946ef };
const AUDIO_CLIP_COLORS: TrackItemColors = { fill: 0x1a3a4a, fillHover: 0x2a5a6a, stroke: 0x45c9e6 };
// bars are resampled down to this count regardless of on-screen pixel
// width (see waveform-cache.ts's own perf notes) — visual fidelity past
// this is imperceptible, and it bounds per-clip draw-call cost at any zoom.
const MAX_WAVEFORM_BARS = 150;

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
  /** for resolving an audio-bearing clip's waveform (see waveform-cache.ts) —
   *  P2P peers, same as every other media resolve in this widget. */
  getPeers?: () => PeersMap | undefined;
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
    getPeers,
    isSelected,
    onToggleSelect,
    onBatchDragDelta,
    onBatchDragEnd,
  } = options;

  const labels = new WeakMap<Graphics, Text>();
  // a mask must never be an ancestor of what it masks (pixi's text
  // pipeline throws — "Cannot read properties of null (reading
  // 'updateElement')" — if it is); a plain sibling Graphics avoids that,
  // same pattern as skein-input.ts's own text mask.
  const labelMasks = new WeakMap<Graphics, Graphics>();
  // dark backdrop behind an expanded (hovered/selected) label, so it stays
  // legible even where it overflows onto a neighboring item's own space.
  const backdrops = new WeakMap<Graphics, Graphics>();
  // line waveform behind everything else — see waveform-cache.ts. `key`
  // is whatever audioBlobId/blake3 the envelope was fetched for, so a
  // later gain rendition (which repoints the EFFECTIVE ref) is detected
  // and re-fetched instead of drawing a now-stale waveform.
  const waveforms = new WeakMap<Graphics, Graphics>();
  const waveformState = new WeakMap<Graphics, { key: string; envelope: Float32Array | null }>();

  // only ever read from the async waveform-ready callback below, well
  // after this synchronous construction (and this const's own
  // initializer) finishes — safe despite drawItem closing over it above
  // its own assignment.
  const handle: TrackItemInteractionHandle<Clip> = createTrackItemInteraction<Clip>({
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
      // real thumbnails (a rendered doodle/image/video frame preview) are
      // a follow-up for visual clip kinds — a line waveform covers audio.
      let waveform = waveforms.get(g);
      if (!waveform) {
        waveform = new Graphics();
        waveform.eventMode = "none";
        g.addChild(waveform);
        waveforms.set(g, waveform);
      }
      waveform.clear();
      const audioRef = effectiveAudioRef(item);
      if (audioRef) {
        const key = audioRef.blake3 || audioRef.blobId;
        let wf = waveformState.get(g);
        if (!wf || wf.key !== key) {
          wf = { key, envelope: null };
          waveformState.set(g, wf);
          void getWaveformEnvelope(audioRef, getPeers).then((envelope) => {
            const current = waveformState.get(g);
            if (current && current.key === key) {
              current.envelope = envelope;
              handle.refresh();
            }
            // self-heal: a clip captured before `sourceDurationSec`
            // existed (or whose probe failed at capture time) has it
            // stuck at 0, which leaves resize-right's own real-duration
            // clamp a no-op (see clip-track-adapter.ts) — this decoded
            // envelope's length IS the real, verified full-source
            // duration, so backfill it onto the clip the first time it
            // resolves. best-effort: skip quietly if the clip's been
            // deleted, or something else already backfilled it first.
            if (envelope && envelope.length > 0) {
              const known = getClips().find((c) => c.id === item.id);
              if (known && "sourceDurationSec" in known && known.sourceDurationSec <= 0) {
                const sourceDurationSec = envelope.length / ENVELOPE_HZ;
                onClipsChange(getClips().map((c) => (c.id === item.id ? { ...c, sourceDurationSec } : c)));
              }
            }
          });
        }
        if (wf.envelope && wf.envelope.length > 0 && "sourceInSec" in item) {
          const { sourceInSec, sourceOutSec } = item;
          const availableWidth = Math.max(1, state.right - state.left);
          // always the same dense bar count regardless of on-screen width
          // (a fine, "line waveform" look — many thin bars, some
          // naturally overlapping at a narrow zoom, reads as one smooth
          // shape rather than a few fat blocks) — see MAX_WAVEFORM_BARS's
          // own doc comment for the per-bucket compute cost this bounds.
          const bars = resampleEnvelopeRange(wf.envelope, sourceInSec, sourceOutSec, MAX_WAVEFORM_BARS);
          const gain = "gainValue" in item ? item.gainValue : 1;
          const plotTop = DEFAULT_MARGIN_Y + 4;
          const plotHeight = TRACK_ROW_HEIGHT - DEFAULT_MARGIN_Y * 2 - 8;
          const midY = plotTop + plotHeight / 2;
          // the TRUE per-bar allotment, NEVER clamped — x positions must
          // stay within [left, right] no matter how many bars there are.
          // only the drawn STROKE width (capped small so it always reads
          // as a thin line, never a fat block) is clamped, kept fully
          // separate from spacing so it can never push bars past the
          // clip's edge — a narrow clip just packs sub-pixel-spaced bars
          // that visually blend into one smooth shape, which is fine.
          const barSpacing = availableWidth / bars.length;
          const strokeWidth = Math.max(0.75, Math.min(1.5, barSpacing * 0.9));
          for (let i = 0; i < bars.length; i++) {
            const x = state.left + i * barSpacing + barSpacing / 2;
            // clamped to the row's own plot height — visually signals
            // "amplified past what fits" rather than drawing off the clip.
            const amplitude = Math.min(1, bars[i] * gain) * (plotHeight / 2);
            if (amplitude < 0.5) continue;
            waveform.moveTo(x, midY - amplitude).lineTo(x, midY + amplitude).stroke({ width: strokeWidth, color: 0xe8e8f5, alpha: 0.55 });
          }
        }
      }
      // a plain kind/text label distinguishes non-audio clip kinds (no
      // waveform above for those) — real thumbnails are a follow-up.
      let backdrop = backdrops.get(g);
      if (!backdrop) {
        backdrop = new Graphics();
        backdrop.eventMode = "none";
        g.addChild(backdrop);
        backdrops.set(g, backdrop);
      }
      let label = labels.get(g);
      if (!label) {
        label = new Text({ text: "", style: { fontSize: 10, fill: 0xf5d0fe } });
        label.anchor.set(0, 0.5);
        g.addChild(label);
        labels.set(g, label);
      }
      label.text = labelFor(item).slice(0, 200);
      label.x = state.left + 6;
      label.y = TRACK_ROW_HEIGHT / 2;
      // clipped to a sibling rect matching the item's own drawn body, so a
      // long label never overflows into a neighboring item's space (must
      // be a sibling, not the body Graphics itself — see labelMasks' own
      // doc comment); hovered/selected widens the mask to the label's own
      // full natural width instead, so it always renders on top (see
      // `redrawItem()`'s own bring-to-front) rather than being clipped.
      // the mask stays ACTIVE either way — pixi only excludes a Graphics
      // from its own normal render pass while it's assigned as someone's
      // `.mask`; briefly unassigning it (`label.mask = null`) made it
      // flash as a plain solid rect for that one frame, so this always
      // keeps SOME mask assigned and just resizes it instead.
      let labelMask = labelMasks.get(g);
      if (!labelMask) {
        labelMask = new Graphics();
        labelMask.eventMode = "none";
        g.addChild(labelMask);
        labelMasks.set(g, labelMask);
      }
      const top = DEFAULT_MARGIN_Y;
      const height = TRACK_ROW_HEIGHT - DEFAULT_MARGIN_Y * 2;
      const expanded = state.hovered || state.selected;
      const maskWidth = expanded ? label.width + 12 : Math.max(1, state.right - state.left);
      labelMask.clear();
      labelMask.rect(state.left, top, maskWidth, height).fill({ color: 0xffffff });
      label.mask = labelMask;
      // legibility when an expanded label overflows onto a neighboring
      // clip's own space (or its label) — a plain dark backdrop sized to
      // the text itself, not the whole clip.
      backdrop.clear();
      if (expanded) {
        backdrop.roundRect(label.x - 4, top + 2, label.width + 8, height - 4, 3).fill({ color: 0x000000, alpha: 0.6 });
      }
    },
  });
  return handle;
}

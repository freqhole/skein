/**
 * adapts animaniac's `Clip` union to the generic `TrackItemAdapter<T>`
 * shape `timeline/track-item-interaction.ts` operates on (see
 * `timeline-types.ts`) — the missing piece between the shared engine and
 * animaniac's own track UI modules (`tracks/visual-track.ts`/`tracks/
 * audio-track.ts`, not yet built).
 *
 * `withSpan()` is the interesting part: the generic engine only ever hands
 * back a new `{start, end}` span, with no explicit "which edge moved"
 * flag — this disambiguates **move** (both edges shifted by the same
 * delta — placement changes, nothing about the clip's own content does)
 * from resize-left/resize-right (only one edge moved) by
 * comparing against the clip's OWN previous span (available via
 * `getSpan(item)` on the pre-resize `item` the engine still holds). for a
 * trimmed segment (audio-segment/video-segment), a resize writes to
 * `sourceInSec`/`sourceOutSec` (a real trim into the source), which is
 * exactly the "trim-interaction" concept docs/animaniac-media-segments-
 * plan.md's checklist calls for — turns out no *separate* interaction
 * engine was needed after all, just this adapter-level disambiguation.
 * for every other clip kind, a resize instead adjusts `durationSec`
 * directly (shortening/lengthening how long the clip stays on screen).
 */

import { clipDurationSec } from "./track-model";
import type { AudioSegmentClip, Clip, VideoSegmentClip } from "./types";
import type { TrackItemAdapter } from "../../src/widgets/timeline/timeline-types";

const EPS = 1e-6;
const MIN_DURATION_SEC = 0.05;

function isTrimmedSegment(clip: Clip): clip is AudioSegmentClip | VideoSegmentClip {
  return clip.kind === "audio-segment" || clip.kind === "video-segment";
}

function hasDurationField(clip: Clip): clip is Exclude<Clip, AudioSegmentClip | VideoSegmentClip> {
  return !isTrimmedSegment(clip);
}

export function getClipSpan(clip: Clip): { start: number; end: number } {
  return { start: clip.start, end: clip.start + clipDurationSec(clip) };
}

/** pure — see module doc for the move-vs-resize disambiguation logic. */
export function withClipSpan(clip: Clip, newSpan: { start: number; end: number }): Clip {
  const old = getClipSpan(clip);
  const startDelta = newSpan.start - old.start;
  const endDelta = newSpan.end - old.end;
  const startChanged = Math.abs(startDelta) > EPS;
  const endChanged = Math.abs(endDelta) > EPS;

  // both edges moved by (about) the same amount -> a plain move: only
  // placement changes, the clip's own content/trim window is untouched.
  if (startChanged && endChanged && Math.abs(startDelta - endDelta) < EPS) {
    return { ...clip, start: newSpan.start };
  }

  if (isTrimmedSegment(clip)) {
    let sourceInSec = clip.sourceInSec;
    let sourceOutSec = clip.sourceOutSec;
    let start = clip.start;
    if (startChanged) {
      sourceInSec = Math.max(0, clip.sourceInSec + startDelta);
      start = newSpan.start;
    }
    if (endChanged) {
      sourceOutSec = Math.max(sourceInSec + MIN_DURATION_SEC, clip.sourceOutSec + endDelta);
    }
    return { ...clip, start, sourceInSec, sourceOutSec } as Clip;
  }

  if (hasDurationField(clip)) {
    let start = clip.start;
    let durationSec = clip.durationSec;
    if (startChanged) {
      durationSec = Math.max(MIN_DURATION_SEC, durationSec - startDelta);
      start = newSpan.start;
    }
    if (endChanged) {
      durationSec = Math.max(MIN_DURATION_SEC, durationSec + endDelta);
    }
    return { ...clip, start, durationSec } as Clip;
  }

  return clip;
}

export const clipTrackAdapter: TrackItemAdapter<Clip> = {
  getId: (clip) => clip.id,
  getSpan: getClipSpan,
  withSpan: withClipSpan,
};

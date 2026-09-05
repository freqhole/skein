/**
 * adapts animaniac's `Clip` union to the generic `TrackItemAdapter<T>`
 * shape `timeline/track-item-interaction.ts` operates on (see
 * `timeline-types.ts`) — the missing piece between the shared engine and
 * animaniac's own unified track UI module (`tracks/track.ts`).
 *
 * `withSpan()` is the interesting part: the generic engine only ever hands
 * back a new `{start, end}` span, with no explicit "which edge moved"
 * flag — this disambiguates **move** (both edges shifted by the same
 * delta — placement changes, nothing about the clip's own content does)
 * from resize-left/resize-right (only one edge moved) by
 * comparing against the clip's OWN previous span (available via
 * `getSpan(item)` on the pre-resize `item` the engine still holds). every
 * audio/video-bearing clip kind (voice-recording/tts/audio-segment/
 * video-segment) is a trimmed segment: a resize writes to
 * `sourceInSec`/`sourceOutSec` (a real trim into the source, on EITHER
 * edge), clamped against `sourceDurationSec` (the real known length of
 * the full source, never mutated after capture — see types.ts's own doc
 * comment) so a trim can never extend past actual content — an unclamped
 * over-trim otherwise lets the timeline keep the clip "active" past where
 * the real audio/video ends, which re-triggers `.play()` on an already-
 * `ended` element and audibly restarts/"repeats" it. for every other clip
 * kind, a resize instead adjusts `durationSec` directly (shortening/
 * lengthening how long the clip stays on screen).
 */

import { clipDurationSec } from "./track-model";
import type { AudioSegmentClip, Clip, TtsClip, VideoSegmentClip, VoiceRecordingClip } from "./types";
import type { TrackItemAdapter } from "../../src/widgets/timeline/timeline-types";

const EPS = 1e-6;
const MIN_DURATION_SEC = 0.05;

type TrimmedSegment = AudioSegmentClip | VideoSegmentClip | VoiceRecordingClip | TtsClip;

function isTrimmedSegment(clip: Clip): clip is TrimmedSegment {
  return clip.kind === "audio-segment" || clip.kind === "video-segment" || clip.kind === "voice-recording" || clip.kind === "tts";
}

function hasDurationField(clip: Clip): clip is Exclude<Clip, TrimmedSegment> {
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
    // 0 (not yet known/probed) leaves a resize unclamped, same best-effort
    // spirit as every other not-yet-probed value in this app.
    const ceiling = clip.sourceDurationSec > 0 ? clip.sourceDurationSec : Infinity;
    let sourceInSec = clip.sourceInSec;
    let sourceOutSec = clip.sourceOutSec;
    let start = clip.start;
    if (startChanged) {
      // clamp to [0, sourceOutSec - MIN_DURATION_SEC] — mirrors the
      // resize-right branch's own sourceOutSec ceiling below, just on the
      // other edge. critically, `start` advances by the SAME (possibly
      // reduced-by-clamping) amount as `sourceInSec` actually moved, not
      // by the raw unclamped `startDelta` — otherwise a drag clamped at
      // either bound left `start` desynced from `sourceInSec`, so the
      // clip's own derived `end` (`start + (sourceOutSec - sourceInSec)`)
      // drifted off the fixed right edge the user never touched, instead
      // of staying pinned there like a resize-left is supposed to.
      const desiredSourceInSec = clip.sourceInSec + startDelta;
      const clampedSourceInSec = Math.max(0, Math.min(sourceOutSec - MIN_DURATION_SEC, desiredSourceInSec));
      start = clip.start + (clampedSourceInSec - clip.sourceInSec);
      sourceInSec = clampedSourceInSec;
    }
    if (endChanged) {
      const desiredSourceOutSec = clip.sourceOutSec + endDelta;
      sourceOutSec = Math.max(sourceInSec + MIN_DURATION_SEC, Math.min(ceiling, desiredSourceOutSec));
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

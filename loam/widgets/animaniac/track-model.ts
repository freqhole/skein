/**
 * pure track/clip data-layer helpers — no pixi, no automerge, fully unit-
 * testable. `compositor.ts`/`export/audio-mixdown.ts`/the track UI modules
 * all read the document through these functions rather than re-deriving
 * "what's active at time t"/"how long is this clip" ad hoc.
 *
 * overlap is a first-class case throughout (see docs/animaniac-media-
 * segments-plan.md decision D) — nothing here prevents or dedupes
 * overlapping clips, within a track or across tracks.
 */

import type { AudioSegmentClip, Clip, Track, VideoSegmentClip } from "./types";

const MIN_CLIP_DURATION_SEC = 0.05;

function isTrimmedSegment(clip: Clip): clip is AudioSegmentClip | VideoSegmentClip {
  return clip.kind === "audio-segment" || clip.kind === "video-segment";
}

/** a clip's on-timeline duration — stored directly for kinds where the
 *  source length is authoritative (voice-recording/tts), or *derived* from
 *  `sourceInSec`/`sourceOutSec` for trimmed segments so a trim edit can
 *  never leave the two disagreeing (see types.ts's schema doc comment). */
export function clipDurationSec(clip: Clip): number {
  if (isTrimmedSegment(clip)) {
    return Math.max(MIN_CLIP_DURATION_SEC, clip.sourceOutSec - clip.sourceInSec);
  }
  return Math.max(0, clip.durationSec);
}

export function clipEnd(clip: Clip): number {
  return clip.start + clipDurationSec(clip);
}

/** every clip whose `[start, start+duration)` window contains `t` —
 *  returns an ARRAY (not a single clip) since overlap is allowed; order
 *  matches `clips`' own array order (callers that need z-order should sort
 *  by track `order` first — see `compositor.ts`). */
export function activeClipsAt(clips: readonly Clip[], t: number): Clip[] {
  return clips.filter((c) => t >= c.start && t < clipEnd(c));
}

export function clipsForTrack(clips: readonly Clip[], trackId: string): Clip[] {
  return clips.filter((c) => c.trackId === trackId);
}

/** total timeline duration — the furthest any clip's own end reaches, or 0
 *  for an empty document. NOT stored in the schema (a cached/derived value
 *  stored alongside its own source would be exactly the "two numbers that
 *  can disagree" problem `clipDurationSec()` above already avoids). this
 *  is the TRUE content duration — used for export (a mixdown shouldn't
 *  have extra silence tacked onto the end) and as the "place a fallback
 *  drop at the end" position; see `computeDisplayDurationSec()` for the
 *  padded value the timeline UI/camera should actually show. */
export function computeTimelineDuration(clips: readonly Clip[]): number {
  return clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

const DEFAULT_DISPLAY_BUFFER_SEC = 5;
const DEFAULT_MIN_DISPLAY_DURATION_SEC = 20;

/** the duration the timeline's CAMERA should show — the true content
 *  duration (`computeTimelineDuration()`) plus a fixed trailing buffer
 *  (room to drop/drag a clip past the current last one without the
 *  timeline feeling "always exactly as long as the longest clip"), floored
 *  at a sensible minimum so a brand-new empty timeline isn't a sliver. */
export function computeDisplayDurationSec(
  clips: readonly Clip[],
  bufferSec = DEFAULT_DISPLAY_BUFFER_SEC,
  minDurationSec = DEFAULT_MIN_DISPLAY_DURATION_SEC
): number {
  return Math.max(minDurationSec, computeTimelineDuration(clips) + bufferSec);
}

/** tracks in their intended render/list order — visual tracks by ascending
 *  `order` (lower first, i.e. drawn first / furthest back) then audio
 *  tracks, each group stable-sorted by `order` then `id` as a tiebreak so
 *  the result is deterministic across peers even if two tracks share an
 *  `order` value. */
export function sortedTracks(tracks: readonly Track[]): Track[] {
  const byOrder = (a: Track, b: Track) => a.order - b.order || a.id.localeCompare(b.id);
  return [...tracks.filter((t) => t.kind === "visual").sort(byOrder), ...tracks.filter((t) => t.kind === "audio").sort(byOrder)];
}

export function nextTrackOrder(tracks: readonly Track[], kind: Track["kind"]): number {
  const same = tracks.filter((t) => t.kind === kind);
  return same.length === 0 ? 0 : Math.max(...same.map((t) => t.order)) + 1;
}

export function addTrack(tracks: readonly Track[], track: Track): Track[] {
  return [...tracks, track];
}

/** removes a track AND every clip on it (a clip with no track would be
 *  unreachable/orphaned — never leave one behind). */
export function removeTrack(tracks: readonly Track[], clips: readonly Clip[], trackId: string): { tracks: Track[]; clips: Clip[] } {
  return {
    tracks: tracks.filter((t) => t.id !== trackId),
    clips: clips.filter((c) => c.trackId !== trackId),
  };
}

export function updateTrack(tracks: readonly Track[], trackId: string, patch: Partial<Track>): Track[] {
  return tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t));
}

export function addClip(clips: readonly Clip[], clip: Clip): Clip[] {
  return [...clips, clip];
}

export function removeClip(clips: readonly Clip[], clipId: string): Clip[] {
  return clips.filter((c) => c.id !== clipId);
}

/** applies a partial update to one clip, preserving every other field —
 *  callers should only ever pass fields valid for that clip's own `kind`
 *  (TypeScript's discriminated union already enforces this at call sites
 *  that know the concrete kind; this helper's `Partial<Clip>` signature is
 *  intentionally loose for the common "just move/resize" case where the
 *  caller only touches shared base fields like `start`/`keyframes`). */
export function updateClip<T extends Clip>(clips: readonly Clip[], clipId: string, patch: Partial<T>): Clip[] {
  return clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c));
}

export function findClip(clips: readonly Clip[], clipId: string): Clip | null {
  return clips.find((c) => c.id === clipId) ?? null;
}

/**
 * animaniac's document schema — tracks[] (arbitrary N strips, visual or
 * audio) + clips[] (a discriminated union, each carrying its own
 * `trackId`). see docs/animaniac-plan.md + docs/animaniac-media-segments-
 * plan.md for the full design/decisions this follows; in short:
 *
 * - multi-track, arbitrary strip count, clips may overlap both within a
 *   single track and across tracks (no non-overlap invariant anywhere).
 * - every clip stores its own transform as a **keyframe list** (even a
 *   single-keyframe/static clip) from day one, so motion tweening (later)
 *   is additive rather than a schema migration — see `transform.ts`.
 * - a clip's `durationSec` is either stored directly (voice-recording/tts,
 *   where the source audio's own length is authoritative once known) or
 *   *derived* from `sourceInSec`/`sourceOutSec` (audio-segment/
 *   video-segment) — never both, to avoid the two ever disagreeing after
 *   a trim edit. see `clipDurationSec()` in `track-model.ts`.
 * - every field is default-backed (matches every other widget's own
 *   "schema stability discipline" convention in this codebase).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// keyframe / transform
// ---------------------------------------------------------------------------

export const easingSchema = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]);
export type EasingId = z.infer<typeof easingSchema>;

/** a clip's transform at one instant, `t` seconds after the clip's own
 *  start (NOT the timeline's absolute time). phase-1 clips have exactly
 *  one keyframe (t=0, static — no interpolation needed); phase-5 motion
 *  tweening adds more without any schema change. */
export const keyframeSchema = z.object({
  t: z.number().default(0),
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().default(1),
  rotation: z.number().default(0),
  opacity: z.number().default(1),
  easing: easingSchema.default("linear"),
});
export type Keyframe = z.infer<typeof keyframeSchema>;

// ---------------------------------------------------------------------------
// tracks
// ---------------------------------------------------------------------------

export const trackKindSchema = z.enum(["visual", "audio"]);
export type TrackKind = z.infer<typeof trackKindSchema>;

export const trackSchema = z.object({
  id: z.string(),
  kind: trackKindSchema,
  label: z.string().default(""),
  /** z-order among visual tracks (higher = drawn on top of lower); ignored
   *  for audio tracks (mixing has no z-order — see `export/audio-mixdown.ts`). */
  order: z.number().default(0),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
});
export type Track = z.infer<typeof trackSchema>;

// ---------------------------------------------------------------------------
// clips — discriminated union, one variant per content kind
// ---------------------------------------------------------------------------

const clipBaseSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  /** placement on animaniac's own timeline, seconds. */
  start: z.number().default(0),
  keyframes: z.array(keyframeSchema).default([{ t: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, easing: "linear" }]),
});

/** a captured doodle-widget snapshot (see `frame-capture.ts`) — an
 *  immutable image, no evolving stroke state (per the parent plan doc's
 *  "self-contained snapshots, not live puppeteering" decision). `imageUrl`
 *  is a `blob:<id>` reference (see `src/file-utils/image-prop-blob.ts`),
 *  never a raw base64 data URL directly in the doc — storing a multi-KB
 *  base64 string as a plain automerge field is a known history-bloat
 *  trap (see repo memory `automerge-gotchas.md`); `renderSnapshot()`'s
 *  output is promoted via `saveImageDataUrlAsBlobRef()` before it's ever
 *  written here. */
export const doodleFrameClipSchema = clipBaseSchema.extend({
  kind: z.literal("doodle-frame"),
  imageUrl: z.string(),
  /** how long this frame stays visible before the next visual-track clip
   *  takes over. */
  durationSec: z.number().default(1),
});
export type DoodleFrameClip = z.infer<typeof doodleFrameClipSchema>;

/** captured from an existing `image` widget's own `url` field, which is
 *  already a `blob:<id>` reference in the common case (see
 *  `image-prop-blob.ts`) — copied as-is, no re-promotion needed. */
export const imageClipSchema = clipBaseSchema.extend({
  kind: z.literal("image"),
  imageUrl: z.string(),
  durationSec: z.number().default(1),
});
export type ImageClip = z.infer<typeof imageClipSchema>;

export const labelClipSchema = clipBaseSchema.extend({
  kind: z.literal("label"),
  text: z.string().default(""),
  color: z.number().default(0xffffff),
  bgColor: z.number().default(0x000000),
  durationSec: z.number().default(1),
});
export type LabelClip = z.infer<typeof labelClipSchema>;

/** a whole voice recording, reusing `stfu`'s `audio-clip-playback.ts`
 *  pattern verbatim once mounted (see `mouth-sync.ts`). the mouth-styling
 *  fields (lipsColor/lipThickness/mouthMood/teethStyle/cupidBowAmount)
 *  mirror `voice-recording.ts`'s own schema fields exactly — copied at
 *  capture time (see `frame-capture.ts`) since the source widget itself
 *  may be edited/removed later, but the clip should keep looking the same. */
export const voiceRecordingClipSchema = clipBaseSchema.extend({
  kind: z.literal("voice-recording"),
  audioBlobId: z.string(),
  audioBlake3: z.string().default(""),
  audioMime: z.string().default(""),
  durationSec: z.number().default(0),
  lipsColor: z.number().default(0xc2455a),
  lipThickness: z.number().default(5),
  mouthMood: z.enum(["frown", "neutral", "smile"]).default("neutral"),
  teethStyle: z.enum(["straight", "curved"]).default("straight"),
  cupidBowAmount: z.number().default(4),
});
export type VoiceRecordingClip = z.infer<typeof voiceRecordingClipSchema>;

export const ttsClipSchema = clipBaseSchema.extend({
  kind: z.literal("tts"),
  /** empty until generated — mirrors stfu's `AudioClip`. */
  audioBlobId: z.string().default(""),
  audioBlake3: z.string().default(""),
  audioMime: z.string().default(""),
  durationSec: z.number().default(0),
  ttsText: z.string().default(""),
  ttsVoiceName: z.string().default(""),
  ttsVoiceLang: z.string().default(""),
  ttsRate: z.number().default(1),
});
export type TtsClip = z.infer<typeof ttsClipSchema>;

/** a trimmed sub-range of a longer audio source — `durationSec` is
 *  *derived* (`sourceOutSec - sourceInSec`), never stored, so trim edits
 *  can't leave the two disagreeing (see `clipDurationSec()`). */
export const audioSegmentClipSchema = clipBaseSchema.extend({
  kind: z.literal("audio-segment"),
  audioBlobId: z.string(),
  audioBlake3: z.string().default(""),
  audioMime: z.string().default(""),
  sourceInSec: z.number().default(0),
  sourceOutSec: z.number(),
  label: z.string().default(""),
});
export type AudioSegmentClip = z.infer<typeof audioSegmentClipSchema>;

/** a trimmed sub-range of a longer video source — renders as a normal pixi
 *  `Sprite` backed by pixi.js's built-in `VideoSource` (`Texture.from`),
 *  NOT a DOM overlay (see docs/animaniac-media-segments-plan.md decision
 *  B) — so it flows through the exact same `resolveTransformAt()` path as
 *  every other visual clip kind. */
export const videoSegmentClipSchema = clipBaseSchema.extend({
  kind: z.literal("video-segment"),
  videoBlobId: z.string(),
  videoBlake3: z.string().default(""),
  videoMime: z.string().default(""),
  sourceInSec: z.number().default(0),
  sourceOutSec: z.number(),
  /** whether the video's own embedded audio plays — default true (muted)
   *  since audio is more often supplied by a separate voice/tts/audio-
   *  segment clip; explicit opt-in avoids doubled/undesired source audio. */
  muted: z.boolean().default(true),
});
export type VideoSegmentClip = z.infer<typeof videoSegmentClipSchema>;

export const clipSchema = z.discriminatedUnion("kind", [
  doodleFrameClipSchema,
  imageClipSchema,
  labelClipSchema,
  voiceRecordingClipSchema,
  ttsClipSchema,
  audioSegmentClipSchema,
  videoSegmentClipSchema,
]);
export type Clip = z.infer<typeof clipSchema>;

/** clip kinds with a visual footprint (rendered by `compositor.ts`) —
 *  belong on a `"visual"` track. */
export const VISUAL_CLIP_KINDS = ["doodle-frame", "image", "label", "video-segment"] as const;
/** clip kinds with an audio footprint (scheduled by `export/audio-
 *  mixdown.ts` and, during live playback, `mouth-sync.ts`/an `<audio>`
 *  element) — belong on an `"audio"` track. a video-segment clip is
 *  visual-only here even when `muted: false`; see docs/animaniac-media-
 *  segments-plan.md's "still-open" note on mixing its own audio in later. */
export const AUDIO_CLIP_KINDS = ["voice-recording", "tts", "audio-segment"] as const;

// ---------------------------------------------------------------------------
// top-level document
// ---------------------------------------------------------------------------

export const animaniacSchema = z.object({
  tracks: z.array(trackSchema).default([
    { id: "visual-1", kind: "visual", label: "visual", order: 0, muted: false, hidden: false },
    { id: "audio-1", kind: "audio", label: "audio", order: 0, muted: false, hidden: false },
  ]),
  clips: z.array(clipSchema).default([]),
});
export type AnimaniacState = z.infer<typeof animaniacSchema>;

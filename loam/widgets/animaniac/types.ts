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
 * - a clip's `durationSec` is *derived* from `sourceInSec`/`sourceOutSec`
 *   for every audio/video-bearing kind (voice-recording/tts/audio-segment/
 *   video-segment) — never stored directly, so it can't disagree with the
 *   trim window after an edit. see `clipDurationSec()` in `track-model.ts`.
 *   `sourceDurationSec` (also on those same kinds) is a SEPARATE, never-
 *   mutated-after-capture ceiling — the real known length of the full
 *   source — so a resize can be clamped to it and never trim "past the
 *   end of the actual audio" (which otherwise re-triggers `.play()` on an
 *   already-`ended` element, audibly restarting/"repeating" it).
 * - every field is default-backed (matches every other widget's own
 *   "schema stability discipline" convention in this codebase).
 */

import { z } from "zod";
import { strokeSchema } from "../doodle";

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
  scaleX: z.number().default(1),
  scaleY: z.number().default(1),
  rotation: z.number().default(0),
  opacity: z.number().default(1),
  easing: easingSchema.default("linear"),
});
export type Keyframe = z.infer<typeof keyframeSchema>;

// ---------------------------------------------------------------------------
// tracks
// ---------------------------------------------------------------------------

export const trackSchema = z.object({
  id: z.string(),
  label: z.string().default(""),
  /** z-order among tracks (higher = drawn on top of lower, for visual
   *  clips — ignored for a track's audio clips, mixing has no z-order). */
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
  keyframes: z.array(keyframeSchema).default([{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" }]),
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
  /** node ids known to have this clip's own blob locally — mirrors
   *  file.ts/voice-recording.ts's own `snatchedBy` field, but nested per-
   *  clip here since one animaniac doc can carry many independent blobs
   *  (see tumulus/src/snatch.rs's own per-clip extraction). lets a peer
   *  (or the hub, after it finishes snatching) discover who else to ask
   *  for this blob without a live ephemeral ping. */
  snatchedBy: z.array(z.string()).default([]),
  /** the FULL doodle source state (strokes + drawing settings) captured
   *  alongside `imageUrl` above, purely so a later drag-out-to-canvas
   *  restore (`clip-restore.ts`) can rebuild an actual re-editable doodle
   *  widget instead of a flat image — never read by `compositor.ts` (it
   *  still just renders `imageUrl` as a static sprite, matching every
   *  other visual clip kind's own "self-contained snapshot" rendering).
   *  optional/absent for a clip captured before this field existed, or
   *  one whose source doodle was empty at capture time — restores as a
   *  plain `image` widget then (see `clip-restore.ts`'s own fallback). */
  sourceDoodle: z
    .object({
      strokes: z.array(strokeSchema).default([]),
      bgColor: z.number().default(-1),
      penColor: z.number().default(0xd946ef),
      penWidth: z.number().default(3),
      pressureScale: z.number().default(0),
      brushShape: z.string().default("circle"),
      angleScale: z.number().default(0),
      chiselAngle: z.number().default(-45),
      penOpacity: z.number().default(100),
      borderColor: z.number().default(0xa855f7),
      borderWidth: z.number().default(1),
      /** the source doodle widget's own on-canvas size at capture time —
       *  stroke points are in that widget's own local coordinates, so a
       *  restore recreates it at this same size rather than the doodle
       *  widget factory's generic default (which would shift/crop/scale
       *  the strokes if it differed). falls back to that same generic
       *  default (640x340) for a clip captured before this existed. */
      width: z.number().default(640),
      height: z.number().default(340),
    })
    .optional(),
});
export type DoodleFrameClip = z.infer<typeof doodleFrameClipSchema>;

/** captured from an existing `image` widget's own `url` field, which is
 *  already a `blob:<id>` reference in the common case (see
 *  `image-prop-blob.ts`) — copied as-is, no re-promotion needed. */
export const imageClipSchema = clipBaseSchema.extend({
  kind: z.literal("image"),
  imageUrl: z.string(),
  durationSec: z.number().default(1),
  snatchedBy: z.array(z.string()).default([]),
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
/** gain fields shared by every audio-bearing clip kind (voice-recording/
 *  tts/audio-segment) — see voice-recording.ts's mirror of this same
 *  concept for the full rationale. always rendered from the WHOLE
 *  original source (never just a trimmed range), so a clip stays correct
 *  across later re-trims. `gainValue` 1 (default) means "play
 *  `audioBlobId` unmodified"; a non-empty `gainRenditionBlobId` always
 *  takes precedence over it once set. */
const gainFields = {
  gainValue: z.number().default(1),
  gainRenditionBlobId: z.string().default(""),
  gainRenditionBlake3: z.string().default(""),
  gainRenditionMime: z.string().default(""),
  gainRenditionSize: z.number().default(0),
  /** node IDs that have snatched (or rendered) the gain rendition blob —
   *  kept separate from `snatchedBy` since it's a DIFFERENT blob; peers
   *  who only ever fetched the original would otherwise be wrongly
   *  reported as having the rendition too. */
  gainRenditionSnatchedBy: z.array(z.string()).default([]),
};

/** the real, known length of a clip's full (untrimmed) source — set ONCE
 *  at capture time (or on first successful probe for a legacy clip
 *  predating this field) and never mutated by a later resize/trim. `0`
 *  means "not yet known" (a resize is left unclamped in that case, same
 *  best-effort spirit as every other not-yet-probed value in this app).
 *  this is what lets a trim resize be clamped so it can never extend past
 *  actual audio/video content — see `withClipSpan()`'s own doc comment
 *  for why that matters (an unclamped over-trim silently "repeats" the
 *  clip's audio once playback runs past the real content and re-triggers
 *  `.play()` on an already-`ended` element). */
const sourceDurationField = {
  sourceDurationSec: z.number().default(0),
};

export const voiceRecordingClipSchema = clipBaseSchema.extend({
  kind: z.literal("voice-recording"),
  audioBlobId: z.string(),
  audioBlake3: z.string().default(""),
  audioMime: z.string().default(""),
  sourceInSec: z.number().default(0),
  sourceOutSec: z.number(),
  lipsColor: z.number().default(0xc2455a),
  lipThickness: z.number().default(5),
  mouthMood: z.enum(["frown", "neutral", "smile"]).default("neutral"),
  teethStyle: z.enum(["straight", "curved"]).default("straight"),
  cupidBowAmount: z.number().default(4),
  /** see `doodleFrameClipSchema.snatchedBy`'s own doc comment. */
  snatchedBy: z.array(z.string()).default([]),
  ...gainFields,
  ...sourceDurationField,
});
export type VoiceRecordingClip = z.infer<typeof voiceRecordingClipSchema>;

export const ttsClipSchema = clipBaseSchema.extend({
  kind: z.literal("tts"),
  /** empty until generated — mirrors stfu's `AudioClip`. */
  audioBlobId: z.string().default(""),
  audioBlake3: z.string().default(""),
  audioMime: z.string().default(""),
  sourceInSec: z.number().default(0),
  sourceOutSec: z.number(),
  ttsText: z.string().default(""),
  ttsVoiceName: z.string().default(""),
  ttsVoiceLang: z.string().default(""),
  ttsRate: z.number().default(1),
  snatchedBy: z.array(z.string()).default([]),
  ...gainFields,
  ...sourceDurationField,
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
  /** byte size of the source blob — carried over purely so a drag-out
   *  restore (clip-restore.ts) can show the right file size again; never
   *  read by the compositor/playback itself. */
  audioSize: z.number().default(0),
  sourceInSec: z.number().default(0),
  sourceOutSec: z.number(),
  label: z.string().default(""),
  snatchedBy: z.array(z.string()).default([]),
  ...gainFields,
  ...sourceDurationField,
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
  /** byte size of the source blob — same purpose as `audioSegmentClipSchema.audioSize`. */
  videoSize: z.number().default(0),
  sourceInSec: z.number().default(0),
  sourceOutSec: z.number(),
  /** whether the video's own embedded audio plays — default false (audio
   *  audible) so a dropped-in video's soundtrack is present by default.
   *  toggled via the timeline's own selected-clip "mute"/"unmute" action
   *  (see index.ts's `toggleMuteVideoClip()`), rendered with the same
   *  faint/dashed visual cue a not-yet-local clip gets (see track-item-
   *  render.ts's `drawTrackItemBody()`'s own `mutedLook` option). */
  muted: z.boolean().default(false),
  /** see `doodleFrameClipSchema.snatchedBy`'s own doc comment. */
  snatchedBy: z.array(z.string()).default([]),
  ...sourceDurationField,
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

/** clip kinds with a visual footprint (rendered by `compositor.ts`). */
export const VISUAL_CLIP_KINDS = ["doodle-frame", "image", "label", "video-segment"] as const;
/** clip kinds with an audio footprint (scheduled by `export/audio-
 *  mixdown.ts` and, during live playback, `mouth-sync.ts`/an `<audio>`
 *  element). a video-segment clip is visual-only here even when
 *  `muted: false`; see docs/animaniac-media-segments-plan.md's
 *  "still-open" note on mixing its own audio in later. */
export const AUDIO_CLIP_KINDS = ["voice-recording", "tts", "audio-segment"] as const;

// ---------------------------------------------------------------------------
// top-level document
// ---------------------------------------------------------------------------

export const animaniacSchema = z.object({
  tracks: z.array(trackSchema).default([{ id: "track-1", label: "", order: 0, muted: false, hidden: false }]),
  clips: z.array(clipSchema).default([]),
});
export type AnimaniacState = z.infer<typeof animaniacSchema>;

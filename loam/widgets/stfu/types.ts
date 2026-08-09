/**
 * stfu (cut-timeline) widget — schema for a video/audio cut-editor widget.
 * see docs/stfu-widget-plan.md for the full design. this file only defines
 * the document shape; loam/widgets/stfu/index.ts implements the current
 * (early) behavior against it.
 *
 * every field is default-backed from day one (see the plan's "schema
 * stability discipline" section) so later phases can fill in behavior
 * without reshaping existing documents.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// audio clips track
// ---------------------------------------------------------------------------

export const audioClipSchema = z.object({
  id: z.string(),
  /** which audio track row this clip lives on — a single "default" track
   *  for now; multiple tracks are a later phase. */
  trackId: z.string().default("default"),
  /** clip start time on the timeline, in seconds */
  start: z.number(),
  durationSec: z.number().default(0),
  label: z.string().default(""),
  /** which authoring source this clip is committed to, once one has been
   *  picked — undefined means "not yet decided" (a brand-new placeholder
   *  clip with neither tts text nor a recording). switching a clip to
   *  "recording" clears any tts* fields below (mutually exclusive); there's
   *  no UI to switch back to "tts" on the same clip — delete it and create
   *  a fresh one instead. */
  kind: z.enum(["tts", "recording"]).optional(),
  // -- recorded/uploaded audio source (mutually exclusive with tts* below) --
  audioBlobId: z.string().optional(),
  audioBlake3: z.string().optional(),
  audioMime: z.string().optional(),
  audioFilename: z.string().optional(),
  audioSize: z.number().optional(),
  // -- tts source (mutually exclusive with audioBlobId above) --------------
  ttsText: z.string().optional(),
  ttsVoiceName: z.string().optional(),
  ttsVoiceLang: z.string().optional(),
  ttsRate: z.number().optional(),
});
export type AudioClip = z.infer<typeof audioClipSchema>;

// ---------------------------------------------------------------------------
// transcript / diarization
// ---------------------------------------------------------------------------

export const referenceSpeakerSchema = z.object({
  name: z.string().default(""),
  /** pixi hex color used to tint this speaker's transcript segments */
  color: z.number().default(0x60a5fa),
  /** which `ReferenceTrack` (see below) this speaker is grouped under in
   *  the reference dialog — always a valid id from `referenceTracks`
   *  (falls back to the first track's id if its own track was removed). */
  trackId: z.string().default("default"),
  // -- speaker sample clip (process.py's `{speaker}_sample_{i}{ext}`,
  // picked up from a `{video title}_speaker_samples/` dir alongside the
  // rest of a project's reference data — see reference-data-actions.ts) --
  sampleVideoBlobId: z.string().optional(),
  sampleVideoBlake3: z.string().optional(),
  sampleVideoMime: z.string().optional(),
  sampleVideoFilename: z.string().optional(),
  sampleVideoSize: z.number().optional(),
  // -- speaker sample thumbnail (process.py's `{speaker}_sample_{i}_thumb.jpg`,
  // a frame grabbed from the middle of the sample clip) --
  thumbnailBlobId: z.string().optional(),
  thumbnailBlake3: z.string().optional(),
  thumbnailMime: z.string().optional(),
  thumbnailFilename: z.string().optional(),
  thumbnailSize: z.number().optional(),
});
export type ReferenceSpeaker = z.infer<typeof referenceSpeakerSchema>;

// ---------------------------------------------------------------------------
// reference tracks (speaker groupings shown in the reference dialog)
// ---------------------------------------------------------------------------

export const referenceTrackSchema = z.object({
  id: z.string(),
  /** only shown/editable once there's more than one track — see
   *  reference-dialog.ts. */
  label: z.string().default(""),
});
export type ReferenceTrack = z.infer<typeof referenceTrackSchema>;

/** every document starts with exactly one track (matching every speaker's
 *  own `trackId` default of `"default"`) so a fresh project needs no
 *  migration before it can be grouped further. */
export const DEFAULT_REFERENCE_TRACK_ID = "default";

/** resolves which `ReferenceTrack` a speaker belongs to — falls back to the
 *  canonical default track (or the first track) if the speaker's own
 *  `trackId` doesn't match any current track (e.g. its track was removed).
 *  shared between reference-dialog.ts (the grouping UI) and
 *  reference-track.ts (one timeline row per track) so both agree on the
 *  same speaker→track assignment. */
export function resolveReferenceTrackId(speaker: ReferenceSpeaker, tracks: ReferenceTrack[]): string {
  if (speaker.trackId && tracks.some((t) => t.id === speaker.trackId)) return speaker.trackId;
  return tracks.find((t) => t.id === DEFAULT_REFERENCE_TRACK_ID)?.id ?? tracks[0]?.id ?? DEFAULT_REFERENCE_TRACK_ID;
}

export const transcriptSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  speaker: z.string().default(""),
  text: z.string().default(""),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

// ---------------------------------------------------------------------------
// revisions (heads-based snapshots)
// ---------------------------------------------------------------------------

export const stfuRevisionSchema = z.object({
  n: z.number(),
  createdAt: z.string(),
  /** automerge heads (change hashes) this revision points at — see
   *  `A.getHeads()`/`A.view()` from `@automerge/automerge/slim`. */
  heads: z.array(z.string()),
  label: z.string().default(""),
});
export type StfuRevision = z.infer<typeof stfuRevisionSchema>;

// ---------------------------------------------------------------------------
// top-level document
// ---------------------------------------------------------------------------

export const stfuSchema = z.object({
  // -- source video ----------------------------------------------------------
  videoBlobId: z.string().default(""),
  videoFilename: z.string().default(""),
  videoMime: z.string().default(""),
  videoSize: z.number().default(0),
  videoBlake3: z.string().default(""),
  videoDurationSec: z.number().default(0),
  /** frames/sec — best-effort, populated once a probe pipeline exists.
   *  0 means unknown. */
  videoFps: z.number().default(0),
  /** single-flight upload lock, mirrors file.ts's uploadingBy/uploadingAt. */
  uploadingBy: z.string().default(""),
  uploadingAt: z.number().default(0),

  // -- transcript / diarization ------------------------------------------------
  referenceSpeakers: z.record(z.string(), referenceSpeakerSchema).default({}),
  transcriptSegments: z.array(transcriptSegmentSchema).default([]),
  /** speaker groupings shown in the reference dialog — see
   *  `DEFAULT_REFERENCE_TRACK_ID` above. */
  referenceTracks: z.array(referenceTrackSchema).default([{ id: DEFAULT_REFERENCE_TRACK_ID, label: "" }]),

  // -- cut timeline -------------------------------------------------------------
  /** [start, end] ranges (seconds) the user has marked for removal */
  editableSegments: z.array(z.tuple([z.number(), z.number()])).default([]),
  cutSkipEnabled: z.boolean().default(true),
  cutMuteEnabled: z.boolean().default(false),

  // -- audio clips track ----------------------------------------------------------
  audioClips: z.array(audioClipSchema).default([]),
  /**
   * preferred mic input device label for new/re-recorded audio clips
   * (property-tray "mic input device" select) — empty string means system
   * default. matched against enumerateDevices() labels; if the label isn't
   * found on this machine, recording falls back to default (mirrors
   * audio-recording.ts's deviceLabel field).
   */
  micDeviceLabel: z.string().default(""),

  // -- tts defaults applied to new clips on this widget ------------------------------
  ttsDefaultVoiceName: z.string().default(""),
  ttsDefaultVoiceLang: z.string().default(""),
  ttsDefaultRate: z.number().default(1),

  // -- revisions ------------------------------------------------------------------
  revisions: z.array(stfuRevisionSchema).default([]),
});
export type StfuState = z.infer<typeof stfuSchema>;

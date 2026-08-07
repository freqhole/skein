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
  // -- recorded/uploaded audio source (mutually exclusive with tts* below) --
  audioBlobId: z.string().optional(),
  audioBlake3: z.string().optional(),
  audioMime: z.string().optional(),
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
});
export type ReferenceSpeaker = z.infer<typeof referenceSpeakerSchema>;

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

  // -- cut timeline -------------------------------------------------------------
  /** [start, end] ranges (seconds) the user has marked for removal */
  editableSegments: z.array(z.tuple([z.number(), z.number()])).default([]),
  cutSkipEnabled: z.boolean().default(true),
  cutMuteEnabled: z.boolean().default(false),

  // -- audio clips track ----------------------------------------------------------
  audioClips: z.array(audioClipSchema).default([]),

  // -- tts defaults applied to new clips on this widget ------------------------------
  ttsDefaultVoiceName: z.string().default(""),
  ttsDefaultVoiceLang: z.string().default(""),
  ttsDefaultRate: z.number().default(1),

  // -- revisions ------------------------------------------------------------------
  revisions: z.array(stfuRevisionSchema).default([]),
});
export type StfuState = z.infer<typeof stfuSchema>;

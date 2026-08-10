/**
 * standalone tts widget's document schema — field names deliberately mirror
 * `audioRecordingSchema` (`blobId`/`filename`/`mime`/`size`/`blake3`/
 * `duration`/`snatchedBy`) so converting one into the other via the
 * cross-widget drag mechanism is a straight field rename, not a reshape.
 */

import { z } from "zod";

/** `SpeechSynthesisUtterance.rate` / the rust `say -r` wpm mapping both
 *  scale from this same portable multiplier — 1 is normal speed. */
export const DEFAULT_TTS_RATE = 1;
export const MIN_TTS_RATE = 0.5;
export const MAX_TTS_RATE = 2;

export const ttsSchema = z.object({
  /** the text to speak/generate */
  ttsText: z.string().default(""),
  /** voice hint, resolved locally per browser/machine — empty = system default */
  ttsVoiceName: z.string().default(""),
  /** BCP-47 fallback filter for a peer without this exact voice installed */
  ttsVoiceLang: z.string().default(""),
  ttsRate: z.number().default(DEFAULT_TTS_RATE),
  /** empty = reference-only, no generated audio yet */
  blobId: z.string().default(""),
  filename: z.string().default(""),
  mime: z.string().default(""),
  size: z.number().default(0),
  blake3: z.string().default(""),
  /** seconds, once generated */
  duration: z.number().default(0),
  /** peak-per-bucket waveform thumbnail, computed once after generation */
  waveformSamples: z.array(z.number()).default([]),
  /** ttsText as of the last successful generate — lets the widget flag
   *  audio as stale once the text has since been edited */
  ttsTextAtGenerate: z.string().default(""),
  /** node ids that have snatched (or generated) this blob */
  snatchedBy: z.array(z.string()).default([]),
  /** widget background color; -1 = transparent */
  bgColor: z.number().default(0x1e1e2e),
  /** border color; -1 = transparent */
  borderColor: z.number().default(-1),
  /** border width in pixels; 0 = no border */
  borderWidth: z.number().default(0),
});

export type TtsState = z.infer<typeof ttsSchema>;

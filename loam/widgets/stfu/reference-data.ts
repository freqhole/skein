/**
 * parsing + merging for stfu's "load reference data..." action. trek-minus-
 * paris keeps diarization (`*_audio_diarize.json`, a dict of
 * `{ speakerLabel: [[start, end], ...] }`) and transcript
 * (`*_audio_transcribe.json`, whisper's `{ text, segments: [{start, end,
 * text}] }`) as two separate files/arrays, matched up on the fly when
 * rendering (`textForRange()`) — plus, since `process.py`, a combined
 * `*_reference.json` (`{ speakers: {...diarize shape...}, segments:
 * [...transcribe shape...] }`) that bundles both in one file. skein's
 * `stfuSchema` unifies all of these into one `transcriptSegments: {start,
 * end, speaker, text}[]` array, so loading any one of the three files (in
 * any order, since real projects have the two separate files lying around
 * from before `process.py` started writing the combined one too) merges
 * into that single array by time-range overlap.
 */

import { DEFAULT_REFERENCE_TRACK_ID, type ReferenceSpeaker, type SpeakerSample, type TranscriptSegment } from "./types";

// golden-angle hue spread — same constants as editor.js's
// `computeSpeakerColors()`, offset away from the red playhead / magenta
// cutlist accent.
const SPEAKER_HUE_OFFSET = 200;
const SPEAKER_HUE_STEP = 137.508;

/** deterministic per-index speaker color, matching editor.js's algorithm. */
export function speakerColorForIndex(index: number): number {
  const hue = (SPEAKER_HUE_OFFSET + index * SPEAKER_HUE_STEP) % 360;
  return hslToColorInt(hue, 65, 55);
}

/** black or white — whichever reads better on top of `bgColor`, by relative luminance. */
export function contrastTextColor(bgColor: number): number {
  const r = (bgColor >> 16) & 0xff;
  const g = (bgColor >> 8) & 0xff;
  const b = bgColor & 0xff;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? 0x000000 : 0xffffff;
}

function hslToColorInt(h: number, s: number, l: number): number {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp >= 1 && hp < 2) [r, g, b] = [x, c, 0];
  else if (hp >= 2 && hp < 3) [r, g, b] = [0, c, x];
  else if (hp >= 3 && hp < 4) [r, g, b] = [0, x, c];
  else if (hp >= 4 && hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = light - c / 2;
  const toByte = (v: number) => Math.round(Math.max(0, Math.min(1, v + m)) * 255);
  return (toByte(r) << 16) | (toByte(g) << 8) | toByte(b);
}

export interface ParsedDiarizeData {
  kind: "diarize";
  /** speaker label -> [start, end] ranges, seconds */
  ranges: Record<string, [number, number][]>;
}

export interface ParsedTranscribeData {
  kind: "transcribe";
  segments: { start: number; end: number; text: string }[];
}

export interface ParsedCombinedData {
  kind: "combined";
  ranges: Record<string, [number, number][]>;
  segments: { start: number; end: number; text: string }[];
}

/** `process.py`'s `generate_speaker_samples()` naming convention:
 *  `{speaker}_sample_{i}{ext}` for the clip, `{speaker}_sample_{i}_thumb.jpg`
 *  for its thumbnail (a frame grabbed from the clip's midpoint) — both
 *  written into a `{video title}_speaker_samples/` directory alongside a
 *  project's diarize/transcribe/reference json. */
const SPEAKER_SAMPLE_FILENAME_RE = /^(.+)_sample_(\d+)(_thumb)?\.[^.]+$/;

export interface ParsedSpeakerSampleFilename {
  speaker: string;
  index: number;
  kind: "video" | "thumbnail";
}

/** parse a speaker-sample filename (see `SPEAKER_SAMPLE_FILENAME_RE`), or
 *  return null if `filename` doesn't match that convention at all. */
export function parseSpeakerSampleFilename(filename: string): ParsedSpeakerSampleFilename | null {
  const match = SPEAKER_SAMPLE_FILENAME_RE.exec(filename);
  if (!match) return null;
  return {
    speaker: match[1],
    index: Number(match[2]),
    kind: match[3] ? "thumbnail" : "video",
  };
}

function parseRangesDict(obj: Record<string, unknown>): Record<string, [number, number][]> | null {
  const entries = Object.entries(obj);
  if (entries.length === 0) return null;

  const ranges: Record<string, [number, number][]> = {};
  for (const [label, value] of entries) {
    if (!Array.isArray(value)) return null;
    const parsedRanges: [number, number][] = [];
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length < 2 || typeof pair[0] !== "number" || typeof pair[1] !== "number") {
        return null;
      }
      parsedRanges.push([pair[0], pair[1]]);
    }
    ranges[label] = parsedRanges;
  }
  return ranges;
}

function parseSegmentsArray(raw: unknown[]): { start: number; end: number; text: string }[] {
  const segments: { start: number; end: number; text: string }[] = [];
  for (const s of raw) {
    if (
      s &&
      typeof s === "object" &&
      typeof (s as Record<string, unknown>).start === "number" &&
      typeof (s as Record<string, unknown>).end === "number"
    ) {
      const rec = s as Record<string, unknown>;
      segments.push({
        start: rec.start as number,
        end: rec.end as number,
        text: typeof rec.text === "string" ? rec.text.trim() : "",
      });
    }
  }
  return segments;
}

/**
 * detect + parse a diarization cache (`{ label: [[s, e], ...] }`), a
 * whisper transcript cache (`{ text: string, segments: [...] }`), or
 * `process.py`'s combined `{ speakers: {...}, segments: [...] }` export.
 * returns null if `raw` matches none of these shapes.
 */
export function parseReferenceDataJson(
  raw: unknown
): ParsedDiarizeData | ParsedTranscribeData | ParsedCombinedData | null {
  if (raw === null || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;

  if (obj.speakers && typeof obj.speakers === "object" && Array.isArray(obj.segments)) {
    const ranges = parseRangesDict(obj.speakers as Record<string, unknown>);
    if (ranges) return { kind: "combined", ranges, segments: parseSegmentsArray(obj.segments) };
  }

  if (Array.isArray(obj.segments)) {
    return { kind: "transcribe", segments: parseSegmentsArray(obj.segments) };
  }

  if (Array.isArray(raw)) return null;

  const ranges = parseRangesDict(obj);
  if (!ranges) return null;
  return { kind: "diarize", ranges };
}


function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** shallow-clones a speaker entry but deep-clones `samples` (and each
 *  sample object within it) — a plain `{ ...speaker }` would otherwise carry
 *  the *same* doc-owned array/objects into a freshly built record that gets
 *  written back with one assignment (`d.referenceSpeakers = nextSpeakers`),
 *  which automerge rejects ("Cannot create a reference to an existing
 *  document object" — the same array/object can't exist at two paths in
 *  one document). */
function cloneReferenceSpeaker(speaker: ReferenceSpeaker): ReferenceSpeaker {
  return { ...speaker, samples: Array.isArray(speaker.samples) ? speaker.samples.map((s) => ({ ...s })) : [] };
}

export interface MergedReferenceData {
  referenceSpeakers: Record<string, ReferenceSpeaker>;
  transcriptSegments: TranscriptSegment[];
}

/**
 * merge a parsed diarization cache into `referenceSpeakers`/
 * `transcriptSegments`, returning entirely new plain objects/arrays rather
 * than mutating the inputs in place — callers write the whole result back
 * into an automerge draft with one assignment per field (`d.x = result.x`)
 * instead of many incremental in-place mutations, which is both simpler to
 * reason about and meaningfully faster against an automerge draft (a
 * single full-field replace vs. hundreds/thousands of individual
 * change-tracked pushes/writes for a large diarization cache).
 *
 * assigns a color to any new speaker label; assigns each range's label to
 * any existing transcript segment it overlaps, or — if none overlap yet
 * (diarization loaded before transcript) — inserts a placeholder segment
 * (empty text) so the range still shows up as a track.
 */
export function mergeDiarizeData(
  referenceSpeakers: Record<string, ReferenceSpeaker>,
  transcriptSegments: TranscriptSegment[],
  parsed: ParsedDiarizeData
): MergedReferenceData {
  const nextSpeakers: Record<string, ReferenceSpeaker> = {};
  for (const [label, speaker] of Object.entries(referenceSpeakers)) {
    // preserve every existing field (trackId, sample/thumbnail blob refs,
    // etc) — this merge only ever touches name/color/new-speaker creation.
    nextSpeakers[label] = cloneReferenceSpeaker(speaker);
  }

  const labels = Object.keys(parsed.ranges).sort();
  let colorIndex = Object.keys(nextSpeakers).length;
  for (const label of labels) {
    if (!nextSpeakers[label]) {
      nextSpeakers[label] = {
        name: label,
        color: speakerColorForIndex(colorIndex),
        trackId: DEFAULT_REFERENCE_TRACK_ID,
        samples: [],
      };
      colorIndex++;
    }
  }

  const nextSegments: TranscriptSegment[] = transcriptSegments.map((s) => ({
    start: s.start,
    end: s.end,
    speaker: s.speaker,
    text: s.text,
  }));

  for (const label of labels) {
    for (const [start, end] of parsed.ranges[label]) {
      let matched = false;
      for (const seg of nextSegments) {
        if (overlaps(seg.start, seg.end, start, end)) {
          seg.speaker = label;
          matched = true;
        }
      }
      if (!matched) {
        nextSegments.push({ start, end, speaker: label, text: "" });
      }
    }
  }
  nextSegments.sort((a, b) => a.start - b.start);

  return { referenceSpeakers: nextSpeakers, transcriptSegments: nextSegments };
}

/**
 * merge a parsed whisper transcript cache, replacing the (start, end,
 * text) triples wholesale but preserving whichever speaker label a prior
 * diarization merge already assigned to an overlapping time range. returns
 * a new array (same "write back with one assignment" rationale as
 * `mergeDiarizeData` above).
 */
export function mergeTranscribeData(
  transcriptSegments: TranscriptSegment[],
  parsed: ParsedTranscribeData
): TranscriptSegment[] {
  const previous = transcriptSegments.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: s.text }));
  return parsed.segments.map((s) => {
    const best = previous.find((p) => overlaps(p.start, p.end, s.start, s.end));
    return { start: s.start, end: s.end, speaker: best?.speaker ?? "", text: s.text };
  });
}

/**
 * merge `process.py`'s combined `{ speakers, segments }` export in one
 * shot: the diarization half runs first (assigning speaker labels, and
 * inserting placeholder segments for any range that doesn't overlap a
 * transcript segment yet), then the transcript half replaces the (start,
 * end, text) triples wholesale while inheriting the just-assigned speaker
 * for whichever range each new segment overlaps.
 */
export function mergeCombinedData(
  referenceSpeakers: Record<string, ReferenceSpeaker>,
  transcriptSegments: TranscriptSegment[],
  parsed: ParsedCombinedData
): MergedReferenceData {
  const afterDiarize = mergeDiarizeData(referenceSpeakers, transcriptSegments, { kind: "diarize", ranges: parsed.ranges });
  const finalSegments = mergeTranscribeData(afterDiarize.transcriptSegments, {
    kind: "transcribe",
    segments: parsed.segments,
  });
  return { referenceSpeakers: afterDiarize.referenceSpeakers, transcriptSegments: finalSegments };
}

/** an uploaded sample video or thumbnail's blob metadata — matches
 *  `FileUploadResult`'s shape (see file-shared.ts), trimmed to the fields
 *  a `SpeakerSample`'s own `video*`/`thumbnail*` fields need. */
export interface UploadedSampleMedia {
  blobId: string;
  blake3: string;
  mime: string;
  filename: string;
  size: number;
}

/** every sample clip for a speaker, newest schema (`samples` array) first,
 *  falling back to the legacy singular fields for documents written before
 *  `samples` existed (see reference-data-actions.ts's `loadSpeakerSampleMedia()`
 *  and types.ts's `referenceSpeakerSchema` comments). */
export function getSpeakerSamples(speaker: ReferenceSpeaker): SpeakerSample[] {
  if (speaker.samples.length > 0) return speaker.samples;
  if (!speaker.sampleVideoBlobId) return [];
  return [
    {
      videoBlobId: speaker.sampleVideoBlobId,
      videoBlake3: speaker.sampleVideoBlake3 ?? "",
      videoMime: speaker.sampleVideoMime ?? "",
      videoFilename: speaker.sampleVideoFilename ?? "",
      videoSize: speaker.sampleVideoSize ?? 0,
      thumbnailBlobId: speaker.thumbnailBlobId,
      thumbnailBlake3: speaker.thumbnailBlake3,
      thumbnailMime: speaker.thumbnailMime,
      thumbnailFilename: speaker.thumbnailFilename,
      thumbnailSize: speaker.thumbnailSize,
    },
  ];
}

/**
 * attach a speaker's full set of uploaded sample clips (replacing whatever
 * was there before, since a project folder's `*_speaker_samples/` files can
 * be reloaded wholesale), creating the speaker entry (with a freshly
 * assigned color) if one doesn't exist yet — a project folder's samples
 * can be loaded before or after its diarize/transcribe json, in any order,
 * same as `mergeDiarizeData`/`mergeTranscribeData` above.
 */
export function mergeSpeakerSamples(
  referenceSpeakers: Record<string, ReferenceSpeaker>,
  speakerLabel: string,
  samples: SpeakerSample[]
): Record<string, ReferenceSpeaker> {
  const nextSpeakers: Record<string, ReferenceSpeaker> = {};
  for (const [label, speaker] of Object.entries(referenceSpeakers)) {
    nextSpeakers[label] = cloneReferenceSpeaker(speaker);
  }

  const existing = nextSpeakers[speakerLabel];
  const target: ReferenceSpeaker = existing ?? {
    name: speakerLabel,
    color: speakerColorForIndex(Object.keys(nextSpeakers).length),
    trackId: DEFAULT_REFERENCE_TRACK_ID,
    samples: [],
  };

  target.samples = samples;
  // keep the legacy singular fields pointed at sample 0 — anything still
  // reading those directly (or an older client) sees the first sample.
  const first = samples[0];
  target.sampleVideoBlobId = first?.videoBlobId;
  target.sampleVideoBlake3 = first?.videoBlake3;
  target.sampleVideoMime = first?.videoMime;
  target.sampleVideoFilename = first?.videoFilename;
  target.sampleVideoSize = first?.videoSize;
  target.thumbnailBlobId = first?.thumbnailBlobId;
  target.thumbnailBlake3 = first?.thumbnailBlake3;
  target.thumbnailMime = first?.thumbnailMime;
  target.thumbnailFilename = first?.thumbnailFilename;
  target.thumbnailSize = first?.thumbnailSize;

  nextSpeakers[speakerLabel] = target;
  return nextSpeakers;
}


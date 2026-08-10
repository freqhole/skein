/**
 * pure (no pixi/DOM) data-assembly logic for stfu's "SEGMENTS" panel — the
 * below-timeline list of rows that can show any combination of the editable
 * cut list, the read-only reference data (diarization + transcript), and
 * the audio-clips track, matched up with transcript text. see
 * `segments-panel.ts` for the pixi rendering.
 */

import type { EditableSegment } from "./cut-segments-track";
import type { AudioClip, ReferenceSpeaker, TranscriptSegment } from "./types";

export type SegmentsViewMode = "cutlist" | "reference" | "audioclips";

export const SEGMENTS_VIEW_MODES: { id: SegmentsViewMode; label: string }[] = [
  { id: "cutlist", label: "cut list" },
  { id: "reference", label: "reference" },
  { id: "audioclips", label: "audio clips" },
];

export interface PanelSegment {
  start: number;
  end: number;
  /** resolved display name (falls back to the raw speaker label), empty for cut-list/audio-clip rows */
  speakerName: string;
  /** the speaker's assigned timeline color, if known — undefined for cut-list/audio-clip rows. */
  speakerColor?: number;
  source: "cut list" | "reference" | "audio clip";
  text: string;
  /** set only for "audio clip" rows — the underlying clip this row authors/edits. */
  clip?: AudioClip;
}

/**
 * transcript text overlapping a [start, end) range, in start order — direct
 * port of editor.js's `textForRange()`.
 */
export function textForRange(transcriptSegments: TranscriptSegment[], start: number, end: number): string {
  return transcriptSegments
    .filter((seg) => seg.start < end && seg.end > start)
    .sort((a, b) => a.start - b.start)
    .map((seg) => seg.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * assemble the rows for the current (possibly multi-selected) set of view
 * modes: "reference" lists skein's already-unified `transcriptSegments`
 * (diarization + transcript merged by `reference-data.ts`) directly;
 * "cutlist" lists the user's editable cut ranges, each matched against
 * `transcriptSegments` via `textForRange()`; "audioclips" lists the
 * audio-clips track's own clips (each clip's own display duration —
 * `durationSec`, falling back to a nominal 1s while pending — as its end).
 * when more than one mode is active, all enabled sources are merged into
 * one list, sorted by start time.
 */
export function buildPanelSegments(
  modes: ReadonlySet<SegmentsViewMode>,
  editableSegments: EditableSegment[],
  transcriptSegments: TranscriptSegment[],
  referenceSpeakers: Record<string, ReferenceSpeaker>,
  audioClips: AudioClip[] = []
): PanelSegment[] {
  const speakerName = (label: string): string => (label ? referenceSpeakers[label]?.name || label : "");
  const rows: PanelSegment[] = [];

  if (modes.has("reference")) {
    rows.push(
      ...transcriptSegments.map((seg) => ({
        start: seg.start,
        end: seg.end,
        speakerName: speakerName(seg.speaker),
        speakerColor: seg.speaker ? referenceSpeakers[seg.speaker]?.color : undefined,
        source: "reference" as const,
        text: seg.text,
      }))
    );
  }

  if (modes.has("cutlist")) {
    rows.push(
      ...editableSegments.map(([start, end]) => ({
        start,
        end,
        speakerName: "",
        source: "cut list" as const,
        text: textForRange(transcriptSegments, start, end),
      }))
    );
  }

  if (modes.has("audioclips")) {
    rows.push(
      ...audioClips.map((clip) => ({
        start: clip.start,
        end: clip.start + (clip.durationSec > 0 ? clip.durationSec : 1),
        speakerName: "",
        source: "audio clip" as const,
        text: clip.ttsText ?? "",
        clip,
      }))
    );
  }

  return rows.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** index of the row containing `currentTime`, or -1 if none — used to drive autoscroll. */
export function findActiveSegmentIndex(segments: PanelSegment[], currentTime: number): number {
  return segments.findIndex((seg) => currentTime >= seg.start && currentTime < seg.end);
}


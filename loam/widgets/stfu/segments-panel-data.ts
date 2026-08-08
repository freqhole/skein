/**
 * pure (no pixi/DOM) data-assembly logic for stfu's "SEGMENTS" panel — the
 * below-timeline list of rows that can show either the editable cut list
 * or the read-only reference data (diarization + transcript), matched up
 * with transcript text. see `segments-panel.ts` for the pixi rendering.
 */

import type { EditableSegment } from "./cut-segments-track";
import type { ReferenceSpeaker, TranscriptSegment } from "./types";

export type SegmentsViewMode = "cutlist" | "reference";

export const SEGMENTS_VIEW_MODES: { id: SegmentsViewMode; label: string }[] = [
  { id: "cutlist", label: "cut list" },
  { id: "reference", label: "reference" },
];

export interface PanelSegment {
  start: number;
  end: number;
  /** resolved display name (falls back to the raw speaker label), empty for cut-list rows */
  speakerName: string;
  /** the speaker's assigned timeline color, if known — undefined for cut-list rows. */
  speakerColor?: number;
  source: "cut list" | "reference";
  text: string;
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
 * assemble the rows for the current view mode: "reference" mode lists
 * skein's already-unified `transcriptSegments` (diarization + transcript
 * merged by `reference-data.ts`) directly; "cutlist" mode lists the user's
 * editable cut ranges, each matched against `transcriptSegments` via
 * `textForRange()`.
 */
export function buildPanelSegments(
  mode: SegmentsViewMode,
  editableSegments: EditableSegment[],
  transcriptSegments: TranscriptSegment[],
  referenceSpeakers: Record<string, ReferenceSpeaker>
): PanelSegment[] {
  const speakerName = (label: string): string => (label ? referenceSpeakers[label]?.name || label : "");

  if (mode === "reference") {
    return transcriptSegments
      .map((seg) => ({
        start: seg.start,
        end: seg.end,
        speakerName: speakerName(seg.speaker),
        speakerColor: seg.speaker ? referenceSpeakers[seg.speaker]?.color : undefined,
        source: "reference" as const,
        text: seg.text,
      }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  return editableSegments
    .map(([start, end]) => ({
      start,
      end,
      speakerName: "",
      source: "cut list" as const,
      text: textForRange(transcriptSegments, start, end),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** index of the row containing `currentTime`, or -1 if none — used to drive autoscroll. */
export function findActiveSegmentIndex(segments: PanelSegment[], currentTime: number): number {
  return segments.findIndex((seg) => currentTime >= seg.start && currentTime < seg.end);
}

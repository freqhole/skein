import { describe, expect, it } from "vitest";
import { buildPanelSegments, findActiveSegmentIndex, textForRange } from "./segments-panel-data";
import type { ReferenceSpeaker, TranscriptSegment } from "./types";

describe("textForRange", () => {
  it("joins overlapping transcript text in start order", () => {
    const segments: TranscriptSegment[] = [
      { start: 5, end: 7, speaker: "", text: "there" },
      { start: 0, end: 2, speaker: "", text: "hello" },
    ];
    expect(textForRange(segments, 0, 7)).toBe("hello there");
  });

  it("excludes non-overlapping segments and trims/skips empty text", () => {
    const segments: TranscriptSegment[] = [
      { start: 0, end: 2, speaker: "", text: "  hi  " },
      { start: 10, end: 12, speaker: "", text: "unrelated" },
      { start: 1, end: 1.5, speaker: "", text: "" },
    ];
    expect(textForRange(segments, 0, 2)).toBe("hi");
  });

  it("returns an empty string when nothing overlaps", () => {
    expect(textForRange([], 0, 2)).toBe("");
  });
});

describe("buildPanelSegments", () => {
  const referenceSpeakers: Record<string, ReferenceSpeaker> = {
    SPEAKER_00: { name: "Janeway", color: 0x123456 },
  };

  it("cutlist mode maps editableSegments and matches transcript text", () => {
    const transcriptSegments: TranscriptSegment[] = [{ start: 0, end: 2, speaker: "SPEAKER_00", text: "hello" }];
    const result = buildPanelSegments(new Set(["cutlist"]), [[5, 7], [0, 2]], transcriptSegments, referenceSpeakers);
    expect(result).toEqual([
      { start: 0, end: 2, speakerName: "", source: "cut list", text: "hello" },
      { start: 5, end: 7, speakerName: "", source: "cut list", text: "" },
    ]);
  });

  it("reference mode lists transcriptSegments directly, resolving speaker display names", () => {
    const transcriptSegments: TranscriptSegment[] = [
      { start: 5, end: 7, speaker: "SPEAKER_01", text: "there" },
      { start: 0, end: 2, speaker: "SPEAKER_00", text: "hello" },
    ];
    const result = buildPanelSegments(new Set(["reference"]), [], transcriptSegments, referenceSpeakers);
    expect(result).toEqual([
      { start: 0, end: 2, speakerName: "Janeway", speakerColor: 0x123456, source: "reference", text: "hello" },
      { start: 5, end: 7, speakerName: "SPEAKER_01", speakerColor: undefined, source: "reference", text: "there" },
    ]);
  });

  it("reference mode falls back to the raw label when no speaker name is set, and leaves unlabeled segments blank", () => {
    const transcriptSegments: TranscriptSegment[] = [{ start: 0, end: 2, speaker: "", text: "hi" }];
    const result = buildPanelSegments(new Set(["reference"]), [], transcriptSegments, referenceSpeakers);
    expect(result).toEqual([
      { start: 0, end: 2, speakerName: "", speakerColor: undefined, source: "reference", text: "hi" },
    ]);
  });
});

describe("findActiveSegmentIndex", () => {
  it("finds the segment containing the current time", () => {
    const segments = buildPanelSegments(new Set(["cutlist"]), [[0, 2], [5, 7]], [], {});
    expect(findActiveSegmentIndex(segments, 6)).toBe(1);
  });

  it("returns -1 when no segment contains the current time", () => {
    const segments = buildPanelSegments(new Set(["cutlist"]), [[0, 2]], [], {});
    expect(findActiveSegmentIndex(segments, 10)).toBe(-1);
  });
});

import { describe, expect, it } from "vitest";
import {
  mergeCombinedData,
  mergeDiarizeData,
  mergeTranscribeData,
  parseReferenceDataJson,
  speakerColorForIndex,
} from "./reference-data";
import type { ReferenceSpeaker, TranscriptSegment } from "./types";

describe("parseReferenceDataJson", () => {
  it("detects a whisper transcribe cache", () => {
    const raw = {
      text: "hello there",
      segments: [
        { id: 0, start: 0, end: 2.5, text: " hello " },
        { id: 1, start: 2.5, end: 5, text: "there" },
      ],
    };
    const parsed = parseReferenceDataJson(raw);
    expect(parsed).toEqual({
      kind: "transcribe",
      segments: [
        { start: 0, end: 2.5, text: "hello" },
        { start: 2.5, end: 5, text: "there" },
      ],
    });
  });

  it("detects a diarization cache (dict of speaker -> ranges)", () => {
    const raw = {
      SPEAKER_00: [
        [0, 2.3],
        [5.1, 7.8],
      ],
      SPEAKER_01: [[1.2, 3.5]],
    };
    const parsed = parseReferenceDataJson(raw);
    expect(parsed).toEqual({
      kind: "diarize",
      ranges: {
        SPEAKER_00: [
          [0, 2.3],
          [5.1, 7.8],
        ],
        SPEAKER_01: [[1.2, 3.5]],
      },
    });
  });

  it("returns null for an empty object", () => {
    expect(parseReferenceDataJson({})).toBeNull();
  });

  it("returns null for a plain array", () => {
    expect(parseReferenceDataJson([1, 2, 3])).toBeNull();
  });

  it("returns null for null/non-object input", () => {
    expect(parseReferenceDataJson(null)).toBeNull();
    expect(parseReferenceDataJson("not json")).toBeNull();
  });

  it("returns null when a value isn't an array of [start, end] pairs", () => {
    expect(parseReferenceDataJson({ SPEAKER_00: "not an array" })).toBeNull();
    expect(parseReferenceDataJson({ SPEAKER_00: [[1, "two"]] })).toBeNull();
  });

  it("detects process.py's combined { speakers, segments } export", () => {
    const raw = {
      speakers: { SPEAKER_00: [[0, 2.3]] },
      segments: [{ start: 0, end: 2.5, text: " hello " }],
    };
    expect(parseReferenceDataJson(raw)).toEqual({
      kind: "combined",
      ranges: { SPEAKER_00: [[0, 2.3]] },
      segments: [{ start: 0, end: 2.5, text: "hello" }],
    });
  });
});

describe("speakerColorForIndex", () => {
  it("is deterministic per index", () => {
    expect(speakerColorForIndex(0)).toBe(speakerColorForIndex(0));
  });

  it("produces different colors for different indices", () => {
    const colors = new Set([0, 1, 2, 3].map(speakerColorForIndex));
    expect(colors.size).toBe(4);
  });

  it("produces a valid 24-bit rgb int", () => {
    const c = speakerColorForIndex(2);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(0xffffff);
  });
});

describe("mergeDiarizeData", () => {
  it("assigns new speaker colors and inserts placeholder segments when nothing overlaps yet", () => {
    const referenceSpeakers: Record<string, ReferenceSpeaker> = {};
    const transcriptSegments: TranscriptSegment[] = [];

    const merged = mergeDiarizeData(referenceSpeakers, transcriptSegments, {
      kind: "diarize",
      ranges: { SPEAKER_00: [[0, 2]], SPEAKER_01: [[5, 7]] },
    });

    expect(Object.keys(merged.referenceSpeakers).sort()).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(merged.referenceSpeakers.SPEAKER_00.color).not.toBe(merged.referenceSpeakers.SPEAKER_01.color);
    expect(merged.transcriptSegments).toEqual([
      { start: 0, end: 2, speaker: "SPEAKER_00", text: "" },
      { start: 5, end: 7, speaker: "SPEAKER_01", text: "" },
    ]);
    // inputs are untouched
    expect(referenceSpeakers).toEqual({});
    expect(transcriptSegments).toEqual([]);
  });

  it("assigns a speaker label to existing overlapping transcript segments instead of duplicating", () => {
    const referenceSpeakers: Record<string, ReferenceSpeaker> = {};
    const transcriptSegments: TranscriptSegment[] = [{ start: 0, end: 2.5, speaker: "", text: "hello" }];

    const merged = mergeDiarizeData(referenceSpeakers, transcriptSegments, {
      kind: "diarize",
      ranges: { SPEAKER_00: [[0, 2]] },
    });

    expect(merged.transcriptSegments).toEqual([{ start: 0, end: 2.5, speaker: "SPEAKER_00", text: "hello" }]);
  });

  it("does not reassign a color to an already-known speaker", () => {
    const referenceSpeakers: Record<string, ReferenceSpeaker> = {
      SPEAKER_00: { name: "SPEAKER_00", color: 0x123456 },
    };
    const transcriptSegments: TranscriptSegment[] = [];

    const merged = mergeDiarizeData(referenceSpeakers, transcriptSegments, {
      kind: "diarize",
      ranges: { SPEAKER_00: [[0, 2]] },
    });

    expect(merged.referenceSpeakers.SPEAKER_00.color).toBe(0x123456);
  });
});

describe("mergeTranscribeData", () => {
  it("replaces segments wholesale but inherits a prior overlapping speaker label", () => {
    const previous: TranscriptSegment[] = [{ start: 0, end: 2, speaker: "SPEAKER_00", text: "" }];

    const merged = mergeTranscribeData(previous, {
      kind: "transcribe",
      segments: [{ start: 0.1, end: 1.9, text: "hello there" }],
    });

    expect(merged).toEqual([{ start: 0.1, end: 1.9, speaker: "SPEAKER_00", text: "hello there" }]);
  });

  it("leaves speaker empty when nothing overlaps", () => {
    const merged = mergeTranscribeData([], {
      kind: "transcribe",
      segments: [{ start: 10, end: 12, text: "hi" }],
    });
    expect(merged).toEqual([{ start: 10, end: 12, speaker: "", text: "hi" }]);
  });
});

describe("mergeCombinedData", () => {
  it("assigns speakers to overlapping segments in one pass", () => {
    const merged = mergeCombinedData({}, [], {
      kind: "combined",
      ranges: { SPEAKER_00: [[0, 2]], SPEAKER_01: [[5, 7]] },
      segments: [
        { start: 0.1, end: 1.9, text: "hello" },
        { start: 5.1, end: 6.9, text: "there" },
      ],
    });

    expect(Object.keys(merged.referenceSpeakers).sort()).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(merged.transcriptSegments).toEqual([
      { start: 0.1, end: 1.9, speaker: "SPEAKER_00", text: "hello" },
      { start: 5.1, end: 6.9, speaker: "SPEAKER_01", text: "there" },
    ]);
  });

  it("drops diarize-only placeholder ranges that no transcript segment overlaps", () => {
    const merged = mergeCombinedData({}, [], {
      kind: "combined",
      ranges: { SPEAKER_00: [[100, 102]] },
      segments: [{ start: 0, end: 2, text: "hi" }],
    });

    expect(merged.transcriptSegments).toEqual([{ start: 0, end: 2, speaker: "", text: "hi" }]);
  });
});

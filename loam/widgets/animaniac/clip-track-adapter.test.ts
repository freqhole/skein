import { describe, expect, it } from "vitest";
import { clipTrackAdapter, getClipSpan, withClipSpan } from "./clip-track-adapter";
import type { AudioSegmentClip, LabelClip, VoiceRecordingClip } from "./types";

function voiceClip(overrides: Partial<VoiceRecordingClip> = {}): VoiceRecordingClip {
  return {
    kind: "voice-recording",
    id: "c1",
    trackId: "audio-1",
    start: 10,
    keyframes: [{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" }],
    audioBlobId: "b1",
    audioBlake3: "",
    audioMime: "",
    sourceInSec: 0,
    sourceOutSec: 5,
    ...overrides,
  };
}

function segmentClip(overrides: Partial<AudioSegmentClip> = {}): AudioSegmentClip {
  return {
    kind: "audio-segment",
    id: "seg1",
    trackId: "audio-1",
    start: 10,
    keyframes: [{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" }],
    audioBlobId: "b2",
    audioBlake3: "",
    audioMime: "",
    sourceInSec: 2,
    sourceOutSec: 7,
    label: "",
    ...overrides,
  };
}

function labelClip(overrides: Partial<LabelClip> = {}): LabelClip {
  return {
    kind: "label",
    id: "lab1",
    trackId: "visual-1",
    start: 0,
    keyframes: [{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" }],
    text: "hi",
    color: 0xffffff,
    bgColor: 0x000000,
    durationSec: 1,
    ...overrides,
  };
}

describe("getClipSpan", () => {
  it("derives [start, start+duration) for a fixed-duration clip", () => {
    expect(getClipSpan(labelClip({ start: 10, durationSec: 5 }))).toEqual({ start: 10, end: 15 });
  });

  it("derives [start, start+duration) for a trimmed segment using its derived duration", () => {
    expect(getClipSpan(segmentClip({ start: 10, sourceInSec: 2, sourceOutSec: 7 }))).toEqual({ start: 10, end: 15 });
  });

  it("derives [start, start+duration) for a voice-recording clip too (also a trimmed segment now)", () => {
    expect(getClipSpan(voiceClip({ start: 10, sourceInSec: 0, sourceOutSec: 5 }))).toEqual({ start: 10, end: 15 });
  });
});

describe("withClipSpan — move (both edges shift by the same delta)", () => {
  it("only changes start on a fixed-duration clip, durationSec unchanged", () => {
    const c = labelClip({ start: 10, durationSec: 5 });
    const moved = withClipSpan(c, { start: 12, end: 17 }); // shifted +2, same 5s span
    expect(moved).toMatchObject({ start: 12, durationSec: 5 });
  });

  it("only changes start on a trimmed segment — sourceIn/sourceOut untouched (placement moved, trim window didn't)", () => {
    const c = segmentClip({ start: 10, sourceInSec: 2, sourceOutSec: 7 });
    const moved = withClipSpan(c, { start: 12, end: 17 });
    expect(moved).toMatchObject({ start: 12, sourceInSec: 2, sourceOutSec: 7 });
  });

  it("only changes start on a voice-recording clip — same trimmed-segment behavior", () => {
    const c = voiceClip({ start: 10, sourceInSec: 0, sourceOutSec: 5 });
    const moved = withClipSpan(c, { start: 12, end: 17 });
    expect(moved).toMatchObject({ start: 12, sourceInSec: 0, sourceOutSec: 5 });
  });
});

describe("withClipSpan — resize-right (only the end moved)", () => {
  it("extends durationSec on a fixed-duration clip", () => {
    const c = labelClip({ start: 10, durationSec: 5 });
    const resized = withClipSpan(c, { start: 10, end: 20 }); // end +5
    expect(resized).toMatchObject({ start: 10, durationSec: 10 });
  });

  it("extends sourceOutSec on a trimmed segment, sourceInSec untouched", () => {
    const c = segmentClip({ start: 10, sourceInSec: 2, sourceOutSec: 7 });
    const resized = withClipSpan(c, { start: 10, end: 20 }); // end +5 -> sourceOutSec 7+5=12
    expect(resized).toMatchObject({ start: 10, sourceInSec: 2, sourceOutSec: 12 });
  });

  it("clamps sourceOutSec so it can't shrink past sourceInSec + min duration", () => {
    const c = segmentClip({ start: 10, sourceInSec: 2, sourceOutSec: 7 });
    const resized = withClipSpan(c, { start: 10, end: 10.001 }) as AudioSegmentClip; // huge shrink attempt
    expect(resized.sourceOutSec).toBeGreaterThan(resized.sourceInSec);
  });

  it("clamps sourceOutSec against sourceDurationSec so it can't extend past the real known source length", () => {
    const c = segmentClip({ start: 10, sourceInSec: 0, sourceOutSec: 5, sourceDurationSec: 6 });
    const resized = withClipSpan(c, { start: 10, end: 1000 }) as AudioSegmentClip; // huge extend attempt
    expect(resized.sourceOutSec).toBe(6);
  });

  it("leaves a resize unclamped when sourceDurationSec is 0 (not yet known)", () => {
    const c = segmentClip({ start: 10, sourceInSec: 0, sourceOutSec: 5, sourceDurationSec: 0 });
    const resized = withClipSpan(c, { start: 10, end: 30 }) as AudioSegmentClip;
    expect(resized.sourceOutSec).toBe(20);
  });
});

describe("withClipSpan — resize-left (only the start moved)", () => {
  it("shrinks durationSec (keeps the right edge fixed) on a fixed-duration clip", () => {
    const c = labelClip({ start: 10, durationSec: 5 }); // [10, 15]
    const resized = withClipSpan(c, { start: 12, end: 15 });
    expect(resized).toMatchObject({ start: 12, durationSec: 3 });
  });

  it("advances sourceInSec (a real trim into the source) on a trimmed segment", () => {
    const c = segmentClip({ start: 10, sourceInSec: 2, sourceOutSec: 7 }); // [10, 15]
    const resized = withClipSpan(c, { start: 12, end: 15 }); // start +2 -> sourceInSec 2+2=4
    expect(resized).toMatchObject({ start: 12, sourceInSec: 4, sourceOutSec: 7 });
  });

  it("advances sourceInSec on a voice-recording clip too — real front-trim support", () => {
    const c = voiceClip({ start: 10, sourceInSec: 2, sourceOutSec: 7 }); // [10, 15]
    const resized = withClipSpan(c, { start: 12, end: 15 });
    expect(resized).toMatchObject({ start: 12, sourceInSec: 4, sourceOutSec: 7 });
  });

  it("never advances sourceInSec below 0", () => {
    const c = segmentClip({ start: 10, sourceInSec: 1, sourceOutSec: 7 });
    const resized = withClipSpan(c, { start: 5, end: 15 }) as AudioSegmentClip; // start moved -5
    expect(resized.sourceInSec).toBeGreaterThanOrEqual(0);
  });

  it("clamps sourceInSec so it can't cross sourceOutSec on a huge shrink attempt, keeping `start` pinned to the actual clamped amount (not the raw drag delta) so the right edge doesn't drift", () => {
    const c = segmentClip({ start: 10, sourceInSec: 2, sourceOutSec: 7 }); // [10, 15]
    const resized = withClipSpan(c, { start: 1000, end: 15 }) as AudioSegmentClip; // huge rightward drag
    expect(resized.sourceInSec).toBeLessThan(resized.sourceOutSec);
    // the right edge (start + derived duration) must stay at the original 15,
    // not drift past it just because the raw drag went way further right.
    expect(resized.start + (resized.sourceOutSec - resized.sourceInSec)).toBeCloseTo(15, 5);
  });
});

describe("withClipSpan — label clip (no audio/duration source concept beyond durationSec)", () => {
  it("resizing changes durationSec, preserving text/color", () => {
    const c = labelClip({ start: 0, durationSec: 1 });
    const resized = withClipSpan(c, { start: 0, end: 3 }) as LabelClip;
    expect(resized.durationSec).toBe(3);
    expect(resized.text).toBe("hi");
  });
});

describe("clipTrackAdapter", () => {
  it("wires getId/getSpan/withSpan to the same functions", () => {
    const c = voiceClip({ id: "xyz" });
    expect(clipTrackAdapter.getId(c, 0)).toBe("xyz");
    expect(clipTrackAdapter.getSpan(c)).toEqual(getClipSpan(c));
  });
});

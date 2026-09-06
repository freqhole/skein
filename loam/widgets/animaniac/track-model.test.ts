import { describe, expect, it } from "vitest";
import {
  activeClipsAt,
  addClip,
  addTrack,
  clipDurationSec,
  clipEnd,
  clipsForTrack,
  computeDisplayDurationSec,
  computeTimelineDuration,
  findClip,
  nextTrackOrder,
  removeClip,
  removeTrack,
  sortedTracks,
  updateClip,
  updateTrack,
} from "./track-model";
import type { AudioSegmentClip, Clip, Track, VideoSegmentClip, VoiceRecordingClip } from "./types";

function voiceClip(overrides: Partial<VoiceRecordingClip> = {}): VoiceRecordingClip {
  return {
    kind: "voice-recording",
    id: "c1",
    trackId: "audio-1",
    start: 0,
    keyframes: [{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" }],
    audioBlobId: "b1",
    audioBlake3: "",
    audioMime: "",
    sourceInSec: 0,
    sourceOutSec: 5,
    ...overrides,
  };
}

function audioSegmentClip(overrides: Partial<AudioSegmentClip> = {}): AudioSegmentClip {
  return {
    kind: "audio-segment",
    id: "seg1",
    trackId: "audio-1",
    start: 0,
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

function videoSegmentClip(overrides: Partial<VideoSegmentClip> = {}): VideoSegmentClip {
  return {
    kind: "video-segment",
    id: "vid1",
    trackId: "visual-1",
    start: 0,
    keyframes: [{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" }],
    videoBlobId: "vb1",
    videoBlake3: "",
    videoMime: "",
    sourceInSec: 0,
    sourceOutSec: 3,
    muted: true,
    ...overrides,
  };
}

describe("clipDurationSec / clipEnd", () => {
  it("derives duration from sourceIn/sourceOut for a voice-recording clip too (also a trimmed segment now)", () => {
    const c = voiceClip({ sourceInSec: 0, sourceOutSec: 5 });
    expect(clipDurationSec(c)).toBe(5);
    expect(clipEnd({ ...c, start: 10 })).toBe(15);
  });

  it("derives duration from sourceIn/sourceOut for a trimmed segment", () => {
    const c = audioSegmentClip({ sourceInSec: 2, sourceOutSec: 7 });
    expect(clipDurationSec(c)).toBe(5);
  });

  it("clamps a degenerate (or inverted) trim range to a minimum duration", () => {
    const c = audioSegmentClip({ sourceInSec: 5, sourceOutSec: 5 });
    expect(clipDurationSec(c)).toBeGreaterThan(0);
  });
});

describe("activeClipsAt", () => {
  it("returns every clip whose window contains t, including overlaps", () => {
    const a = voiceClip({ id: "a", start: 0, sourceInSec: 0, sourceOutSec: 5 });
    const b = voiceClip({ id: "b", start: 2, sourceInSec: 0, sourceOutSec: 5 }); // overlaps a
    const clips: Clip[] = [a, b];
    expect(activeClipsAt(clips, 3).map((c) => c.id)).toEqual(["a", "b"]);
    expect(activeClipsAt(clips, 6).map((c) => c.id)).toEqual(["b"]);
    expect(activeClipsAt(clips, 10)).toEqual([]);
  });

  it("end time is exclusive (clip is not active exactly at its own end)", () => {
    const a = voiceClip({ id: "a", start: 0, sourceInSec: 0, sourceOutSec: 5 });
    expect(activeClipsAt([a], 5)).toEqual([]);
    expect(activeClipsAt([a], 4.999)).toHaveLength(1);
  });
});

describe("clipsForTrack / computeTimelineDuration", () => {
  it("filters by trackId", () => {
    const a = voiceClip({ id: "a", trackId: "audio-1" });
    const b = voiceClip({ id: "b", trackId: "audio-2" });
    expect(clipsForTrack([a, b], "audio-1").map((c) => c.id)).toEqual(["a"]);
  });

  it("computes duration as the furthest clip end across every track", () => {
    const a = voiceClip({ id: "a", start: 0, sourceInSec: 0, sourceOutSec: 5 });
    const b = videoSegmentClip({ id: "b", start: 10, sourceInSec: 0, sourceOutSec: 3 });
    expect(computeTimelineDuration([a, b])).toBe(13);
    expect(computeTimelineDuration([])).toBe(0);
  });
});

describe("computeDisplayDurationSec", () => {
  it("pads the true content duration with a trailing buffer", () => {
    const a = voiceClip({ id: "a", start: 0, sourceInSec: 0, sourceOutSec: 5 });
    expect(computeDisplayDurationSec([a], 3, 0)).toBe(8);
  });

  it("floors at the minimum duration for a short/empty timeline", () => {
    expect(computeDisplayDurationSec([], 5, 20)).toBe(20);
    const a = voiceClip({ id: "a", start: 0, sourceInSec: 0, sourceOutSec: 1 });
    expect(computeDisplayDurationSec([a], 1, 20)).toBe(20);
  });

  it("uses the default buffer/minimum when not overridden", () => {
    expect(computeDisplayDurationSec([])).toBeGreaterThan(0);
  });
});

describe("track CRUD", () => {
  const visual1: Track = { id: "visual-1", label: "visual", order: 0, muted: false, hidden: false };
  const audio1: Track = { id: "audio-1", label: "audio", order: 0, muted: false, hidden: false };

  it("sortedTracks orders by order then id", () => {
    const visual2: Track = { ...visual1, id: "visual-2", order: 1 };
    const result = sortedTracks([audio1, visual2, visual1]);
    expect(result.map((t) => t.id)).toEqual(["audio-1", "visual-1", "visual-2"]);
  });

  it("nextTrackOrder picks one past the current max", () => {
    expect(nextTrackOrder([visual1])).toBe(1);
    expect(nextTrackOrder([])).toBe(0);
  });

  it("addTrack appends, updateTrack patches by id", () => {
    const tracks = addTrack([visual1], audio1);
    expect(tracks).toHaveLength(2);
    const muted = updateTrack(tracks, "audio-1", { muted: true });
    expect(muted.find((t) => t.id === "audio-1")?.muted).toBe(true);
    expect(muted.find((t) => t.id === "visual-1")?.muted).toBe(false);
  });

  it("removeTrack also removes every clip on that track (no orphans)", () => {
    const clip = voiceClip({ trackId: "audio-1" });
    const { tracks, clips } = removeTrack([visual1, audio1], [clip], "audio-1");
    expect(tracks.map((t) => t.id)).toEqual(["visual-1"]);
    expect(clips).toEqual([]);
  });
});

describe("clip CRUD", () => {
  it("addClip/removeClip/findClip round-trip", () => {
    const c = voiceClip();
    const clips = addClip([], c);
    expect(findClip(clips, "c1")).toEqual(c);
    expect(removeClip(clips, "c1")).toEqual([]);
  });

  it("updateClip patches only the matching clip, preserving other fields", () => {
    const a = voiceClip({ id: "a", start: 0 });
    const b = voiceClip({ id: "b", start: 5 });
    const next = updateClip([a, b], "a", { start: 2 });
    expect(next.find((c) => c.id === "a")?.start).toBe(2);
    expect(next.find((c) => c.id === "b")?.start).toBe(5);
  });
});

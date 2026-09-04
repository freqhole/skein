import { describe, expect, it } from "vitest";
import { expectedTrackKindFor, isCapturableWidgetType, resolveCapturedClip } from "./frame-capture";

// note: the "doodle" branch's happy path (non-empty strokes) calls
// renderDoodleSnapshot(), which needs a real canvas/WebGL context — not
// exercised here (matches this codebase's convention of not unit-testing
// pixi-construction code). only its early-return ("nothing to capture")
// path is tested, which never reaches that call.

describe("isCapturableWidgetType", () => {
  it("recognizes every supported source widget type", () => {
    for (const t of ["doodle", "image", "label", "voice-recording", "tts", "audio-recording", "file", "stfu"]) {
      expect(isCapturableWidgetType(t)).toBe(true);
    }
  });

  it("rejects an unrelated widget type", () => {
    expect(isCapturableWidgetType("markdown")).toBe(false);
  });
});

describe("expectedTrackKindFor", () => {
  it("maps visual-producing widget types to 'visual'", () => {
    for (const t of ["doodle", "image", "label", "stfu"]) {
      expect(expectedTrackKindFor(t, {})).toBe("visual");
    }
  });

  it("maps audio-producing widget types to 'audio'", () => {
    for (const t of ["voice-recording", "tts", "audio-recording"]) {
      expect(expectedTrackKindFor(t, {})).toBe("audio");
    }
  });

  it("resolves a file widget's kind from its domain", () => {
    expect(expectedTrackKindFor("file", { domain: "audio" })).toBe("audio");
    expect(expectedTrackKindFor("file", { domain: "video" })).toBe("visual");
    expect(expectedTrackKindFor("file", { domain: "document" })).toBeNull();
  });

  it("returns null for an unrecognized widget type", () => {
    expect(expectedTrackKindFor("markdown", {})).toBeNull();
  });
});

describe("resolveCapturedClip", () => {
  const newId = () => "fixed-id";

  it("returns null for an unknown source type", async () => {
    expect(await resolveCapturedClip("markdown", {}, "track-1", 0, newId)).toBeNull();
  });

  it("doodle: returns null when there are no strokes yet", async () => {
    expect(await resolveCapturedClip("doodle", { strokes: [] }, "v1", 0, newId)).toBeNull();
  });

  it("image: captures the url field as-is (already a blob: ref in the common case)", async () => {
    const clip = await resolveCapturedClip("image", { url: "blob:abc123" }, "v1", 2, newId);
    expect(clip).toEqual({
      kind: "image",
      id: "fixed-id",
      trackId: "v1",
      start: 2,
      keyframes: [{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" }],
      imageUrl: "blob:abc123",
      durationSec: 1,
    });
  });

  it("image: returns null when there's no url yet", async () => {
    expect(await resolveCapturedClip("image", { url: "" }, "v1", 0, newId)).toBeNull();
  });

  it("label: captures text/color/bgColor", async () => {
    const clip = await resolveCapturedClip(
      "label",
      { text: "hello", textColor: 0xffffff, bgColor: 0x111111 },
      "v1",
      0,
      newId
    );
    expect(clip).toMatchObject({ kind: "label", text: "hello", color: 0xffffff, bgColor: 0x111111 });
  });

  it("label: returns null for an empty label", async () => {
    expect(await resolveCapturedClip("label", { text: "" }, "v1", 0, newId)).toBeNull();
  });

  it("voice-recording: captures audio fields", async () => {
    const clip = await resolveCapturedClip(
      "voice-recording",
      { blobId: "b1", blake3: "hash1", mime: "audio/webm", duration: 4.2 },
      "a1",
      1,
      newId
    );
    expect(clip).toMatchObject({
      kind: "voice-recording",
      audioBlobId: "b1",
      audioBlake3: "hash1",
      audioMime: "audio/webm",
      durationSec: 4.2,
    });
  });

  it("voice-recording: returns null with no recording yet", async () => {
    expect(await resolveCapturedClip("voice-recording", { blobId: "" }, "a1", 0, newId)).toBeNull();
  });

  it("tts: captures generated audio + tts metadata", async () => {
    const clip = await resolveCapturedClip(
      "tts",
      { blobId: "b2", ttsText: "hi there", ttsVoiceName: "Alex", ttsRate: 1.2, duration: 2 },
      "a1",
      0,
      newId
    );
    expect(clip).toMatchObject({ kind: "tts", audioBlobId: "b2", ttsText: "hi there", ttsRate: 1.2 });
  });

  it("tts: returns null when not yet generated", async () => {
    expect(await resolveCapturedClip("tts", { blobId: "", ttsText: "hi" }, "a1", 0, newId)).toBeNull();
  });

  it("audio-recording: maps to an audio-segment spanning the full source duration", async () => {
    const clip = await resolveCapturedClip(
      "audio-recording",
      { blobId: "b3", duration: 8, filename: "clip.webm" },
      "a1",
      0,
      newId
    );
    expect(clip).toMatchObject({
      kind: "audio-segment",
      audioBlobId: "b3",
      sourceInSec: 0,
      sourceOutSec: 8,
      label: "clip.webm",
    });
  });

  it("audio-recording: returns null with zero duration (nothing recorded)", async () => {
    expect(await resolveCapturedClip("audio-recording", { blobId: "b3", duration: 0 }, "a1", 0, newId)).toBeNull();
  });

  it("stfu: maps to a video-segment spanning the full source duration, ignoring any cut list", async () => {
    const clip = await resolveCapturedClip(
      "stfu",
      { videoBlobId: "v1", videoDurationSec: 30, videoBlake3: "vh1", editableSegments: [[1, 2]] },
      "vt1",
      0,
      newId
    );
    expect(clip).toMatchObject({
      kind: "video-segment",
      videoBlobId: "v1",
      videoBlake3: "vh1",
      sourceInSec: 0,
      sourceOutSec: 30,
      muted: false,
    });
  });

  it("stfu: returns null with no video loaded yet", async () => {
    expect(await resolveCapturedClip("stfu", { videoBlobId: "", videoDurationSec: 0 }, "vt1", 0, newId)).toBeNull();
  });

  it("file: maps to audio-segment/video-segment now that file.ts probes a real duration", async () => {
    const audioClip = await resolveCapturedClip(
      "file",
      { blobId: "f1", domain: "audio", duration: 12, mime: "audio/mpeg", filename: "song.mp3" },
      "a1",
      0,
      newId
    );
    expect(audioClip).toMatchObject({ kind: "audio-segment", audioBlobId: "f1", sourceInSec: 0, sourceOutSec: 12 });

    const videoClip = await resolveCapturedClip(
      "file",
      { blobId: "f2", domain: "video", duration: 20, mime: "video/mp4" },
      "vt1",
      0,
      newId
    );
    expect(videoClip).toMatchObject({ kind: "video-segment", videoBlobId: "f2", sourceOutSec: 20, muted: false });
  });

  it("file: returns null when duration hasn't been probed yet (0, or a pre-probe legacy widget)", async () => {
    expect(await resolveCapturedClip("file", { blobId: "f1", domain: "audio", duration: 0 }, "a1", 0, newId)).toBeNull();
  });

  it("file: returns null for an unresolved domain", async () => {
    expect(await resolveCapturedClip("file", { blobId: "f1", domain: "document", duration: 5 }, "a1", 0, newId)).toBeNull();
  });
});

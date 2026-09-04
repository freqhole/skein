import { describe, expect, it } from "vitest";
import { restoreWidgetFromClip } from "./clip-restore";
import type { Clip } from "./types";

const baseKeyframes = [{ t: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: "linear" as const }];

describe("restoreWidgetFromClip", () => {
  it("restores a doodle-frame clip as a plain image widget when no source doodle state survived capture", () => {
    const clip: Clip = {
      kind: "doodle-frame",
      id: "c1",
      trackId: "t1",
      start: 0,
      keyframes: baseKeyframes,
      imageUrl: "blob:abc",
      durationSec: 1,
      snatchedBy: [],
    };
    expect(restoreWidgetFromClip(clip)).toEqual({ type: "image", props: { url: "blob:abc" } });
  });

  it("restores a doodle-frame clip with sourceDoodle as a real, re-editable doodle widget", () => {
    const stroke = { id: "s1", tool: "pen", color: 0xff0000, width: 3, points: [{ x: 1, y: 2 }], opacity: 100, brushShape: "circle", pressureScale: 0, angleScale: 0, chiselAngle: -45 };
    const clip: Clip = {
      kind: "doodle-frame",
      id: "c1",
      trackId: "t1",
      start: 0,
      keyframes: baseKeyframes,
      imageUrl: "blob:abc",
      durationSec: 1,
      snatchedBy: [],
      sourceDoodle: {
        strokes: [stroke],
        bgColor: 0x111111,
        penColor: 0x222222,
        penWidth: 4,
        pressureScale: 0,
        brushShape: "circle",
        angleScale: 0,
        chiselAngle: -45,
        penOpacity: 100,
        borderColor: 0x333333,
        borderWidth: 2,
        width: 500,
        height: 300,
      },
    };
    expect(restoreWidgetFromClip(clip)).toEqual({
      type: "doodle",
      props: {
        strokes: [stroke],
        bgColor: 0x111111,
        penColor: 0x222222,
        penWidth: 4,
        pressureScale: 0,
        brushShape: "circle",
        angleScale: 0,
        chiselAngle: -45,
        penOpacity: 100,
        borderColor: 0x333333,
        borderWidth: 2,
        colorsSeeded: true,
      },
      width: 500,
      height: 300,
    });
  });

  it("restores an image clip as an image widget", () => {
    const clip: Clip = {
      kind: "image",
      id: "c1",
      trackId: "t1",
      start: 0,
      keyframes: baseKeyframes,
      imageUrl: "blob:xyz",
      durationSec: 1,
      snatchedBy: [],
    };
    expect(restoreWidgetFromClip(clip)).toEqual({ type: "image", props: { url: "blob:xyz" } });
  });

  it("restores a label clip as a label widget, carrying text/colors over", () => {
    const clip: Clip = {
      kind: "label",
      id: "c1",
      trackId: "t1",
      start: 0,
      keyframes: baseKeyframes,
      text: "hello",
      color: 0x111111,
      bgColor: 0x222222,
      durationSec: 1,
    };
    expect(restoreWidgetFromClip(clip)).toEqual({
      type: "label",
      props: { text: "hello", textColor: 0x111111, bgColor: 0x222222 },
    });
  });

  it("restores a voice-recording clip as a voice-recording widget", () => {
    const clip: Clip = {
      kind: "voice-recording",
      id: "c1",
      trackId: "t1",
      start: 0,
      keyframes: baseKeyframes,
      audioBlobId: "blob1",
      audioBlake3: "hash1",
      audioMime: "audio/webm",
      durationSec: 5,
      lipsColor: 0xabcdef,
      lipThickness: 3,
      mouthMood: "smile",
      teethStyle: "curved",
      cupidBowAmount: 7,
      snatchedBy: [],
    };
    expect(restoreWidgetFromClip(clip)).toEqual({
      type: "voice-recording",
      props: {
        blobId: "blob1",
        blake3: "hash1",
        mime: "audio/webm",
        duration: 5,
        lipsColor: 0xabcdef,
        lipThickness: 3,
        mouthMood: "smile",
        teethStyle: "curved",
        cupidBowAmount: 7,
        snatchedBy: [],
      },
    });
  });

  it("restores a tts clip as a tts widget", () => {
    const clip: Clip = {
      kind: "tts",
      id: "c1",
      trackId: "t1",
      start: 0,
      keyframes: baseKeyframes,
      audioBlobId: "blob2",
      audioBlake3: "hash2",
      audioMime: "audio/mpeg",
      durationSec: 3,
      ttsText: "hi there",
      ttsVoiceName: "Samantha",
      ttsVoiceLang: "en-US",
      ttsRate: 1.2,
      snatchedBy: [],
    };
    expect(restoreWidgetFromClip(clip)).toEqual({
      type: "tts",
      props: {
        blobId: "blob2",
        blake3: "hash2",
        mime: "audio/mpeg",
        duration: 3,
        ttsText: "hi there",
        ttsVoiceName: "Samantha",
        ttsVoiceLang: "en-US",
        ttsRate: 1.2,
        snatchedBy: [],
      },
    });
  });

  it("restores an audio-segment clip as a generic file widget, deriving duration from the trim range", () => {
    const clip: Clip = {
      kind: "audio-segment",
      id: "c1",
      trackId: "t1",
      start: 0,
      keyframes: baseKeyframes,
      audioBlobId: "blob3",
      audioBlake3: "hash3",
      audioMime: "audio/wav",
      sourceInSec: 2,
      sourceOutSec: 9,
      label: "my-clip.wav",
      snatchedBy: [],
    };
    expect(restoreWidgetFromClip(clip)).toEqual({
      type: "file",
      props: {
        blobId: "blob3",
        blake3: "hash3",
        mime: "audio/wav",
        domain: "audio",
        filename: "my-clip.wav",
        duration: 7,
        snatchedBy: [],
      },
    });
  });

  it("restores a video-segment clip as a generic file widget, deriving duration from the trim range", () => {
    const clip: Clip = {
      kind: "video-segment",
      id: "c1",
      trackId: "t1",
      start: 0,
      keyframes: baseKeyframes,
      videoBlobId: "blob4",
      videoBlake3: "hash4",
      videoMime: "video/mp4",
      sourceInSec: 1,
      sourceOutSec: 4.5,
      muted: false,
      snatchedBy: [],
    };
    expect(restoreWidgetFromClip(clip)).toEqual({
      type: "file",
      props: {
        blobId: "blob4",
        blake3: "hash4",
        mime: "video/mp4",
        domain: "video",
        duration: 3.5,
        snatchedBy: [],
      },
    });
  });
});

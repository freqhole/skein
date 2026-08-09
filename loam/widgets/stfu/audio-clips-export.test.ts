import { describe, expect, it } from "vitest";
import { AUDIO_CLIP_MANIFEST_VERSION, buildAudioClipManifest } from "./audio-clips-export";
import type { AudioClip } from "./types";

function clip(overrides: Partial<AudioClip> & { id: string; audioBlobId: string }): AudioClip & { audioBlobId: string } {
  return {
    trackId: "default",
    start: 0,
    durationSec: 0,
    label: "",
    ...overrides,
  };
}

describe("buildAudioClipManifest", () => {
  it("maps clip fields and sorts by start time", () => {
    const clips = [
      clip({ id: "b", audioBlobId: "blob-b", start: 5, durationSec: 2, kind: "recording" }),
      clip({ id: "a", audioBlobId: "blob-a", start: 0, durationSec: 1, kind: "tts", ttsText: "hello" }),
    ];
    const manifest = buildAudioClipManifest(clips, (c) => `/local/${c.id}.wav`);

    expect(manifest.manifestVersion).toBe(AUDIO_CLIP_MANIFEST_VERSION);
    expect(manifest.audioClips).toEqual([
      {
        id: "a",
        trackId: "default",
        start: 0,
        durationSec: 1,
        label: "",
        origin: "tts",
        ttsText: "hello",
        audioFilename: "/local/a.wav",
      },
      {
        id: "b",
        trackId: "default",
        start: 5,
        durationSec: 2,
        label: "",
        origin: "recording",
        ttsText: "",
        audioFilename: "/local/b.wav",
      },
    ]);
  });

  it("defaults an undecided/missing kind to tts origin", () => {
    const clips = [clip({ id: "a", audioBlobId: "blob-a" })];
    const manifest = buildAudioClipManifest(clips, () => "/x.wav");
    expect(manifest.audioClips[0]?.origin).toBe("tts");
  });

  it("returns an empty audioClips array for no clips", () => {
    expect(buildAudioClipManifest([], () => "")).toEqual({
      manifestVersion: AUDIO_CLIP_MANIFEST_VERSION,
      audioClips: [],
    });
  });
});

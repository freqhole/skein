import { describe, expect, it } from "vitest";
import {
  voiceRecordingSchema,
  voiceRecordingWidget,
  darkenHex,
  volumeToRawOpenness,
  smoothLerp,
} from "./voice-recording";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe("voiceRecordingSchema", () => {
  it("defaults blobId, blake3, and snatchedBy to empty / empty / []", () => {
    const result = voiceRecordingSchema.parse({});
    expect(result.blobId).toBe("");
    expect(result.blake3).toBe("");
    expect(result.snatchedBy).toEqual([]);
  });

  it("defaults lipsColor to 0xc2455a", () => {
    const result = voiceRecordingSchema.parse({});
    expect(result.lipsColor).toBe(0xc2455a);
  });

  it("accepts a custom lipsColor and round-trips it", () => {
    const result = voiceRecordingSchema.parse({ lipsColor: 0xff0000 });
    expect(result.lipsColor).toBe(0xff0000);
  });

  it("round-trips all audio blob fields after a recording", () => {
    const result = voiceRecordingSchema.parse({
      blobId: "abc123",
      blake3: "deadbeef",
      snatchedBy: ["node-a"],
      duration: 4.2,
      filename: "voice-recording-2026-01-01T00-00-00.webm",
    });
    expect(result.blobId).toBe("abc123");
    expect(result.blake3).toBe("deadbeef");
    expect(result.snatchedBy).toEqual(["node-a"]);
    expect(result.duration).toBeCloseTo(4.2);
  });
});

// ---------------------------------------------------------------------------
// widget metadata
// ---------------------------------------------------------------------------

describe("voiceRecordingWidget metadata", () => {
  it("has type voice-recording", () => {
    expect(voiceRecordingWidget.type).toBe("voice-recording");
  });

  it("metadata name is 'voice recording'", () => {
    expect(voiceRecordingWidget.metadata.name).toBe("voice recording");
  });
});

// ---------------------------------------------------------------------------
// getCompactInfo
// ---------------------------------------------------------------------------

describe("voiceRecordingWidget.getCompactInfo", () => {
  it("returns 'voice recording' label when no filename is set", () => {
    const info = voiceRecordingWidget.getCompactInfo(voiceRecordingSchema.parse({}));
    expect(info.label).toBe("voice recording");
  });

  it("strips the file extension from the filename for the label", () => {
    const info = voiceRecordingWidget.getCompactInfo(
      voiceRecordingSchema.parse({ filename: "voice-recording-2026-01-01T00-00-00.webm" })
    );
    expect(info.label).toBe("voice-recording-2026-01-01T00-00-00");
  });

  it("surfaces blake3 and snatchedBy for peer-targeted snatch", () => {
    const info = voiceRecordingWidget.getCompactInfo(
      voiceRecordingSchema.parse({
        blobId: "abc123",
        filename: "voice.webm",
        blake3: "deadbeef",
        snatchedBy: ["node-a"],
      })
    );
    expect(info.blake3).toBe("deadbeef");
    expect(info.snatchedBy).toEqual(["node-a"]);
  });

  it("domain is 'audio'", () => {
    const info = voiceRecordingWidget.getCompactInfo(voiceRecordingSchema.parse({}));
    expect(info.domain).toBe("audio");
  });
});

// ---------------------------------------------------------------------------
// darkenHex — the darker-lip-stroke helper
// ---------------------------------------------------------------------------

describe("darkenHex", () => {
  it("darkens each channel by the given factor", () => {
    // 0xffffff scaled by 0.5 => each channel ~128 => 0x808080
    const result = darkenHex(0xffffff, 0.5);
    const r = (result >> 16) & 0xff;
    const g = (result >> 8) & 0xff;
    const b = result & 0xff;
    expect(r).toBe(128);
    expect(g).toBe(128);
    expect(b).toBe(128);
  });

  it("factor 1.0 returns the original color unchanged", () => {
    expect(darkenHex(0xc2455a, 1.0)).toBe(0xc2455a);
  });

  it("factor 0 blacks out the color", () => {
    expect(darkenHex(0xffffff, 0)).toBe(0x000000);
  });

  it("0.7 factor on the default lipsColor produces a strictly darker shade", () => {
    const original = 0xc2455a;
    const darkened = darkenHex(original, 0.7);
    const origR = (original >> 16) & 0xff;
    const darkR = (darkened >> 16) & 0xff;
    expect(darkR).toBeLessThan(origR);
  });

  it("clamps channels to 0..255 (no overflow or underflow)", () => {
    // factor > 1 should not overflow a channel
    const result = darkenHex(0xffffff, 2);
    const r = (result >> 16) & 0xff;
    expect(r).toBeLessThanOrEqual(255);
    // factor 0 should not go below 0
    const zero = darkenHex(0x000000, 0);
    expect(zero).toBe(0x000000);
  });
});

// ---------------------------------------------------------------------------
// volumeToRawOpenness — the volume-to-openness mapping
// ---------------------------------------------------------------------------

describe("volumeToRawOpenness", () => {
  it("returns 0 at exactly the noise floor (silence clamps to 0)", () => {
    expect(volumeToRawOpenness(0.02, 0.02)).toBe(0);
  });

  it("returns 0 for any rms below the noise floor", () => {
    expect(volumeToRawOpenness(0, 0.02)).toBe(0);
    expect(volumeToRawOpenness(0.01, 0.02)).toBe(0);
  });

  it("returns 1 at or above the soft ceiling", () => {
    // SOFT_CEILING is 0.28; any rms >= that should clamp to 1
    expect(volumeToRawOpenness(0.28)).toBe(1);
    expect(volumeToRawOpenness(0.5)).toBe(1);
    expect(volumeToRawOpenness(1)).toBe(1);
  });

  it("returns a value strictly between 0 and 1 for mid-range input", () => {
    const v = volumeToRawOpenness(0.15);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it("is monotonically increasing between noise floor and soft ceiling", () => {
    const a = volumeToRawOpenness(0.05);
    const b = volumeToRawOpenness(0.10);
    const c = volumeToRawOpenness(0.20);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

// ---------------------------------------------------------------------------
// smoothLerp — attack vs decay smoothing
// ---------------------------------------------------------------------------

describe("smoothLerp", () => {
  it("attack step (rising toward target) is larger than decay step (falling toward target)", () => {
    // one step from 0 toward 1 with default attack=0.6 => 0.6
    const afterAttack = smoothLerp(0, 1);
    // one step from 1 toward 0 with default decay=0.15 => 0.85
    const afterDecay = smoothLerp(1, 0);
    // 0 + 0.6*(1-0) = 0.6   vs   1 + 0.15*(0-1) = 0.85
    // attack moved 0.6 of the way; decay moved only 0.15 of the way
    expect(afterAttack).toBeCloseTo(0.6);
    expect(afterDecay).toBeCloseTo(0.85);
    // so attack amplitude (0.6) > decay amplitude (0.15)
    expect(afterAttack).toBeGreaterThan(1 - afterDecay);
  });

  it("when already at target, lerp is a no-op", () => {
    expect(smoothLerp(0, 0)).toBe(0);
    expect(smoothLerp(1, 1)).toBe(1);
    expect(smoothLerp(0.5, 0.5)).toBe(0.5);
  });

  it("custom attack/decay values are respected", () => {
    const result = smoothLerp(0, 1, 0.3, 0.1);
    expect(result).toBeCloseTo(0.3);
    const resultDecay = smoothLerp(1, 0, 0.3, 0.1);
    expect(resultDecay).toBeCloseTo(0.9);
  });

  it("never overshoots the target", () => {
    // with attack=0.6 from 0 to 1, result should not exceed 1
    const r = smoothLerp(0, 1, 0.6, 0.15);
    expect(r).toBeLessThanOrEqual(1);
    // with decay=0.15 from 1 to 0, result should not go below 0
    const r2 = smoothLerp(1, 0, 0.6, 0.15);
    expect(r2).toBeGreaterThanOrEqual(0);
  });
});

import { describe, expect, it } from "vitest";
import { encodeAudioBufferToWav, encodeWav, interleaveChannels } from "./wav-encode";

describe("interleaveChannels", () => {
  it("returns the single channel as-is (mono)", () => {
    const mono = new Float32Array([0.1, 0.2, 0.3]);
    expect(interleaveChannels([mono])).toBe(mono);
  });

  it("interleaves 2 channels sample-by-sample", () => {
    const left = new Float32Array([1, 2, 3]);
    const right = new Float32Array([-1, -2, -3]);
    expect(Array.from(interleaveChannels([left, right]))).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it("returns an empty array for zero channels", () => {
    expect(interleaveChannels([]).length).toBe(0);
  });
});

describe("encodeWav", () => {
  function readHeader(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const str = (offset: number, len: number) =>
      String.fromCharCode(...Array.from(bytes.slice(offset, offset + len)));
    return {
      riff: str(0, 4),
      wave: str(8, 4),
      fmt: str(12, 4),
      audioFormat: view.getUint16(20, true),
      numChannels: view.getUint16(22, true),
      sampleRate: view.getUint32(24, true),
      bitsPerSample: view.getUint16(34, true),
      dataTag: str(36, 4),
      dataSize: view.getUint32(40, true),
    };
  }

  it("writes a valid 44-byte RIFF/WAVE header for mono 16-bit PCM", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = encodeWav(samples, 1, 44100);
    const header = readHeader(bytes);
    expect(header.riff).toBe("RIFF");
    expect(header.wave).toBe("WAVE");
    expect(header.fmt).toBe("fmt ");
    expect(header.audioFormat).toBe(1);
    expect(header.numChannels).toBe(1);
    expect(header.sampleRate).toBe(44100);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataTag).toBe("data");
    expect(header.dataSize).toBe(samples.length * 2);
    expect(bytes.length).toBe(44 + samples.length * 2);
  });

  it("clamps out-of-range samples instead of overflowing", () => {
    const samples = new Float32Array([2, -2]); // out of the [-1, 1] range
    const bytes = encodeWav(samples, 1, 44100);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getInt16(44, true)).toBe(0x7fff); // clamped to +1 -> max positive
    expect(view.getInt16(46, true)).toBe(-0x8000); // clamped to -1 -> max negative
  });

  it("round-trips a known sample value within 16-bit rounding error", () => {
    const bytes = encodeWav(new Float32Array([0.5]), 1, 44100);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoded = view.getInt16(44, true) / 0x7fff;
    expect(decoded).toBeCloseTo(0.5, 3);
  });
});

describe("encodeAudioBufferToWav", () => {
  it("interleaves then encodes stereo channels in one call", () => {
    const left = new Float32Array([1, 0]);
    const right = new Float32Array([-1, 0]);
    const bytes = encodeAudioBufferToWav([left, right], 48000);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(22, true)).toBe(2); // numChannels
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(2 * 2 * 2); // 2 samples * 2 channels * 2 bytes
  });
});

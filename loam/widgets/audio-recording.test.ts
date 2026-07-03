import { describe, expect, it, vi } from "vitest";
import {
  audioRecordingSchema,
  audioRecordingWidget,
  resolveAudioBytes,
  type AudioBlobRef,
  type ResolveAudioBytesDeps,
} from "./audio-recording";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe("audioRecordingSchema", () => {
  it("defaults blake3 and snatchedBy for a fresh (never-recorded) widget", () => {
    const result = audioRecordingSchema.parse({});
    expect(result.blake3).toBe("");
    expect(result.snatchedBy).toEqual([]);
  });

  it("round-trips blake3 and snatchedBy written after a recording", () => {
    const result = audioRecordingSchema.parse({
      blobId: "abc123",
      blake3: "deadbeef",
      snatchedBy: ["node-a"],
    });
    expect(result.blake3).toBe("deadbeef");
    expect(result.snatchedBy).toEqual(["node-a"]);
  });
});

describe("audioRecordingWidget metadata", () => {
  it("has correct type", () => {
    expect(audioRecordingWidget.type).toBe("audio-recording");
  });

  it("compact info surfaces blake3 and snatchedBy for peer-targeted snatch", () => {
    const info = audioRecordingWidget.getCompactInfo(
      audioRecordingSchema.parse({
        blobId: "abc123",
        filename: "recording-1.webm",
        blake3: "deadbeef",
        snatchedBy: ["node-a"],
      })
    );
    expect(info.blake3).toBe("deadbeef");
    expect(info.snatchedBy).toEqual(["node-a"]);
  });
});

// ---------------------------------------------------------------------------
// resolveAudioBytes — the "resolve playback bytes, snatching from a peer if
// they aren't local yet" algorithm behind getPlaybackUrl(). this is the exact
// gap that caused "[audio-recording] no playback URL available" on a remote
// peer's widget: the doc synced, but nothing ever fetched the blob bytes.
// ---------------------------------------------------------------------------

function makeRef(overrides: Partial<AudioBlobRef> = {}): AudioBlobRef {
  return {
    blobId: "blob-1",
    filename: "recording-1.webm",
    mime: "audio/webm",
    size: 1234,
    blake3: "blake3-1",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ResolveAudioBytesDeps> = {}): ResolveAudioBytesDeps {
  return {
    getBlobData: vi.fn(async () => null),
    checkBlobLocality: vi.fn(async () => ({ locality: "remote" as const })),
    snatchBlob: vi.fn(async () => {
      throw new Error("snatchBlob should not be called in this test");
    }),
    getLocalNodeId: vi.fn(async () => "local-node"),
    ...overrides,
  };
}

describe("resolveAudioBytes", () => {
  it("returns null when there's no blob yet", async () => {
    const deps = makeDeps();
    const result = await resolveAudioBytes(makeRef({ blobId: "" }), undefined, deps);
    expect(result).toBeNull();
    expect(deps.getBlobData).not.toHaveBeenCalled();
  });

  it("fast path: returns local bytes directly without checking locality or snatching", async () => {
    const buffer = new ArrayBuffer(8);
    const deps = makeDeps({ getBlobData: vi.fn(async () => buffer) });

    const result = await resolveAudioBytes(makeRef(), { peer1: { nodeId: "node-a" } }, deps);

    expect(result).toEqual({
      buffer,
      blobId: "blob-1",
      blake3: "blake3-1",
      snatchedByNodeId: null,
    });
    expect(deps.checkBlobLocality).not.toHaveBeenCalled();
    expect(deps.snatchBlob).not.toHaveBeenCalled();
  });

  it("does not snatch when locality says local but bytes are missing (avoids a pointless P2P round-trip)", async () => {
    const deps = makeDeps({
      getBlobData: vi.fn(async () => null),
      checkBlobLocality: vi.fn(async () => ({ locality: "local" as const })),
    });

    const result = await resolveAudioBytes(makeRef(), { peer1: { nodeId: "node-a" } }, deps);

    expect(result).toBeNull();
    expect(deps.snatchBlob).not.toHaveBeenCalled();
  });

  it("returns null with no peers available, without attempting a snatch", async () => {
    const deps = makeDeps();
    const result = await resolveAudioBytes(makeRef(), undefined, deps);
    expect(result).toBeNull();
    expect(deps.snatchBlob).not.toHaveBeenCalled();

    const resultEmptyPeers = await resolveAudioBytes(makeRef(), {}, deps);
    expect(resultEmptyPeers).toBeNull();
    expect(deps.snatchBlob).not.toHaveBeenCalled();
  });

  it("remote peer's widget: snatches the blob from a canvas peer, then reads the bytes", async () => {
    const buffer = new ArrayBuffer(16);
    const getBlobData = vi
      .fn<ResolveAudioBytesDeps["getBlobData"]>()
      .mockResolvedValueOnce(null) // fast path miss — bytes aren't local yet
      .mockResolvedValueOnce(buffer); // post-snatch read succeeds

    const snatchBlob = vi.fn(async () => ({ blobId: "blob-1", blake3: "blake3-1" }));

    const deps = makeDeps({
      getBlobData,
      checkBlobLocality: vi.fn(async () => ({ locality: "remote" as const })),
      snatchBlob,
    });

    const onProgress = vi.fn();
    const isPeerOnline = vi.fn(() => true);
    const peers = { peer1: { nodeId: "node-a" } };

    const result = await resolveAudioBytes(makeRef(), peers, deps, onProgress, isPeerOnline);

    expect(result).toEqual({
      buffer,
      blobId: "blob-1",
      blake3: "blake3-1",
      snatchedByNodeId: "local-node",
    });
    expect(snatchBlob).toHaveBeenCalledWith(
      { ...makeRef(), domain: "audio" },
      peers,
      expect.objectContaining({ onProgress, isPeerOnline })
    );
    expect(getBlobData).toHaveBeenCalledTimes(2);
  });

  it("keeps the re-keyed blobId/blake3 from snatchBlob (sha256 dedup may map to an existing blob)", async () => {
    const buffer = new ArrayBuffer(4);
    const getBlobData = vi
      .fn<ResolveAudioBytesDeps["getBlobData"]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(buffer);

    const deps = makeDeps({
      getBlobData,
      checkBlobLocality: vi.fn(async () => ({ locality: "remote" as const })),
      snatchBlob: vi.fn(async () => ({ blobId: "existing-blob", blake3: "existing-blake3" })),
    });

    const result = await resolveAudioBytes(makeRef(), { peer1: { nodeId: "node-a" } }, deps);

    expect(result?.blobId).toBe("existing-blob");
    expect(result?.blake3).toBe("existing-blake3");
    expect(getBlobData).toHaveBeenLastCalledWith("existing-blob");
  });

  it("returns null when the post-snatch read still can't find the bytes", async () => {
    const deps = makeDeps({
      getBlobData: vi.fn(async () => null),
      checkBlobLocality: vi.fn(async () => ({ locality: "remote" as const })),
      snatchBlob: vi.fn(async () => ({ blobId: "blob-1", blake3: "blake3-1" })),
    });

    const result = await resolveAudioBytes(makeRef(), { peer1: { nodeId: "node-a" } }, deps);
    expect(result).toBeNull();
  });
});

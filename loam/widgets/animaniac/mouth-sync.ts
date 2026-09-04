/**
 * mouth-lips animation sync for `voice-recording` clips during animaniac
 * playback — reuses `voice-recording-mouth.ts`'s `MouthRenderer`/
 * `computeRmsEnvelope`/`volumeToRawOpenness` verbatim (the same
 * computation `voice-recording.ts` already does for its own local
 * `<audio>` playback), just re-triggered from animaniac's own
 * `playback-clock.ts` instead.
 *
 * split into a pure half (`opennessAtElapsed()` — unit-tested) and a
 * browser-only fetch/decode/cache half (`createMouthEnvelopeCache()` —
 * not unit-tested, needs a real `OfflineAudioContext`/`fetch`, matching
 * this codebase's convention for browser-media-API-heavy code).
 */

import type { PeersMap } from "../../src/file-utils/file-shared";
import { getMediaPlaybackUrl } from "../../src/media";
import { computeRmsEnvelope, ENVELOPE_HZ, volumeToRawOpenness } from "../voice-recording-mouth";
import type { VoiceRecordingClip } from "./types";

/** resolves the mouth-openness value (0..1) at `elapsedSec` into a
 *  precomputed RMS envelope (see `computeRmsEnvelope()`) — pure, indexes
 *  the nearest envelope bucket and clamps at the ends. */
export function opennessAtElapsed(envelope: Float32Array, elapsedSec: number, hz: number = ENVELOPE_HZ): number {
  if (envelope.length === 0) return 0;
  const index = Math.max(0, Math.min(envelope.length - 1, Math.floor(elapsedSec * hz)));
  return volumeToRawOpenness(envelope[index]);
}

export interface MouthEnvelopeCacheOptions {
  getPeers?: () => PeersMap | undefined;
}

export interface MouthEnvelopeCache {
  /** fetches + decodes + computes the envelope for a voice-recording
   *  clip's own audio blob, once, cached by blobId thereafter. returns
   *  null (non-fatal) if the blob can't be resolved/decoded — the clip
   *  still plays audio via the normal audio path, the mouth just stays
   *  closed (matches `voice-recording.ts`'s own non-fatal precedent). */
  getEnvelope(clip: VoiceRecordingClip): Promise<Float32Array | null>;
  clear(): void;
}

export function createMouthEnvelopeCache(options: MouthEnvelopeCacheOptions = {}): MouthEnvelopeCache {
  const { getPeers } = options;
  const cache = new Map<string, Float32Array | null>();

  return {
    async getEnvelope(clip: VoiceRecordingClip): Promise<Float32Array | null> {
      if (!clip.audioBlobId) return null;
      const cached = cache.get(clip.audioBlobId);
      if (cached !== undefined) return cached;
      try {
        const url = await getMediaPlaybackUrl(clip.audioBlobId, {
          category: "audio",
          mime: clip.audioMime || undefined,
          blake3: clip.audioBlake3 || undefined,
          peers: getPeers?.(),
        });
        if (!url) {
          cache.set(clip.audioBlobId, null);
          return null;
        }
        const bytes = await (await fetch(url)).arrayBuffer();
        const decodeCtx = new OfflineAudioContext(1, 1, 44100);
        const decoded = await decodeCtx.decodeAudioData(bytes);
        const envelope = computeRmsEnvelope(decoded.getChannelData(0), decoded.sampleRate, ENVELOPE_HZ);
        cache.set(clip.audioBlobId, envelope);
        return envelope;
      } catch (err) {
        console.warn(`[animaniac] mouth-sync: envelope decode failed for clip ${clip.id} (mouth will stay closed):`, err);
        cache.set(clip.audioBlobId, null);
        return null;
      }
    },
    clear() {
      cache.clear();
    },
  };
}

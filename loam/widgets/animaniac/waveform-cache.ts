/**
 * shared, in-memory-only waveform envelope cache for animaniac's
 * audio-bearing clips (voice-recording/tts/audio-segment) — one fetch +
 * decode + RMS-envelope pass per unique source blob, no matter how many
 * clips/tracks/widget instances reference it, and no doc persistence (see
 * docs discussion: start simple, only add a stored/precomputed envelope
 * later if this in-memory approach actually proves too slow in practice).
 *
 * reuses `computeRmsEnvelope`/`ENVELOPE_HZ` verbatim — the exact same
 * envelope extraction voice-recording.ts's own playback mouth-animation
 * (and animaniac's own mouth-sync.ts) already use, just for a different
 * consumer. the envelope covers the WHOLE source (never just a trimmed
 * range) at a fixed, modest resolution, so it survives later re-trims —
 * same reasoning as gain rendering always using the whole source.
 *
 * memory: only the small envelope array is retained here — the actual
 * decoded `AudioBuffer` (the heavy part) is used once to compute it, then
 * dropped. the fetch itself is gated through the app-wide download-slot
 * queue (already used by P2P snatch downloads) so opening a timeline with
 * many audio clips doesn't fire an unbounded burst of concurrent fetches.
 */

import { computeRmsEnvelope, ENVELOPE_HZ } from "../voice-recording-mouth";
import { getMediaPlaybackUrl } from "../../src/media";
import { acquireDownloadSlot, releaseDownloadSlot } from "../../src/file-utils/transfer-queue";
import type { PeersMap } from "../../src/file-utils/file-shared";
import type { AudioRef } from "./audio-playback";

const cache = new Map<string, Promise<Float32Array | null>>();

function cacheKey(ref: AudioRef): string {
  return ref.blake3 || ref.blobId;
}

async function fetchAndDecode(ref: AudioRef, getPeers: (() => PeersMap | undefined) | undefined): Promise<Float32Array | null> {
  const url = await getMediaPlaybackUrl(ref.blobId, {
    category: "audio",
    mime: ref.mime || undefined,
    blake3: ref.blake3 || undefined,
    peers: getPeers?.(),
  });
  if (!url) return null;

  const slotId = await acquireDownloadSlot(undefined, { blobId: ref.blobId });
  try {
    const bytes = await fetch(url).then((r) => r.arrayBuffer());
    const decodeCtx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await decodeCtx.decodeAudioData(bytes);
    return computeRmsEnvelope(decoded.getChannelData(0), decoded.sampleRate, ENVELOPE_HZ);
  } finally {
    releaseDownloadSlot(slotId);
  }
}

/** resolves (and caches) the full-source RMS envelope for `ref` — never
 *  rejects; a fetch/decode failure just resolves to `null` (caller draws
 *  nothing, same "non-fatal, one bad blob doesn't break the rest" spirit
 *  as every other best-effort media resolve in this codebase). */
export function getWaveformEnvelope(
  ref: AudioRef,
  getPeers?: () => PeersMap | undefined
): Promise<Float32Array | null> {
  if (!ref.blobId) return Promise.resolve(null);
  const key = cacheKey(ref);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = fetchAndDecode(ref, getPeers).catch(() => null);
  cache.set(key, promise);
  return promise;
}

/** slices `envelope` (covering the WHOLE source, see module doc) down to
 *  just `[sourceInSec, sourceOutSec]` and buckets it to at most `maxBars`
 *  samples — cheap array math, safe to redo on every redraw (zoom/pan/
 *  trim), unlike the fetch+decode above which only ever happens once. */
export function resampleEnvelopeRange(
  envelope: Float32Array,
  sourceInSec: number,
  sourceOutSec: number,
  maxBars: number,
  hz: number = ENVELOPE_HZ
): Float32Array {
  const startIdx = Math.max(0, Math.floor(sourceInSec * hz));
  const endIdx = Math.min(envelope.length, Math.ceil(sourceOutSec * hz));
  const rangeLen = Math.max(1, endIdx - startIdx);
  const bars = Math.max(1, Math.min(maxBars, rangeLen));
  const out = new Float32Array(bars);
  for (let i = 0; i < bars; i++) {
    const bucketStart = startIdx + Math.floor((i / bars) * rangeLen);
    const bucketEnd = startIdx + Math.floor(((i + 1) / bars) * rangeLen);
    let max = 0;
    for (let j = bucketStart; j < Math.max(bucketEnd, bucketStart + 1) && j < envelope.length; j++) {
      if (envelope[j] > max) max = envelope[j];
    }
    out[i] = max;
  }
  return out;
}

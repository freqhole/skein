/**
 * in-browser multi-track audio mixdown — renders every audio-bearing clip
 * across every non-muted audio track into one mixed-down WAV file via
 * `OfflineAudioContext`. no ffmpeg/server dependency, matching a pattern
 * already proven elsewhere in this codebase (`voice-recording.ts` already
 * uses `OfflineAudioContext`/`decodeAudioData` for offline decode).
 *
 * overlap is expected and handled for free: scheduling N overlapping
 * `AudioBufferSourceNode`s onto the same `OfflineAudioContext` destination
 * just sums them (that's what an audio mixing graph *is*) — no special
 * casing needed for docs/animaniac-media-segments-plan.md's decision D.
 *
 * this is the phase-1 export deliverable (see that doc's priority
 * reframe) — video export/mixdown is an explicit non-goal for now.
 */

import type { PeersMap } from "../../../src/file-utils/file-shared";
import { getMediaPlaybackUrl } from "../../../src/media";
import { clipDurationSec } from "../track-model";
import type { AudioSegmentClip, Clip, Track, TtsClip, VoiceRecordingClip } from "../types";
import { encodeAudioBufferToWav } from "./wav-encode";

const DEFAULT_SAMPLE_RATE = 44100;

type AudioBearingClip = VoiceRecordingClip | TtsClip | AudioSegmentClip;

function isAudioBearing(clip: Clip): clip is AudioBearingClip {
  return clip.kind === "voice-recording" || clip.kind === "tts" || clip.kind === "audio-segment";
}

/** where in the SOURCE audio this clip's playback should start from —
 *  trimmed segments start at their own `sourceInSec`, whole-clip kinds
 *  (voice-recording/tts) always start at 0. */
function sourceOffsetSec(clip: AudioBearingClip): number {
  return clip.kind === "audio-segment" ? clip.sourceInSec : 0;
}

export interface AudioMixdownOptions {
  tracks: readonly Track[];
  clips: readonly Clip[];
  getPeers?: () => PeersMap | undefined;
  sampleRate?: number;
  /** best-effort progress across the decode phase (0..1) — rendering
   *  itself (`OfflineAudioContext.startRendering()`) has no native
   *  progress signal, so this only covers fetch+decode of each unique
   *  blob, which dominates the total time for anything but a trivially
   *  short mixdown. */
  onProgress?: (fraction: number) => void;
}

export interface AudioMixdownResult {
  bytes: Uint8Array;
  durationSec: number;
  /** ids of clips that were skipped (no audio yet, or fetch/decode failed)
   *  — the mixdown still completes with whatever DID resolve rather than
   *  failing the whole export over one bad clip. */
  skippedClipIds: string[];
}

/** fetches + decodes one clip's audio blob, returning null (and letting
 *  the caller skip it) rather than throwing — one unreachable/corrupt
 *  blob shouldn't fail the whole mixdown. */
async function decodeClipAudio(
  clip: AudioBearingClip,
  decodeCtx: OfflineAudioContext,
  getPeers: (() => PeersMap | undefined) | undefined,
  cache: Map<string, AudioBuffer | null>
): Promise<AudioBuffer | null> {
  const blobId = clip.audioBlobId;
  if (!blobId) return null; // e.g. a tts clip that hasn't been generated yet
  const cached = cache.get(blobId);
  if (cached !== undefined) return cached;

  try {
    const url = await getMediaPlaybackUrl(blobId, {
      category: "audio",
      mime: clip.audioMime || undefined,
      blake3: clip.audioBlake3 || undefined,
      peers: getPeers?.(),
    });
    if (!url) {
      cache.set(blobId, null);
      return null;
    }
    const res = await fetch(url);
    const bytes = await res.arrayBuffer();
    const decoded = await decodeCtx.decodeAudioData(bytes);
    cache.set(blobId, decoded);
    return decoded;
  } catch (err) {
    console.warn(`[animaniac] audio-mixdown: failed to decode clip ${clip.id} (blob ${blobId}):`, err);
    cache.set(blobId, null);
    return null;
  }
}

/** renders every audio-bearing clip on every non-muted/non-hidden audio
 *  track into one mixed-down WAV. */
export async function renderAudioMixdown(options: AudioMixdownOptions): Promise<AudioMixdownResult> {
  const { tracks, clips, getPeers, sampleRate = DEFAULT_SAMPLE_RATE, onProgress } = options;

  const audibleTrackIds = new Set(tracks.filter((t) => t.kind === "audio" && !t.muted && !t.hidden).map((t) => t.id));
  const audioClips = clips.filter((c): c is AudioBearingClip => isAudioBearing(c) && audibleTrackIds.has(c.trackId));

  const durationSec = audioClips.reduce((max, c) => Math.max(max, c.start + clipDurationSec(c)), 0);
  const totalFrames = Math.max(1, Math.ceil(durationSec * sampleRate));

  // a throwaway 2-channel context just for decodeAudioData — decoding
  // doesn't depend on the render context's own length/duration.
  const decodeCtx = new OfflineAudioContext(2, 1, sampleRate);
  const decodeCache = new Map<string, AudioBuffer | null>();

  const skippedClipIds: string[] = [];
  const decoded: Array<{ clip: AudioBearingClip; buffer: AudioBuffer }> = [];
  for (let i = 0; i < audioClips.length; i++) {
    const clip = audioClips[i];
    const buffer = await decodeClipAudio(clip, decodeCtx, getPeers, decodeCache);
    if (buffer) {
      decoded.push({ clip, buffer });
    } else {
      skippedClipIds.push(clip.id);
    }
    onProgress?.((i + 1) / Math.max(1, audioClips.length));
  }

  const renderCtx = new OfflineAudioContext(2, totalFrames, sampleRate);
  for (const { clip, buffer } of decoded) {
    const source = renderCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(renderCtx.destination);
    const playDurationSec = clipDurationSec(clip);
    const offsetSec = sourceOffsetSec(clip);
    // clamp so a clip whose stored duration is optimistic relative to its
    // actually-decoded buffer never asks Web Audio to play past the end of
    // what's really there (throws otherwise).
    const availableSec = Math.max(0, buffer.duration - offsetSec);
    source.start(clip.start, offsetSec, Math.min(playDurationSec, availableSec));
  }

  const rendered = await renderCtx.startRendering();
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) channels.push(rendered.getChannelData(ch));
  const bytes = encodeAudioBufferToWav(channels, rendered.sampleRate);

  return { bytes, durationSec, skippedClipIds };
}

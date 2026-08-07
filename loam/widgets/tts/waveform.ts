/**
 * best-effort waveform thumbnail computation for freshly-generated tts
 * audio — decodes the wav bytes locally and downsamples to a small peak
 * array, matching `audio-recording.ts`'s `waveformSamples` convention.
 */

import { base64Decode } from "@freqhole/reliquary/worker";

const DEFAULT_BUCKET_COUNT = 48;

export async function computeWaveformSamples(
  base64Data: string,
  bucketCount = DEFAULT_BUCKET_COUNT
): Promise<number[]> {
  if (!base64Data) return [];

  let audioCtx: AudioContext | null = null;
  try {
    const bytes = await base64Decode(base64Data);
    audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(bytes.slice().buffer);
    const channel = audioBuffer.getChannelData(0);

    const bucketSize = Math.max(1, Math.floor(channel.length / bucketCount));
    const samples: number[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const start = i * bucketSize;
      const end = Math.min(channel.length, start + bucketSize);
      let peak = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(channel[j]);
        if (v > peak) peak = v;
      }
      samples.push(peak);
    }
    return samples;
  } catch (err) {
    console.error("[tts] computeWaveformSamples failed (non-fatal):", err);
    return [];
  } finally {
    if (audioCtx) void audioCtx.close();
  }
}

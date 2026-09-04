/**
 * pure PCM -> WAV encoder — no library needed (a WAV file is just a small
 * fixed header + raw 16-bit PCM samples). used by `audio-mixdown.ts` to
 * turn an `AudioBuffer` (the result of an `OfflineAudioContext` render)
 * into downloadable/playable bytes, mirroring `stfu`'s own "no ffmpeg/
 * server dependency, do it in the browser" precedent for anything that
 * doesn't strictly need one.
 */

/** interleaves N mono `Float32Array` channels (as produced by
 *  `AudioBuffer.getChannelData()`) into one array, sample-by-sample —
 *  WAV's own PCM layout is interleaved, not planar. */
export function interleaveChannels(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const out = new Float32Array(length * channels.length);
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < channels.length; ch++) {
      out[i * channels.length + ch] = channels[ch][i];
    }
  }
  return out;
}

function floatTo16BitPCM(view: DataView, offset: number, input: Float32Array): void {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/**
 * encodes interleaved float samples (`[-1, 1]` range, as Web Audio produces)
 * into a 16-bit PCM WAV file's raw bytes.
 * @param interleaved samples, already interleaved across `numChannels` (see `interleaveChannels`)
 */
export function encodeWav(interleaved: Float32Array, numChannels: number, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = interleaved.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  floatTo16BitPCM(view, 44, interleaved);

  return new Uint8Array(buffer);
}

/** convenience: encode a Web Audio `AudioBuffer`-shaped input directly. */
export function encodeAudioBufferToWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  return encodeWav(interleaveChannels(channels), channels.length, sampleRate);
}

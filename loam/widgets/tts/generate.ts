/**
 * generation backend for the tts widget — wraps the rust `tts_generate`
 * dispatch and normalizes its response into the widget schema's field
 * names. only ever called when `isGenerateAvailable()` is true (tauri +
 * `say`), so this assumes tauri mode without re-checking it itself.
 */

import { dispatch } from "../../src/p2p/tauri-transport";

export interface TtsGenerateResult {
  blobId: string;
  filename: string;
  mime: string;
  size: number;
  blake3: string;
  duration: number;
  /** base64 audio bytes, when the rust side mirrored them inline (gated by
   *  size) — used to compute a waveform thumbnail without a second fetch. */
  dataBase64: string;
}

export async function generateTtsAudio(
  text: string,
  voiceName: string,
  rate: number
): Promise<TtsGenerateResult> {
  const result = await dispatch("tts_generate", {
    text,
    voice_name: voiceName || undefined,
    rate,
  });
  const meta = (result?.meta ?? {}) as {
    blake3?: string;
    filename?: string;
    mime?: string;
    size?: number;
  };
  return {
    blobId: meta.blake3 ?? "",
    filename: meta.filename ?? "",
    mime: meta.mime ?? "audio/wav",
    size: meta.size ?? 0,
    blake3: meta.blake3 ?? "",
    duration: typeof result?.duration_secs === "number" ? result.duration_secs : 0,
    dataBase64: typeof result?.data === "string" ? result.data : "",
  };
}

/**
 * shared microphone-recording core — captures audio via `getUserMedia()` +
 * `MediaRecorder`, samples a live amplitude waveform via an `AnalyserNode`,
 * and stores the finished recording as a content-addressed blob (browser
 * OPFS via `storeBlobFromFile()`, or the rust `blob_insert` dispatch in
 * tauri mode — see the module doc comment in `widgets/audio-recording.ts`
 * for why tauri needs its own path: the browser blob worker's blake3
 * hasher has no midden module bundled there and always returns "").
 *
 * extracted from `widgets/audio-recording.ts` (that widget's own
 * `startRecording`/`stopRecording`/`finishRecording` predate this module and
 * still inline the same logic) so a second caller — stfu's audio-clips
 * recording feature — doesn't have to duplicate it. the widget owns all UI
 * state (button/waveform drawing, `recState` transitions); this module only
 * owns the media capture + storage mechanics, exposed via callbacks.
 */

import { isTauriMode, dispatch } from "../p2p/tauri-transport";
import { storeBlobFromFile } from "../storage/blob-store";
import { base64Encode } from "@freqhole/reliquary/worker";

export interface MicRecordingResult {
  blobId: string;
  blake3: string;
  mime: string;
  size: number;
  filename: string;
  duration: number;
  /** downsampled amplitude envelope (0..1 per sample) captured live during
   *  recording — capped at `maxWaveformSamples` (default 200). */
  waveformSamples: number[];
}

export interface MicRecordingSession {
  /** stop recording and finalize the blob — resolves (via `onFinish`/
   *  `onStoreError`) once storage completes. safe to call multiple times;
   *  a no-op after the first call. */
  stop(): void;
  /** abort immediately without storing anything — stops the mic stream and
   *  discards any captured audio (e.g. the widget was destroyed mid-
   *  recording). */
  cancel(): void;
}

export interface StartMicRecordingOptions {
  /** exact device id to request (from `enumerateDevices()`); omit for the
   *  system default input. */
  deviceId?: string;
  /** filename prefix for the stored blob; default "recording". */
  filenamePrefix?: string;
  /** cap on stored `waveformSamples` length (keeps doc size small); default 200. */
  maxWaveformSamples?: number;
  /** fires once permission is granted and MediaRecorder actually starts. */
  onStart?: () => void;
  /** live amplitude sample (0..1 RMS), called ~15x/sec while recording —
   *  drives a live waveform/elapsed-time UI. */
  onSample?: (amplitude: number, elapsedSec: number) => void;
  /** fires if `getUserMedia` is denied or otherwise fails — no session is
   *  returned in this case (`startMicRecording` resolves to `null`). */
  onError?: (err: unknown) => void;
  /** fires once the recording is finalized and successfully stored. */
  onFinish?: (result: MicRecordingResult) => void;
  /** fires if storing the finalized blob fails (recording itself still
   *  happened — the bytes are just lost, matching audio-recording.ts's own
   *  "processing → error" behavior in this case). */
  onStoreError?: (err: unknown) => void;
}

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  for (const m of candidates) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // ignore
    }
  }
  return "";
}

function mimeToExt(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return "webm";
}

/**
 * start capturing microphone audio. resolves to `null` (after calling
 * `onError`) if `getUserMedia` fails; otherwise resolves to a session handle
 * once `MediaRecorder` has actually started.
 */
export async function startMicRecording(
  options: StartMicRecordingOptions = {}
): Promise<MicRecordingSession | null> {
  const {
    deviceId,
    filenamePrefix = "recording",
    maxWaveformSamples = 200,
    onStart,
    onSample,
    onError,
    onFinish,
    onStoreError,
  } = options;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
  } catch (err) {
    onError?.(err);
    return null;
  }

  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  audioCtx.createMediaStreamSource(stream).connect(analyser);

  const mime = pickMimeType();
  const audioChunks: Blob[] = [];
  const liveSamples: number[] = [];
  const recStartTime = Date.now();
  let stopped = false;
  let rafId: number | null = null;

  const mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  const stopWaveSampling = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const startWaveSampling = () => {
    const bufLen = analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);
    let frameCount = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      analyser.getByteTimeDomainData(dataArr);
      let sum = 0;
      for (let i = 0; i < bufLen; i++) {
        const v = (dataArr[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / bufLen);
      frameCount++;
      if (frameCount % 4 === 0) liveSamples.push(rms);
      onSample?.(rms, (Date.now() - recStartTime) / 1000);
    };
    rafId = requestAnimationFrame(tick);
  };

  const finish = async (durationSecs: number) => {
    stopWaveSampling();
    const recMime = mediaRecorder.mimeType || mime || "audio/webm";
    const ext = mimeToExt(recMime);
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const filename = `${filenamePrefix}-${ts}.${ext}`;
    const recordedBlob = new Blob(audioChunks, { type: recMime });

    await audioCtx.close().catch(() => {});

    try {
      let record: { blob_id: string; blake3: string; size: number; mime: string };
      if (isTauriMode()) {
        const buffer = await recordedBlob.arrayBuffer();
        const base64Data = await base64Encode(buffer);
        const response = (await dispatch("blob_insert", {
          filename,
          mime: recMime,
          data: base64Data,
        })) as { blake3: string; filename: string | null; mime: string | null; size: number };
        record = {
          blob_id: response.blake3,
          blake3: response.blake3,
          size: response.size,
          mime: response.mime || recMime,
        };
      } else {
        const file = new File([recordedBlob], filename, { type: recMime });
        const fileRecord = await storeBlobFromFile(file, { metadata: { domain: "audio" } });
        record = {
          blob_id: fileRecord.blob_id,
          blake3: fileRecord.blake3 || fileRecord.blob_id,
          size: fileRecord.size,
          mime: fileRecord.mime,
        };
      }

      let waveformSamples: number[];
      if (liveSamples.length > maxWaveformSamples) {
        const step = liveSamples.length / maxWaveformSamples;
        waveformSamples = Array.from(
          { length: maxWaveformSamples },
          (_, i) => liveSamples[Math.floor(i * step)]
        );
      } else {
        waveformSamples = [...liveSamples];
      }

      onFinish?.({
        blobId: record.blob_id,
        blake3: record.blake3,
        mime: record.mime,
        size: record.size,
        filename,
        duration: durationSecs,
        waveformSamples,
      });
    } catch (err) {
      onStoreError?.(err);
    }
  };

  mediaRecorder.onstart = () => {
    startWaveSampling();
    onStart?.();
  };
  mediaRecorder.onstop = () => {
    const durationSecs = (Date.now() - recStartTime) / 1000;
    void finish(durationSecs);
  };
  mediaRecorder.start(100);

  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      mediaRecorder.stop();
      stopTracks();
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      stopWaveSampling();
      mediaRecorder.onstop = null;
      try {
        mediaRecorder.stop();
      } catch {
        // already inactive
      }
      stopTracks();
      void audioCtx.close().catch(() => {});
    },
  };
}

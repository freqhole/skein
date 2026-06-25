// audio-recording widget — capture and play back audio from the system microphone.
//
// architecture:
//   container (root, eventMode=static)
//     bgGfx    — background fill + border
//     waveGfx  — waveform visualization (live during recording, static after)
//     micGfx   — microphone icon (idle state only)
//     btnGfx   — primary action button (record / stop / play / pause)
//     statusText — timer / state label
//     infoText   — duration + file size after recording
//     errorText  — permission-denied message
//
// state machine:
//   idle → requesting → recording → processing → ready ↔ playing
//   any error → error → (click) → requesting → ...
//
// storage:
//   storeBlobFromFile() via blob worker writes OPFS bytes + IndexedDB metadata.
//   immediate post-record playback uses URL.createObjectURL() on the in-memory blob.
//   restore-from-doc playback uses getBlobData() which reads OPFS first, then
//   falls back to the rust-side blob_get dispatch in tauri mode.
//   waveformSamples are stored in the Automerge doc so collaborators can see
//   the waveform without playing the audio.
//
// device selection:
//   selected deviceId persisted.
//   device labels are only available after mic permission is granted; we
//   re-enumerate after the first successful getUserMedia call.
//   device picker is in the property tray (widgetActions), not the header bar.

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { z } from "zod";
import { getBlobData, storeBlobFromFile } from "../src/storage/skein-blob-store";
import {
  isTransparent,
  type CompactInfo,
  type HeaderAction,
  type WidgetAction,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../src/widgets/widget-types";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export const audioRecordingSchema = z.object({
  /** sha256 blob ID of the recorded audio; empty = no recording */
  blobId: z.string().default(""),
  /** original filename */
  filename: z.string().default(""),
  /** MIME type of the recorded audio */
  mime: z.string().default("audio/webm"),
  /** file size in bytes */
  size: z.number().default(0),
  /** recording duration in seconds */
  duration: z.number().default(0),
  /** widget background color; -1 = transparent */
  bgColor: z.number().default(0x1e1e2e),
  /** border color; -1 = transparent (no border) */
  borderColor: z.number().default(-1),
  /** border width in pixels; 0 = no border */
  borderWidth: z.number().default(0),
  /**
   * downsampled amplitude envelope (0–1 per sample) stored after recording.
   * lets collaborators see the waveform shape without needing the audio file.
   */
  waveformSamples: z.array(z.number()).default([]),
  /**
   * preferred audio input device label (human-readable).
   * stored in the doc so the widget remembers the chosen device.
   * empty string = system default. matched against enumerateDevices() labels;
   * if the label isn\'t found on this machine, recording falls back to default.
   */
  deviceLabel: z.string().default(""),
});

export type AudioRecordingState = z.infer<typeof audioRecordingSchema>;

// ---------------------------------------------------------------------------
// colors
// ---------------------------------------------------------------------------

const COLOR_RECORD = 0xef4444; // red — record button / live waveform
const COLOR_RECORD_DIM = 0x7f1d1d; // dimmed red — requesting state
const COLOR_PRIMARY = 0xd946ef; // magenta — ready state, play button, waveform
const COLOR_PLAY = 0xa21caf; // deep magenta — played-progress bars during playback
const COLOR_MUTED = 0x334155; // slate — processing / disabled
const COLOR_TEXT = 0xf8fafc; // near-white — status text
const COLOR_MUTED_TEXT = 0x94a3b8; // slate-400 — info / secondary text
const COLOR_ERROR = 0xf87171; // red-400 — error message

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fmtDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// ---------------------------------------------------------------------------
// widget
// ---------------------------------------------------------------------------

type RecordState =
  | "idle" // no recording; large record button
  | "requesting" // waiting for getUserMedia permission
  | "recording" // recording in progress
  | "processing" // finalizing + storing blob
  | "ready" // has a recording; play button shown
  | "playing" // playing back the recording
  | "error"; // getUserMedia or storage failure

export const audioRecordingWidget: WidgetFactory<typeof audioRecordingSchema> = {
  type: "audio-recording",
  metadata: {
    name: "audio recording",
    description: "Record audio from your microphone",
    version: "0.1.0",
    category: "media",
    defaultWidth: 320,
    defaultHeight: 160,
  },
  schema: audioRecordingSchema,
  editableProps: [
    { key: "bgColor", label: "background", type: "color" as const, default: 0x1e1e2e },
    { key: "borderColor", label: "border", type: "color" as const, default: -1 },
    { key: "borderWidth", label: "border width", type: "number" as const, min: 0, default: 0 },
  ],

  getCompactInfo: (state: AudioRecordingState): CompactInfo => ({
    label: state.filename ? state.filename.replace(/\.[^.]+$/, "") : "audio recording",
    domain: "audio",
    blobId: state.blobId || undefined,
    mime: state.mime || undefined,
    filename: state.filename || undefined,
    size: state.size || undefined,
  }),

  create(ctx: WidgetMountContext<typeof audioRecordingSchema>): WidgetController {
    let cw = ctx.width;
    let ch = ctx.height;

    // ── transient recording state ────────────────────────────────────────────
    let recState: RecordState = ctx.doc.current.blobId ? "ready" : "idle";
    let mediaRecorder: MediaRecorder | null = null;
    let mediaStream: MediaStream | null = null;
    let audioChunks: Blob[] = [];
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let recStartTime = 0;
    let elapsedSecs = 0;
    /** amplitude samples (0–1) collected during recording */
    let liveSamples: number[] = [];
    /**
     * amplitude snapshot for display — loaded from doc on mount (if present)
     * and written back to doc after recording.
     */
    let capturedSamples: number[] = [...(ctx.doc.current.waveformSamples ?? [])];
    let waveRafId: number | null = null;

    // ── transient playback state ─────────────────────────────────────────────
    let audioEl: HTMLAudioElement | null = null;
    /** object URL for the most recently stored/loaded blob */
    let playbackUrl: string | null = null;
    let playbackElapsed = 0;
    let playRafId: number | null = null;

    // ── device selection state ───────────────────────────────────────────────
    // cachedDevices is populated by enumerateDevices() — labels are empty until
    // microphone permission is granted, so we re-enumerate after the first
    // successful getUserMedia call.
    let cachedDevices: MediaDeviceInfo[] = [];

    const enumerateDevices = async (): Promise<void> => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        cachedDevices = all.filter((d) => d.kind === "audioinput");
      } catch {
        // enumerateDevices may be unavailable without a secure context
      }
    };

    // build the options list for the device select prop.
    // called fresh each time the property tray opens the dropdown.
    const DEVICE_DEFAULT = "System default";
    const deviceOptions = (): string[] => [
      DEVICE_DEFAULT,
      ...cachedDevices.map((d) => d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`),
    ];

    // resolve the deviceId to use for getUserMedia from the stored label.
    // treats both empty string (legacy) and "System default" as no constraint.
    const resolveDeviceId = (): string | undefined => {
      const label = ctx.doc.current.deviceLabel;
      if (!label || label === DEVICE_DEFAULT) return undefined;
      return cachedDevices.find((d) => d.label === label)?.deviceId;
    };

    void enumerateDevices();

    // ── pixi containers ──────────────────────────────────────────────────────
    const container = new Container();
    container.eventMode = "static";

    const bgGfx = new Graphics();
    bgGfx.eventMode = "static";
    bgGfx.hitArea = new Rectangle(0, 0, cw, ch);
    container.addChild(bgGfx);

    const waveGfx = new Graphics();
    waveGfx.eventMode = "none";
    container.addChild(waveGfx);

    const micGfx = new Graphics();
    micGfx.eventMode = "none";
    container.addChild(micGfx);

    const btnGfx = new Graphics();
    btnGfx.eventMode = "static";
    btnGfx.cursor = "pointer";
    container.addChild(btnGfx);

    const statusText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        fill: COLOR_TEXT,
        align: "center",
      },
      resolution: 2,
    });
    statusText.eventMode = "none";
    statusText.anchor.set(0.5, 0);
    container.addChild(statusText);

    const infoText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 11,
        fill: COLOR_MUTED_TEXT,
        align: "center",
      },
      resolution: 2,
    });
    infoText.eventMode = "none";
    infoText.anchor.set(0.5, 0);
    container.addChild(infoText);

    const errorText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 12,
        fill: COLOR_ERROR,
        align: "center",
        wordWrap: true,
        wordWrapWidth: cw - 32,
      },
      resolution: 2,
    });
    errorText.eventMode = "none";
    errorText.anchor.set(0.5, 0.5);
    container.addChild(errorText);

    // ── layout constants ─────────────────────────────────────────────────────
    const BTN_R = 26;
    const BTN_BOT = 14;
    const STAT_TOP = 12;
    const INFO_TOP = 28;

    // ── drawing helpers ──────────────────────────────────────────────────────
    const drawBg = () => {
      const { bgColor, borderColor, borderWidth } = ctx.doc.current;
      bgGfx.clear();

      if (!isTransparent(bgColor)) {
        bgGfx.rect(0, 0, cw, ch);
        bgGfx.fill({ color: bgColor });
      }

      const bw = borderWidth ?? 0;
      if (bw > 0 && !isTransparent(borderColor ?? -1)) {
        bgGfx.rect(0, 0, cw, ch);
        bgGfx.stroke({ color: borderColor, width: bw });
      }

      bgGfx.hitArea = new Rectangle(0, 0, cw, ch);
    };

    const drawMic = (visible: boolean) => {
      micGfx.clear();
      if (!visible) return;
      const cx = cw / 2;
      const cy = ch / 2 - 10;
      const mw = 14;
      const mh = 22;
      const r = mw / 2;
      micGfx.roundRect(cx - mw / 2, cy - mh / 2, mw, mh, r);
      micGfx.fill({ color: COLOR_PRIMARY, alpha: 0.35 });
      micGfx.rect(cx - 1, cy + mh / 2, 2, 8);
      micGfx.fill({ color: COLOR_MUTED_TEXT, alpha: 0.4 });
      micGfx.rect(cx - 8, cy + mh / 2 + 7, 16, 2);
      micGfx.fill({ color: COLOR_MUTED_TEXT, alpha: 0.4 });
    };

    const btnCY = () => ch - BTN_R - BTN_BOT;

    const drawBtn = () => {
      btnGfx.clear();
      const bx = cw / 2;
      const by = btnCY();

      switch (recState) {
        case "idle":
          btnGfx.circle(bx, by, BTN_R);
          btnGfx.fill({ color: COLOR_RECORD });
          btnGfx.circle(bx, by, BTN_R * 0.42);
          btnGfx.fill({ color: 0xffffff, alpha: 0.88 });
          break;

        case "requesting":
          btnGfx.circle(bx, by, BTN_R);
          btnGfx.fill({ color: COLOR_RECORD_DIM });
          break;

        case "recording": {
          btnGfx.circle(bx, by, BTN_R);
          btnGfx.fill({ color: COLOR_RECORD });
          const sq = BTN_R * 0.4;
          btnGfx.rect(bx - sq, by - sq, sq * 2, sq * 2);
          btnGfx.fill({ color: 0xffffff, alpha: 0.88 });
          break;
        }

        case "processing":
          btnGfx.circle(bx, by, BTN_R);
          btnGfx.fill({ color: COLOR_MUTED });
          break;

        case "ready": {
          btnGfx.circle(bx, by, BTN_R);
          btnGfx.fill({ color: COLOR_PRIMARY });
          const ox = 3;
          btnGfx.moveTo(bx - BTN_R * 0.3 + ox, by - BTN_R * 0.44);
          btnGfx.lineTo(bx + BTN_R * 0.5 + ox, by);
          btnGfx.lineTo(bx - BTN_R * 0.3 + ox, by + BTN_R * 0.44);
          btnGfx.closePath();
          btnGfx.fill({ color: 0xffffff, alpha: 0.9 });
          break;
        }

        case "playing": {
          btnGfx.circle(bx, by, BTN_R);
          btnGfx.fill({ color: COLOR_PLAY });
          const bw = 5;
          const bh = BTN_R * 0.72;
          btnGfx.rect(bx - bw - 3, by - bh / 2, bw, bh);
          btnGfx.fill({ color: 0xffffff, alpha: 0.9 });
          btnGfx.rect(bx + 3, by - bh / 2, bw, bh);
          btnGfx.fill({ color: 0xffffff, alpha: 0.9 });
          break;
        }

        case "error":
          btnGfx.circle(bx, by, BTN_R);
          btnGfx.fill({ color: COLOR_MUTED });
          btnGfx.circle(bx, by, BTN_R * 0.38);
          btnGfx.stroke({ color: 0xffffff, width: 2, alpha: 0.6 });
          break;
      }

      btnGfx.hitArea = new Rectangle(bx - BTN_R, by - BTN_R, BTN_R * 2, BTN_R * 2);
    };

    const drawWave = (samples: number[], progress?: number) => {
      waveGfx.clear();

      const waveTop = STAT_TOP + 26;
      const waveBot = btnCY() - BTN_R - 8;
      const waveH = waveBot - waveTop;
      if (waveH < 6) return;

      const cx = waveTop + waveH / 2;
      const barCount = 50;
      const totalW = cw - 32;
      const gap = totalW / barCount;
      const barW = Math.max(1.5, gap - 1.5);

      if (samples.length === 0) {
        const flatColor = recState === "recording" ? COLOR_RECORD : COLOR_PRIMARY;
        waveGfx.rect(16, cx - 1, totalW, 2);
        waveGfx.fill({ color: flatColor, alpha: 0.25 });
        return;
      }

      for (let i = 0; i < barCount; i++) {
        const srcIdx = Math.floor((i / barCount) * samples.length);
        const amp = Math.max(0.04, samples[srcIdx] ?? 0.04);
        const barH = Math.max(2, amp * waveH);
        const x = 16 + i * gap;
        const y = cx - barH / 2;

        let color: number;
        let alpha: number;

        if (progress !== undefined) {
          const played = i / barCount < progress;
          color = played ? COLOR_PLAY : COLOR_PRIMARY;
          alpha = played ? 0.9 : 0.35;
        } else if (recState === "recording") {
          color = COLOR_RECORD;
          alpha = 0.6 + amp * 0.4;
        } else {
          color = COLOR_PRIMARY;
          alpha = 0.5 + amp * 0.45;
        }

        waveGfx.roundRect(x, y, barW, barH, 1.5);
        waveGfx.fill({ color, alpha });
      }
    };

    const updateTexts = () => {
      const state = ctx.doc.current;
      drawMic(recState === "idle");

      switch (recState) {
        case "idle":
          statusText.text = "tap to record";
          infoText.text = "";
          errorText.text = "";
          break;
        case "requesting":
          statusText.text = "requesting mic…";
          infoText.text = "";
          errorText.text = "";
          break;
        case "recording":
          statusText.text = `● REC  ${fmtDuration(elapsedSecs)}`;
          infoText.text = "";
          errorText.text = "";
          break;
        case "processing":
          statusText.text = "saving…";
          infoText.text = "";
          errorText.text = "";
          break;
        case "ready":
          statusText.text = fmtDuration(state.duration);
          infoText.text = fmtBytes(state.size);
          errorText.text = "";
          break;
        case "playing":
          statusText.text = `${fmtDuration(playbackElapsed)} / ${fmtDuration(state.duration)}`;
          infoText.text = "";
          errorText.text = "";
          break;
        case "error":
          statusText.text = "";
          infoText.text = "";
          errorText.text = "mic access denied\ntap to try again";
          break;
      }
    };

    const layout = () => {
      statusText.x = cw / 2;
      statusText.y = STAT_TOP;

      infoText.x = cw / 2;
      infoText.y = INFO_TOP;

      errorText.x = cw / 2;
      errorText.y = ch / 2 - BTN_R - 10;
      (errorText.style as any).wordWrapWidth = cw - 32;
    };

    const refresh = () => {
      drawBg();
      layout();
      updateTexts();
      drawBtn();

      const samples =
        recState === "recording"
          ? liveSamples
          : recState === "ready" || recState === "playing"
            ? capturedSamples
            : [];

      const progress =
        recState === "playing"
          ? playbackElapsed / Math.max(0.001, ctx.doc.current.duration)
          : undefined;

      drawWave(samples, progress);
    };

    refresh();

    // ── waveform animation during recording ──────────────────────────────────
    const startWaveAnim = () => {
      if (!analyser) return;
      const bufLen = analyser.frequencyBinCount;
      const dataArr = new Uint8Array(bufLen);
      let frameCount = 0;

      const tick = () => {
        if (recState !== "recording") return;
        waveRafId = requestAnimationFrame(tick);
        analyser!.getByteTimeDomainData(dataArr);

        let sum = 0;
        for (let i = 0; i < bufLen; i++) {
          const v = (dataArr[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / bufLen);

        frameCount++;
        if (frameCount % 4 === 0) liveSamples.push(rms);

        elapsedSecs = (Date.now() - recStartTime) / 1000;
        updateTexts();
        drawWave(liveSamples);
      };
      waveRafId = requestAnimationFrame(tick);
    };

    const stopWaveAnim = () => {
      if (waveRafId !== null) {
        cancelAnimationFrame(waveRafId);
        waveRafId = null;
      }
    };

    // ── playback animation ───────────────────────────────────────────────────
    const startPlayAnim = () => {
      const dur = Math.max(0.001, ctx.doc.current.duration);
      const tick = () => {
        if (recState !== "playing" || !audioEl) return;
        playRafId = requestAnimationFrame(tick);
        playbackElapsed = audioEl.currentTime;
        updateTexts();
        drawWave(capturedSamples, playbackElapsed / dur);
      };
      playRafId = requestAnimationFrame(tick);
    };

    const stopPlayAnim = () => {
      if (playRafId !== null) {
        cancelAnimationFrame(playRafId);
        playRafId = null;
      }
    };

    // ── recording logic ──────────────────────────────────────────────────────
    const startRecording = async () => {
      if (recState === "requesting" || recState === "recording") return;
      recState = "requesting";
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());

      let stream: MediaStream;
      const deviceId = resolveDeviceId();
      const audioConstraints: boolean | MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : true;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
      } catch {
        recState = "error";
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        return;
      }

      mediaStream = stream;
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      audioCtx.createMediaStreamSource(stream).connect(analyser);

      const mime = pickMimeType();
      audioChunks = [];
      liveSamples = [];
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstart = () => {
        recState = "recording";
        recStartTime = Date.now();
        elapsedSecs = 0;
        startWaveAnim();
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        // re-enumerate now that permission is granted — labels will be populated
        void enumerateDevices();
      };
      mediaRecorder.onstop = () => void finishRecording();
      mediaRecorder.start(100);
    };

    const stopRecording = () => {
      if (recState !== "recording") return;
      stopWaveAnim();
      elapsedSecs = (Date.now() - recStartTime) / 1000;
      recState = "processing";
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
      mediaRecorder?.stop();
      mediaStream?.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    };

    const finishRecording = async () => {
      const durationSecs = elapsedSecs;
      const recMime = mediaRecorder?.mimeType ?? "audio/webm";
      const ext = mimeToExt(recMime);
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const filename = `recording-${ts}.${ext}`;

      const recordedBlob = new Blob(audioChunks, { type: recMime });

      audioChunks = [];
      capturedSamples = [...liveSamples];
      liveSamples = [];

      await audioCtx?.close();
      audioCtx = null;
      analyser = null;

      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
      playbackUrl = URL.createObjectURL(recordedBlob);

      try {
        const file = new File([recordedBlob], filename, { type: recMime });
        const record = await storeBlobFromFile(file, "audio");

        ctx.doc.change((d) => {
          d.blobId = record.blob_id;
          d.filename = filename;
          d.mime = recMime;
          d.size = record.size;
          d.duration = durationSecs;
          // persist waveform — downsample to ≤200 points to keep doc size small
          const MAX_SAMPLES = 200;
          if (capturedSamples.length > MAX_SAMPLES) {
            const step = capturedSamples.length / MAX_SAMPLES;
            d.waveformSamples = Array.from(
              { length: MAX_SAMPLES },
              (_, i) => capturedSamples[Math.floor(i * step)]
            );
          } else {
            d.waveformSamples = [...capturedSamples];
          }
        });

        recState = "ready";
      } catch (err) {
        console.error("[audio-recording] failed to store blob:", err);
        recState = "error";
      }

      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    // ── playback logic ───────────────────────────────────────────────────────
    const getPlaybackUrl = async (): Promise<string | null> => {
      if (playbackUrl) return playbackUrl;

      const { blobId, mime } = ctx.doc.current;
      if (!blobId) return null;

      try {
        const buffer = await getBlobData(blobId);
        if (buffer) {
          const blob = new Blob([buffer], { type: mime || "audio/webm" });
          playbackUrl = URL.createObjectURL(blob);
          return playbackUrl;
        }
      } catch (err) {
        console.error("[audio-recording] getPlaybackUrl failed:", err);
      }
      return null;
    };

    const startPlayback = async () => {
      const url = await getPlaybackUrl();
      if (!url) {
        console.error("[audio-recording] no playback URL available");
        return;
      }

      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.onended = () => {
          recState = "ready";
          playbackElapsed = 0;
          stopPlayAnim();
          refresh();
          ctx.setHeaderActions?.(makeHeaderActions());
        };
      }

      if (audioEl.src !== url) audioEl.src = url;

      try {
        await audioEl.play();
      } catch (err) {
        console.error("[audio-recording] play() failed:", err);
        return;
      }

      recState = "playing";
      playbackElapsed = audioEl.currentTime;
      startPlayAnim();
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    const pausePlayback = () => {
      audioEl?.pause();
      recState = "ready";
      stopPlayAnim();
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    const deleteRecording = () => {
      if (recState === "playing") {
        audioEl?.pause();
        stopPlayAnim();
      }
      if (audioEl) {
        audioEl.src = "";
        audioEl = null;
      }
      if (playbackUrl) {
        URL.revokeObjectURL(playbackUrl);
        playbackUrl = null;
      }
      capturedSamples = [];
      playbackElapsed = 0;
      recState = "idle";

      ctx.doc.change((d) => {
        d.blobId = "";
        d.filename = "";
        d.size = 0;
        d.duration = 0;
        d.waveformSamples = [];
      });

      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    // ── button click handler ─────────────────────────────────────────────────
    btnGfx.on("pointerup", () => {
      switch (recState) {
        case "idle":
        case "error":
          void startRecording();
          break;
        case "recording":
          stopRecording();
          break;
        case "ready":
          void startPlayback();
          break;
        case "playing":
          pausePlayback();
          break;
      }
    });

    // ── header actions — only ■ stop while recording ─────────────────────────
    const makeHeaderActions = (): HeaderAction[] => {
      if (recState === "recording") {
        return [
          {
            id: "stop",
            label: "■ stop",
            active: true,
            onClick: stopRecording,
          },
        ];
      }
      return [];
    };

    // ── doc subscription ─────────────────────────────────────────────────────
    const unsub = ctx.doc.on("change", () => {
      const { blobId, waveformSamples } = ctx.doc.current;

      // sync capturedSamples from doc (collaborative update)
      if (waveformSamples && waveformSamples.length > 0 && capturedSamples.length === 0) {
        capturedSamples = [...waveformSamples];
      }

      if ((recState === "idle" || recState === "error") && blobId) {
        capturedSamples = [...(ctx.doc.current.waveformSamples ?? [])];
        recState = "ready";
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        return;
      }

      if ((recState === "ready" || recState === "playing") && !blobId) {
        if (recState === "playing") {
          audioEl?.pause();
          stopPlayAnim();
        }
        capturedSamples = [];
        playbackElapsed = 0;
        recState = "idle";
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        return;
      }

      // bgColor / border / other prop change
      drawBg();
    });

    // ── widget actions (property tray) ───────────────────────────────────────
    const widgetActions: WidgetAction[] = [
      {
        id: "delete-recording",
        label: "delete recording",
        onClick: deleteRecording,
      },
    ];

    return {
      container,
      headerActions: makeHeaderActions(),
      widgetActions,
      editableProps: [
        { key: "bgColor", label: "background", type: "color" as const, default: 0x1e1e2e },
        { key: "borderColor", label: "border", type: "color" as const, default: -1 },
        { key: "borderWidth", label: "border width", type: "number" as const, min: 0, default: 0 },
        {
          key: "deviceLabel",
          label: "input device",
          type: "select" as const,
          options: deviceOptions,
          default: DEVICE_DEFAULT,
        },
      ],
      destroy() {
        stopWaveAnim();
        stopPlayAnim();
        mediaRecorder?.stop();
        mediaStream?.getTracks().forEach((t) => t.stop());
        void audioCtx?.close();
        if (audioEl) {
          audioEl.pause();
          audioEl.src = "";
          audioEl = null;
        }
        if (playbackUrl) {
          URL.revokeObjectURL(playbackUrl);
          playbackUrl = null;
        }
        unsub();
        container.destroy({ children: true });
      },
      resize(w, h) {
        cw = w;
        ch = h;
        bgGfx.hitArea = new Rectangle(0, 0, cw, ch);
        refresh();
      },
    };
  },
};

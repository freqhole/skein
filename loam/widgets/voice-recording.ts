// voice-recording widget — capture and play back audio with an animated procedural mouth.
//
// architecture:
//   container (root, eventMode=static)
//     bgGfx          — background fill + border
//     mouthContainer — tappable area (tap-to-play after recording)
//       (MouthRenderer draws its Graphics inside mouthContainer)
//     btnGfx         — record pill / stop pill + pulsing dot (hidden after first recording)
//     btnLabel       — text label on the pill button
//     statusText     — "downloading…" / error message
//
// state machine (identical to audio-recording):
//   idle → requesting → recording → processing → ready ↔ playing
//   ready → fetching → ready  (remote peer: snatching blob before playback)
//   any error → error → (tap record) → requesting → ...
//
// animation loop lifecycle:
//   recording  (mouthRafId)    — runs while recState === "recording"; reads mic AnalyserNode RMS
//   playing    (playRafId)     — runs while recState === "playing"; reads playback AnalyserNode RMS
//   at rest (idle/ready/error) — the mouth stays still; no animation runs.
//
// storage mirrors audio-recording exactly (same tauri/browser branches, same snatchedBy flow).
// reused exports from audio-recording: resolveAudioBytes, addSnatcher, AudioBlobRef, ResolvedAudioBytes.
// replicated (private in audio-recording): pickMimeType, mimeToExt, RecordState, device picker logic.

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { z } from "zod";
import type { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import { isTauriMode, dispatch } from "../src/p2p/tauri-transport";
import { storeBlobFromFile } from "../src/storage/blob-store";
import { base64Encode } from "@freqhole/reliquary/worker";
import { snatchBlob, BlobAccessDeniedError } from "../src/file-utils/snatch";
import { checkBlobLocality } from "../src/file-utils/blob-locality";
import { getLocalNodeId, type PeersMap } from "../src/file-utils/file-shared";
import { getLocalAccentColor, sendFriendRequest } from "../src/p2p/friendz-bridge";
import { registerPendingBlobRetry } from "../src/p2p/pending-blob-access";
import { resolveDocReadyCached } from "../src/p2p/doc-ready";
import { deepUnwrapAmStrings } from "../src/canvas/automerge-values";
import type { WidgetRegistry } from "../src/widgets/widget-registry";
import {
  isTransparent,
  type CompactInfo,
  type DropTargetHandler,
  type HeaderAction,
  type WidgetAction,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../src/widgets/widget-types";
import {
  addSnatcher,
  getAudioBlobData,
  resolveAudioBytes,
  type AudioBlobRef,
  type ResolvedAudioBytes,
} from "./audio-recording";
import {
  MouthRenderer,
  volumeToRawOpenness,
  computeRmsEnvelope,
  renderMouthSnapshot,
  ENVELOPE_HZ,
  type Mood,
  type TeethStyle,
} from "./voice-recording-mouth";

// re-export pure helpers so tests can import from a single module
export { darkenHex, volumeToRawOpenness, smoothLerp } from "./voice-recording-mouth";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export const voiceRecordingSchema = z.object({
  /** sha256 blob ID of the recorded audio; empty = no recording yet */
  blobId: z.string().default(""),
  /** original filename */
  filename: z.string().default(""),
  /** MIME type of the recorded audio */
  mime: z.string().default("audio/webm"),
  /** file size in bytes */
  size: z.number().default(0),
  /** blake3 content hash (needed for verified P2P snatch) */
  blake3: z.string().default(""),
  /** node IDs that have snatched (or recorded) this blob */
  snatchedBy: z.array(z.string()).default([]),
  /** recording duration in seconds */
  duration: z.number().default(0),
  /** widget background color; -1 = transparent */
  bgColor: z.number().default(-1),
  /** border color; -1 = transparent */
  borderColor: z.number().default(-1),
  /** border width in pixels; 0 = no border */
  borderWidth: z.number().default(0),
  /** preferred audio input device label (empty = system default) */
  deviceLabel: z.string().default(""),
  /** lip fill color — doc-synced so all peers see the chosen shade */
  lipsColor: z.number().default(0xc2455a),
  /** lip thickness, 1 (thin) .. 10 (plump). scales the lip band height. */
  lipThickness: z.number().default(5),
  /** resting/animating mouth curvature: frown, neutral (default), or smile */
  mouthMood: z.enum(["frown", "neutral", "smile"]).default("neutral"),
  /** teeth row shape: a flat row (default) or one that hugs the mood curve */
  teethStyle: z.enum(["straight", "curved"]).default("straight"),
  /** cupid's bow prominence on the top lip, 0 (plain arc) .. 10 (fully pronounced) */
  cupidBowAmount: z.number().default(4),
  /** true once lipsColor/lipThickness have been randomized on first mount —
   *  prevents re-randomizing on every later mount/reconnect */
  lipsSeeded: z.boolean().default(false),
  /** static "resting face" snapshot of the mouth, used as the bin compact
   *  card thumbnail (no live animation there) */
  mouthSnapshotDataUrl: z.string().default(""),
  /** lipsColor|lipThickness|mouthMood|teethStyle|cupidBowAmount|bgColor|
   *  borderColor|borderWidth the snapshot above was rendered from — lets any
   *  peer detect a stale snapshot and regenerate it, without every peer
   *  re-rendering on every doc change */
  mouthSnapshotKey: z.string().default(""),
});

export type VoiceRecordingState = z.infer<typeof voiceRecordingSchema>;

// ---------------------------------------------------------------------------
// colors
// ---------------------------------------------------------------------------

const COLOR_RECORD = 0xef4444;
const COLOR_RECORD_DIM = 0x7f1d1d;
const COLOR_MUTED = 0x334155;
const COLOR_PILL_TEXT = 0xffffff;
const COLOR_STATUS = 0x94a3b8;
const COLOR_ERROR = 0xf87171;

// ---------------------------------------------------------------------------
// private helpers (replicated from audio-recording — those are module-private there)
// ---------------------------------------------------------------------------

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
      // ignore — may throw in some environments
    }
  }
  return "";
}

function mimeToExt(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return "webm";
}

/** pick a random vivid lip color — fallback for when the user's social
 *  identity profile accent color isn't available yet (see
 *  `defaultLipColor()`). mirrors doodle.ts's randomDoodleColor approach. */
function randomLipColor(): number {
  const palette = [
    0xc2455a, 0xdb2777, 0xe11d48, 0xf43f5e, 0xec4899, 0xd946ef, 0xef4444, 0xf97316, 0xfb7185,
    0xbe185d, 0x9d174d, 0xa21caf, 0xc026d3, 0xe879f9, 0xfb923c,
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

/** default a new widget's lip color to the user's own social identity
 *  profile accent color (profile-tab.ts's palette picker) — falls back to
 *  a random vivid color only if the social doc isn't registered yet (e.g.
 *  no identity set up). */
function defaultLipColor(): number {
  return getLocalAccentColor() ?? randomLipColor();
}

/** pick a random lip thickness (1..10) on init */
function randomLipThickness(): number {
  return 1 + Math.floor(Math.random() * 10);
}

// ---------------------------------------------------------------------------
// widget
// ---------------------------------------------------------------------------

type RecordState =
  | "idle"
  | "requesting"
  | "recording"
  | "processing"
  | "ready"
  | "fetching"
  | "playing"
  | "error"
  | "needs-friend" // only non-friend peers have the blob; tap to send a friend request
  | "friend-requested"; // friend request sent; waiting to retry the fetch

export const voiceRecordingWidget: WidgetFactory<typeof voiceRecordingSchema> = {
  type: "voice-recording",
  metadata: {
    name: "voice recording",
    description: "Record audio with an animated mouth that talks",
    version: "0.1.0",
    category: "media",
    defaultWidth: 280,
    defaultHeight: 200,
  },
  schema: voiceRecordingSchema,
  editableProps: [
    { key: "bgColor", label: "background", type: "color" as const, default: -1 },
    { key: "borderColor", label: "border", type: "color" as const, default: -1 },
    { key: "borderWidth", label: "border width", type: "number" as const, min: 0, default: 0 },
    { key: "lipsColor", label: "lips color", type: "color" as const, default: 0xc2455a },
  ],

  getCompactInfo: (state: VoiceRecordingState): CompactInfo => ({
    label: state.filename ? state.filename.replace(/\.[^.]+$/, "") : "voice recording",
    domain: "audio",
    thumbnailUrl: state.mouthSnapshotDataUrl || undefined,
    blobId: state.blobId || undefined,
    mime: state.mime || undefined,
    filename: state.filename || undefined,
    blake3: state.blake3 || undefined,
    size: state.size || undefined,
    snatchedBy: state.snatchedBy?.length ? state.snatchedBy.map(String) : undefined,
  }),

  create(ctx: WidgetMountContext<typeof voiceRecordingSchema>): WidgetController {
    let cw = ctx.width;
    let ch = ctx.height;
    let destroyed = false;

    // -- transient recording state --
    let recState: RecordState = ctx.doc.current.blobId ? "ready" : "idle";
    let mediaRecorder: MediaRecorder | null = null;
    let mediaStream: MediaStream | null = null;
    let audioChunks: Blob[] = [];
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let recStartTime = 0;

    // only the peer who created this widget can use the initial "record"
    // step — widgets with no recorded creator (pre-existing widgets from
    // before this field existed) are unrestricted.
    const iAmCreator = !ctx.canvasStore || ctx.canvasStore.isLocalWidgetCreator(ctx.widgetId);

    // -- cross-widget drop: drag an existing file(audio)/audio-recording
    // widget onto this one, before it has its own recording, to use that
    // audio for the mouth animation instead of recording fresh — see
    // `dropTarget` below, mirrors animaniac/drop-controller.ts's mechanics.
    const store = ctx.canvasStore ?? null;
    const repo: Repo | null = store?.repo ?? null;
    const registry: WidgetRegistry | null = _voiceRecordingWidgetRegistry;

    // -- transient playback state --
    let audioEl: HTMLAudioElement | null = null;
    // separate AudioContext for playback so the mic context can be closed after recording
    // precomputed playback rms envelope (ENVELOPE_HZ samples per second of
    // audio) + the url it was computed for, for cache invalidation, and the
    // raw bytes it decodes from
    let playbackEnvelope: Float32Array | null = null;
    let playbackEnvelopeUrl: string | null = null;
    let playbackBytes: Blob | null = null;
    let playbackUrl: string | null = null;
    let fetchProgressText = "downloading…";
    let fetchErrorMessage = "";
    /** the peer known to have the blob but not (yet) a friend — see the
     *  "needs-friend"/"friend-requested" states below. */
    let deniedPeerNodeId: string | null = null;
    /** unregisters the pending-retry-on-friend-accept hook (see
     *  requestFriendAndRetry()); called on destroy() so it never fires
     *  against a torn-down widget. */
    let unregisterPendingRetry: (() => void) | null = null;

    // -- animation frame IDs --
    let mouthRafId: number | null = null;
    let playRafId: number | null = null;

    // -- mouth openness smooth value --
    let smoothOpenness = 0;
    // alpha for the pulsing red dot during recording
    let dotPulse = 1;

    // -- device selection --
    let cachedDevices: MediaDeviceInfo[] = [];

    const enumerateDevices = async (): Promise<void> => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        cachedDevices = all.filter((d) => d.kind === "audioinput");
      } catch {
        // enumerateDevices may be unavailable without a secure context
      }
    };

    const DEVICE_DEFAULT = "System default";

    const deviceOptions = (): string[] => [
      DEVICE_DEFAULT,
      ...cachedDevices.map((d) => d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`),
    ];

    const resolveDeviceId = (): string | undefined => {
      const label = ctx.doc.current.deviceLabel;
      if (!label || label === DEVICE_DEFAULT) return undefined;
      return cachedDevices.find((d) => d.label === label)?.deviceId;
    };

    void enumerateDevices();

    // seed lip color/thickness once, the first time this widget is ever
    // mounted — subsequent mounts (reload, reconnect) keep whatever was
    // seeded. lip color defaults to the user's own profile accent color.
    if (!ctx.doc.current.lipsSeeded) {
      ctx.doc.change((d) => {
        d.lipsColor = defaultLipColor();
        d.lipThickness = randomLipThickness();
        d.lipsSeeded = true;
      });
    }

    // -- pixi containers --
    const container = new Container();
    container.eventMode = "static";

    const bgGfx = new Graphics();
    bgGfx.eventMode = "none";
    container.addChild(bgGfx);

    // mouthContainer covers the full widget bounds and is the tap-to-play target
    const mouthContainer = new Container();
    mouthContainer.eventMode = "static";
    container.addChild(mouthContainer);

    const mouth = new MouthRenderer(
      mouthContainer,
      cw,
      ch,
      ctx.doc.current.lipsColor,
      ctx.doc.current.lipThickness,
      ctx.doc.current.mouthMood as Mood,
      ctx.doc.current.teethStyle as TeethStyle,
      ctx.doc.current.cupidBowAmount
    );

    // -- bin compact-card snapshot: a static "resting face" image, regenerated
    // whenever the mouth's appearance changes. keyed so only the first peer to
    // observe a given appearance renders + writes it back; everyone else's
    // doc-change handler sees a matching key and skips redundant work. --
    const mouthSnapshotKey = (s: VoiceRecordingState): string =>
      `${s.lipsColor}|${s.lipThickness}|${s.mouthMood}|${s.teethStyle}|${s.cupidBowAmount}|${s.bgColor}|${s.borderColor}|${s.borderWidth}`;

    const maybeRegenerateSnapshot = (): void => {
      const state = ctx.doc.current;
      const key = mouthSnapshotKey(state);
      if (state.mouthSnapshotKey === key && state.mouthSnapshotDataUrl) return;
      void renderMouthSnapshot({
        lipsColor: state.lipsColor,
        lipThickness: state.lipThickness,
        mood: state.mouthMood as Mood,
        teethStyle: state.teethStyle as TeethStyle,
        cupidBowAmount: state.cupidBowAmount,
        bgColor: state.bgColor,
        borderColor: state.borderColor,
        borderWidth: state.borderWidth,
      }).then((dataUrl) => {
        if (destroyed || !dataUrl) return;
        // bail if superseded by a newer appearance change, or another peer
        // already wrote this exact snapshot, while we were rendering
        if (mouthSnapshotKey(ctx.doc.current) !== key) return;
        if (ctx.doc.current.mouthSnapshotKey === key) return;
        ctx.doc.change((d) => {
          d.mouthSnapshotDataUrl = dataUrl;
          d.mouthSnapshotKey = key;
        });
      });
    };

    maybeRegenerateSnapshot();

    // pill button (hidden after first recording)
    const btnGfx = new Graphics();
    btnGfx.eventMode = "static";
    btnGfx.cursor = "pointer";
    container.addChild(btnGfx);

    const btnLabel = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        fontWeight: "600",
        fill: COLOR_PILL_TEXT,
        align: "center",
      },
      resolution: 2,
    });
    btnLabel.eventMode = "none";
    btnLabel.anchor.set(0.5, 0.5);
    container.addChild(btnLabel);

    // status text for fetching / error states
    const statusText = new Text({
      text: "",
      style: {
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 12,
        fill: COLOR_STATUS,
        align: "center",
        wordWrap: true,
        wordWrapWidth: cw - 32,
      },
      resolution: 2,
    });
    statusText.eventMode = "none";
    statusText.anchor.set(0.5, 0.5);
    container.addChild(statusText);

    // hover highlight while a droppable audio source is dragged over this
    // widget (see `dropTarget` below) — drawn last so it sits on top.
    const dropHighlightGfx = new Graphics();
    dropHighlightGfx.eventMode = "none";
    dropHighlightGfx.visible = false;
    container.addChild(dropHighlightGfx);
    const setDropHighlight = (active: boolean): void => {
      dropHighlightGfx.visible = active;
      if (!active) return;
      dropHighlightGfx.clear().rect(1, 1, Math.max(0, cw - 2), Math.max(0, ch - 2)).stroke({ width: 3, color: 0xd946ef });
    };

    /** a "file" widget (audio domain) or "audio-recording" widget — the
     *  only two source types this widget accepts an existing blob from. */
    const isDroppableSourceType = (entryType: string, sourceState: Record<string, unknown>): boolean =>
      entryType === "audio-recording" || (entryType === "file" && sourceState.domain === "audio");

    interface DroppedAudioSource {
      blobId: string;
      filename: string;
      mime: string;
      size: number;
      blake3: string;
      duration: number;
      snatchedBy: string[];
    }

    /** reads a dropped widget's doc via the shared registry/repo (same
     *  normalize-then-parse path animaniac's drop-controller.ts uses),
     *  falling back to `resolveDocReadyCached()`'s bounded wait for a
     *  widget whose doc handle was never opened locally yet this session
     *  (e.g. sitting untouched inside a bin) — returns null for anything
     *  not a droppable type, or with nothing recorded/uploaded yet. */
    async function readDroppedAudioSource(entryType: string, docId: string | null): Promise<DroppedAudioSource | null> {
      if (!repo || !registry || !docId) return null;
      const factory = registry.get(entryType);
      if (!factory?.schema) return null;
      let handle: DocHandle<any> | undefined = repo.handles[docId as DocumentId];
      if (!handle?.doc()) {
        handle = (await resolveDocReadyCached(repo, docId as DocumentId, { context: "voice-recording.drop" })) ?? undefined;
      }
      const rawDoc = handle?.doc();
      if (!rawDoc) return null;
      try {
        const state = factory.schema.parse(deepUnwrapAmStrings(rawDoc)) as Record<string, unknown>;
        if (!isDroppableSourceType(entryType, state) || !state.blobId) return null;
        return {
          blobId: String(state.blobId),
          filename: typeof state.filename === "string" ? state.filename : "",
          mime: typeof state.mime === "string" ? state.mime : "",
          size: typeof state.size === "number" ? state.size : 0,
          blake3: typeof state.blake3 === "string" ? state.blake3 : "",
          duration: typeof state.duration === "number" ? state.duration : 0,
          snatchedBy: Array.isArray(state.snatchedBy) ? state.snatchedBy.map(String) : [],
        };
      } catch {
        return null;
      }
    }

    // -- pill button constants --
    const PILL_W = 90;
    const PILL_H = 30;
    const PILL_R = 15;
    const PILL_BOT = 16; // distance from bottom edge to pill center
    const DOT_R = 4.5;
    const DOT_GAP = 10; // gap between dot and pill left edge

    const pillCY = (): number => ch - PILL_BOT - PILL_H / 2;

    // -- drawing helpers --
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

    const drawBtn = () => {
      btnGfx.clear();
      const hasRecording = !!ctx.doc.current.blobId;

      if (hasRecording) {
        btnLabel.visible = false;
        btnGfx.hitArea = new Rectangle(0, 0, 0, 0);
        return;
      }

      const by = pillCY();

      switch (recState) {
        case "idle":
        case "error": {
          btnGfx.roundRect(cw / 2 - PILL_W / 2, by - PILL_H / 2, PILL_W, PILL_H, PILL_R);
          btnGfx.fill({ color: COLOR_RECORD });
          btnLabel.text = iAmCreator ? "record" : "waiting";
          btnLabel.x = cw / 2;
          btnLabel.y = by;
          btnLabel.visible = true;
          btnGfx.hitArea = new Rectangle(cw / 2 - PILL_W / 2, by - PILL_H / 2, PILL_W, PILL_H);
          break;
        }
        case "requesting": {
          btnGfx.roundRect(cw / 2 - PILL_W / 2, by - PILL_H / 2, PILL_W, PILL_H, PILL_R);
          btnGfx.fill({ color: COLOR_RECORD_DIM });
          btnLabel.text = "requesting…";
          btnLabel.x = cw / 2;
          btnLabel.y = by;
          btnLabel.visible = true;
          btnGfx.hitArea = new Rectangle(cw / 2 - PILL_W / 2, by - PILL_H / 2, PILL_W, PILL_H);
          break;
        }
        case "recording": {
          // pulsing dot to the left of the stop pill
          const dotX = cw / 2 - PILL_W / 2 - DOT_GAP - DOT_R;
          btnGfx.circle(dotX, by, DOT_R);
          btnGfx.fill({ color: COLOR_RECORD, alpha: dotPulse });
          btnGfx.roundRect(cw / 2 - PILL_W / 2, by - PILL_H / 2, PILL_W, PILL_H, PILL_R);
          btnGfx.fill({ color: COLOR_MUTED });
          btnLabel.text = "■ stop";
          btnLabel.x = cw / 2;
          btnLabel.y = by;
          btnLabel.visible = true;
          btnGfx.hitArea = new Rectangle(cw / 2 - PILL_W / 2, by - PILL_H / 2, PILL_W, PILL_H);
          break;
        }
        case "processing": {
          btnGfx.roundRect(cw / 2 - PILL_W / 2, by - PILL_H / 2, PILL_W, PILL_H, PILL_R);
          btnGfx.fill({ color: COLOR_MUTED });
          btnLabel.text = "saving…";
          btnLabel.x = cw / 2;
          btnLabel.y = by;
          btnLabel.visible = true;
          btnGfx.hitArea = new Rectangle(cw / 2 - PILL_W / 2, by - PILL_H / 2, PILL_W, PILL_H);
          break;
        }
        default:
          btnLabel.visible = false;
          btnGfx.hitArea = new Rectangle(0, 0, 0, 0);
      }
    };

    const updateStatus = () => {
      switch (recState) {
        case "fetching":
          statusText.text = fetchErrorMessage || fetchProgressText;
          statusText.style.fill = COLOR_STATUS;
          statusText.visible = true;
          break;
        case "error":
          statusText.text = iAmCreator ? "mic access denied\ntap to try again" : "mic access denied";
          statusText.style.fill = COLOR_ERROR;
          statusText.visible = true;
          break;
        case "needs-friend":
          statusText.text = "only a non-friend peer has this recording\ntap to send a friend request";
          statusText.style.fill = COLOR_ERROR;
          statusText.visible = true;
          break;
        case "friend-requested":
          statusText.text = "friend request sent\nwill retry automatically once accepted";
          statusText.style.fill = COLOR_STATUS;
          statusText.visible = true;
          break;
        default:
          statusText.visible = false;
      }
    };

    const updateMouthInteractivity = () => {
      const hasRecording = !!ctx.doc.current.blobId;
      if (hasRecording) {
        mouthContainer.cursor = recState === "fetching" ? "wait" : "pointer";
        mouthContainer.hitArea = new Rectangle(0, 0, cw, ch);
      } else {
        mouthContainer.cursor = "default";
        mouthContainer.hitArea = new Rectangle(0, 0, 0, 0);
      }
    };

    const refresh = () => {
      drawBg();
      drawBtn();
      updateStatus();
      updateMouthInteractivity();
      statusText.x = cw / 2;
      statusText.y = ch / 2;
      (statusText.style as unknown as { wordWrapWidth: number }).wordWrapWidth = cw - 32;
    };

    refresh();

    // -- recording mouth animation --
    // reads RMS from mic AnalyserNode, smooths it, drives mouth openness + pulsing dot.
    const startRecordingAnim = (): void => {
      if (!analyser) return;
      const bufLen = analyser.frequencyBinCount;
      const dataArr = new Uint8Array(bufLen);
      const tick = (): void => {
        if (recState !== "recording") return;
        mouthRafId = requestAnimationFrame(tick);
        analyser!.getByteTimeDomainData(dataArr);
        let sum = 0;
        for (let i = 0; i < bufLen; i++) {
          const v = (dataArr[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / bufLen);
        const target = volumeToRawOpenness(rms);
        smoothOpenness += (target - smoothOpenness) * (target > smoothOpenness ? 0.6 : 0.15);
        mouth.setOpenness(smoothOpenness);
        dotPulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
        drawBtn();
      };
      mouthRafId = requestAnimationFrame(tick);
    };

    const stopRecordingAnim = (): void => {
      if (mouthRafId !== null) {
        cancelAnimationFrame(mouthRafId);
        mouthRafId = null;
      }
    };

    // -- playback mouth animation --
    // driven by a PRECOMPUTED rms envelope indexed by audioEl.currentTime,
    // not a live MediaElementAudioSourceNode→AnalyserNode tap. webkit (the
    // tauri wkwebview) does not reliably route media-element output through
    // the webaudio graph: audio keeps playing natively while the analyser
    // reads flat zeros — the confirmed cause of "mouth talks in the browser
    // but not in the tauri app". the envelope approach has no interception,
    // no autoplay-policy suspension, and is deterministic across engines.
    const startPlayAnim = (): void => {
      const tick = (): void => {
        if (recState !== "playing") return;
        playRafId = requestAnimationFrame(tick);
        if (!audioEl) return;
        ctx.setTitleProgress?.(audioEl.currentTime / Math.max(0.001, ctx.doc.current.duration));
        if (!playbackEnvelope) return;
        const idx = Math.floor(audioEl.currentTime * ENVELOPE_HZ);
        const rms = playbackEnvelope[Math.min(idx, playbackEnvelope.length - 1)] ?? 0;
        const target = volumeToRawOpenness(rms);
        smoothOpenness += (target - smoothOpenness) * (target > smoothOpenness ? 0.6 : 0.15);
        mouth.setOpenness(smoothOpenness);
      };
      playRafId = requestAnimationFrame(tick);
    };

    const stopPlayAnim = (): void => {
      if (playRafId !== null) {
        cancelAnimationFrame(playRafId);
        playRafId = null;
      }
    };

    // -- recording logic (mirrors audio-recording.ts exactly) --
    const startRecording = async (): Promise<void> => {
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
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
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstart = () => {
        recState = "recording";
        recStartTime = Date.now();
        startRecordingAnim();
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        // re-enumerate now that permission is granted — labels will be populated
        void enumerateDevices();
      };
      mediaRecorder.onstop = () => void finishRecording();
      mediaRecorder.start(100);
    };

    const stopRecording = (): void => {
      if (recState !== "recording") return;
      stopRecordingAnim();
      smoothOpenness = 0;
      mouth.setOpenness(0);
      recState = "processing";
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
      mediaRecorder?.stop();
      mediaStream?.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    };

    const finishRecording = async (): Promise<void> => {
      const durationSecs = (Date.now() - recStartTime) / 1000;
      const recMime = mediaRecorder?.mimeType ?? "audio/webm";
      const ext = mimeToExt(recMime);
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const filename = `voice-recording-${ts}.${ext}`;

      const recordedBlob = new Blob(audioChunks, { type: recMime });
      audioChunks = [];

      await audioCtx?.close();
      audioCtx = null;
      analyser = null;

      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
      playbackUrl = URL.createObjectURL(recordedBlob);
      // keep a copy of the raw bytes so ensurePlaybackEnvelope can decode
      // them for the lip-sync envelope — without this, playing back a
      // just-recorded (own) clip skips envelope computation entirely and
      // the mouth never animates, since getPlaybackUrl() (which is where
      // playbackBytes is normally set) short-circuits once playbackUrl is
      // already populated.
      playbackBytes = recordedBlob;

      try {
        let record: { blob_id: string; sha256: string; blake3: string; size: number; mime: string };

        if (isTauriMode()) {
          // tauri: route through rust for real blake3 + iroh-blobs pre-warming.
          // mirrors audio-recording's tauri branch. no OPFS/IndexedDB mirror —
          // tauri never reads blobs back through the browser blob-store, and a
          // mirror write here was keyed under a bogus hash (the browser blake3
          // hasher degrades to an empty string in a tauri build), which OPFS
          // rejects outright — see audio-recording.ts's module doc comment.
          const buffer = await recordedBlob.arrayBuffer();
          const base64Data = await base64Encode(buffer);
          const response = (await dispatch("blob_insert", {
            filename,
            mime: recMime,
            data: base64Data,
          })) as {
            blake3: string;
            iroh_hash: string;
            filename: string | null;
            mime: string | null;
            size: number;
          };
          const resolvedMime = response.mime || recMime;
          record = {
            blob_id: response.blake3,
            sha256: "",
            blake3: response.blake3,
            size: response.size,
            mime: resolvedMime,
          };
        } else {
          const file = new File([recordedBlob], filename, { type: recMime });
          const fileRecord = await storeBlobFromFile(file, { metadata: { domain: "audio" } });
          record = {
            blob_id: fileRecord.blob_id,
            sha256: fileRecord.sha256 ?? "",
            blake3: fileRecord.blake3 || fileRecord.blob_id,
            size: fileRecord.size,
            mime: fileRecord.mime,
          };
        }

        // recorder has the blob locally — register it as a snatcher immediately
        // so peers can target this node for downloads right away.
        const localNodeId = await getLocalNodeId();
        ctx.doc.change((d) => {
          d.blobId = record.blob_id;
          d.filename = filename;
          d.mime = recMime;
          d.size = record.size;
          d.blake3 = record.blake3;
          d.duration = durationSecs;
          d.snatchedBy = addSnatcher(d.snatchedBy, localNodeId);
        });

        recState = "ready";
      } catch (err) {
        console.error("[voice-widget] failed to store blob:", err);
        recState = "error";
      }

      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    // -- playback logic --
    // resolves an object URL (local fast path or P2P snatch), wires the audio
    // element through an AnalyserNode so the mouth reacts to playback volume.
    const getPlaybackUrl = async (): Promise<string | null> => {
      if (playbackUrl) return playbackUrl;

      const { blobId, filename, mime, size, blake3 } = ctx.doc.current;
      if (!blobId) return null;

      const peers = ctx.canvasStore?.peers() as PeersMap | undefined;
      let resolved: ResolvedAudioBytes | null = null;
      try {
        resolved = await resolveAudioBytes(
          { blobId, filename, mime, size, blake3 } as AudioBlobRef,
          peers,
          { getBlobData: getAudioBlobData, checkBlobLocality, snatchBlob, getLocalNodeId },
          (fraction) => {
            fetchProgressText =
              fraction >= 0 ? `downloading… ${Math.round(fraction * 100)}%` : "downloading…";
            if (recState === "fetching") updateStatus();
          },
          ctx.canvasStore ? (nodeId: string) => ctx.canvasStore!.isPeerOnline(nodeId) : undefined
        );
      } catch (err) {
        if (err instanceof BlobAccessDeniedError) throw err;
        console.error("[voice-widget] resolveAudioBytes failed:", err);
        return null;
      }

      if (destroyed) return null;
      if (!resolved) return null;

      if (resolved.snatchedByNodeId !== null) {
        if (resolved.blobId !== blobId || resolved.blake3 !== blake3) {
          ctx.doc.change((d) => {
            d.blobId = resolved!.blobId;
            d.blake3 = resolved!.blake3;
          });
        }
        ctx.doc.change((d) => {
          d.snatchedBy = addSnatcher(d.snatchedBy, resolved!.snatchedByNodeId);
        });
      }

      const blob = new Blob([resolved.buffer], { type: mime || "audio/webm" });
      // keep a copy of the raw bytes for the playback envelope decode —
      // decodeAudioData detaches the buffer it's given, so slice per use
      playbackBytes = blob;
      playbackUrl = URL.createObjectURL(blob);
      return playbackUrl;
    };

    /** decode the recording once and precompute the rms envelope the
     *  playback mouth animation indexes by currentTime. non-fatal on
     *  failure — audio still plays, the mouth just stays closed. */
    const ensurePlaybackEnvelope = async (url: string): Promise<void> => {
      if (playbackEnvelope && playbackEnvelopeUrl === url) return;
      if (!playbackBytes) return;
      try {
        const bytes = await playbackBytes.arrayBuffer();
        // OfflineAudioContext: decode without a live audio graph (no
        // autoplay-policy suspension, nothing routed anywhere)
        const decodeCtx = new OfflineAudioContext(1, 1, 44100);
        const decoded = await decodeCtx.decodeAudioData(bytes);
        playbackEnvelope = computeRmsEnvelope(
          decoded.getChannelData(0),
          decoded.sampleRate,
          ENVELOPE_HZ
        );
        playbackEnvelopeUrl = url;
      } catch (err) {
        console.warn("[voice-widget] envelope decode failed (mouth will stay closed):", err);
        playbackEnvelope = null;
        playbackEnvelopeUrl = null;
      }
    };

    const startPlayback = async (): Promise<void> => {
      fetchErrorMessage = "";

      if (!playbackUrl) {
        recState = "fetching";
        fetchProgressText = "downloading…";
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
      }

      let url: string | null;
      try {
        url = await getPlaybackUrl();
      } catch (err) {
        if (destroyed) return;
        if (err instanceof BlobAccessDeniedError) {
          deniedPeerNodeId = err.peerNodeId;
          recState = "needs-friend";
          refresh();
          ctx.setHeaderActions?.(makeHeaderActions());
          return;
        }
        console.error("[voice-widget] getPlaybackUrl failed:", err);
        url = null;
      }
      if (destroyed) return;
      if (!url) {
        recState = "ready";
        fetchErrorMessage = "playback unavailable";
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        return;
      }

      // create the audio element once per widget lifetime. playback is
      // plain native <audio> — deliberately NOT routed through webaudio
      // (see startPlayAnim's comment on the webkit/tauri analyser bug).
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.onended = () => {
          recState = "ready";
          smoothOpenness = 0;
          mouth.setOpenness(0);
          stopPlayAnim();
          refresh();
          ctx.setHeaderActions?.(makeHeaderActions());
          ctx.setTitleProgress?.(0);
        };
      }

      await ensurePlaybackEnvelope(url);
      if (destroyed) return;

      if (audioEl.src !== url) audioEl.src = url;

      try {
        await audioEl.play();
      } catch (err) {
        console.error("[voice-widget] play() failed:", err);
        recState = "ready";
        fetchErrorMessage = "playback unavailable";
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        return;
      }

      recState = "playing";
      startPlayAnim();
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
      ctx.setTitleProgress?.(audioEl.currentTime / Math.max(0.001, ctx.doc.current.duration));
    };

    const pausePlayback = (): void => {
      audioEl?.pause();
      recState = "ready";
      smoothOpenness = 0;
      mouth.setOpenness(0);
      stopPlayAnim();
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    /** send a friend request to the peer holding this recording, then
     *  automatically retry playback once the request is accepted (see
     *  pending-blob-access.ts). session-only — if the widget is destroyed
     *  before the request is accepted, the retry is simply dropped. */
    const requestFriendAndRetry = async (): Promise<void> => {
      const peerNodeId = deniedPeerNodeId;
      if (!peerNodeId) return;

      unregisterPendingRetry?.();
      try {
        await sendFriendRequest(peerNodeId);
      } catch (err) {
        console.error("[voice-widget] sendFriendRequest failed:", err);
        return;
      }
      if (destroyed) return;

      recState = "friend-requested";
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());

      unregisterPendingRetry = registerPendingBlobRetry(peerNodeId, () => {
        unregisterPendingRetry = null;
        if (destroyed) return;
        void startPlayback();
      });
    };

    const deleteRecording = (): void => {
      if (recState === "playing") {
        audioEl?.pause();
        stopPlayAnim();
      }
      if (audioEl) {
        audioEl.src = "";
        audioEl = null;
      }
      playbackEnvelope = null;
      playbackEnvelopeUrl = null;
      playbackBytes = null;
      if (playbackUrl) {
        URL.revokeObjectURL(playbackUrl);
        playbackUrl = null;
      }
      fetchErrorMessage = "";
      smoothOpenness = 0;
      mouth.setOpenness(0);
      recState = "idle";
      ctx.doc.change((d) => {
        d.blobId = "";
        d.filename = "";
        d.size = 0;
        d.blake3 = "";
        d.snatchedBy = [];
        d.duration = 0;
      });
      refresh();
      ctx.setHeaderActions?.(makeHeaderActions());
      ctx.setTitleProgress?.(null);
    };

    // -- event handlers --
    mouthContainer.on("pointertap", () => {
      if (!ctx.doc.current.blobId) return;
      if (ctx.canvasStore?.isLocalViewer()) return;
      if (recState === "ready") void startPlayback();
      else if (recState === "playing") pausePlayback();
      else if (recState === "needs-friend") void requestFriendAndRetry();
    });

    btnGfx.on("pointerup", () => {
      switch (recState) {
        case "idle":
        case "error":
          if (ctx.canvasStore?.isLocalViewer()) return;
          if (!iAmCreator) return;
          void startRecording();
          break;
        case "recording":
          if (ctx.canvasStore?.isLocalViewer()) return;
          if (!iAmCreator) return;
          stopRecording();
          break;
      }
    });

    // -- header actions (■ stop button while recording) --
    const makeHeaderActions = (): HeaderAction[] => {
      if (recState === "recording") {
        return [{ id: "stop", label: "■ stop", active: true, onClick: stopRecording }];
      }
      return [];
    };

    // -- doc subscription --
    const unsub = ctx.doc.on("change", () => {
      const { blobId, lipsColor, lipThickness, mouthMood, teethStyle, cupidBowAmount } = ctx.doc.current;

      // live lip color/thickness/mood/teeth-style sync — peers see changes immediately
      mouth.setLipsColor(lipsColor);
      mouth.setLipThickness(lipThickness);
      mouth.setMood(mouthMood as Mood);
      mouth.setTeethStyle(teethStyle as TeethStyle);
      mouth.setCupidBowAmount(cupidBowAmount);
      maybeRegenerateSnapshot();

      if ((recState === "idle" || recState === "error") && blobId) {
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
        smoothOpenness = 0;
        mouth.setOpenness(0);
        recState = "idle";
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        return;
      }

      if ((recState === "needs-friend" || recState === "friend-requested") && !blobId) {
        unregisterPendingRetry?.();
        unregisterPendingRetry = null;
        deniedPeerNodeId = null;
        smoothOpenness = 0;
        mouth.setOpenness(0);
        recState = "idle";
        refresh();
        ctx.setHeaderActions?.(makeHeaderActions());
        return;
      }

      // bgColor / borderColor / borderWidth change
      drawBg();
    });

    // -- widget actions (property tray) --
    const widgetActions: WidgetAction[] = [
      { id: "delete-recording", label: "delete recording", onClick: deleteRecording },
    ];

    return {
      container,
      headerActions: makeHeaderActions(),
      widgetActions,
      editableProps: [
        { key: "bgColor", label: "background", type: "color" as const, default: -1 },
        { key: "borderColor", label: "border", type: "color" as const, default: -1 },
        { key: "borderWidth", label: "border width", type: "number" as const, min: 0, default: 0 },
        { key: "lipsColor", label: "lips color", type: "color" as const, default: 0xc2455a },
        {
          key: "lipThickness",
          label: "lip thickness",
          type: "number" as const,
          default: 5,
          min: 1,
          max: 10,
        },
        {
          key: "mouthMood",
          label: "mouth mood",
          type: "select" as const,
          options: ["frown", "neutral", "smile"],
          default: "neutral",
        },
        {
          key: "teethStyle",
          label: "teeth style",
          type: "select" as const,
          options: ["straight", "curved"],
          default: "straight",
        },
        {
          key: "cupidBowAmount",
          label: "cupid's bow",
          type: "number" as const,
          default: 4,
          min: 0,
          max: 10,
        },
        {
          key: "deviceLabel",
          label: "input device",
          type: "select" as const,
          options: deviceOptions,
          default: DEVICE_DEFAULT,
        },
      ],
      dropTarget: (store
        ? {
            hitTest(worldX: number, worldY: number): boolean {
              // only while there's nothing recorded yet — a drop is a
              // one-time "seed this widget's audio" action, not a swap.
              if (ctx.doc.current.blobId || !iAmCreator) return false;
              const entry = store.getWidget(ctx.widgetId);
              if (!entry) return false;
              return (
                worldX >= entry.x &&
                worldX <= entry.x + entry.width &&
                worldY >= entry.y &&
                worldY <= entry.y + entry.height
              );
            },

            onHover(_worldX: number, _worldY: number, draggedWidgetId: string): void {
              const entry = store.getWidget(draggedWidgetId);
              setDropHighlight(!!entry && (entry.type === "audio-recording" || entry.type === "file"));
            },

            onLeave(): void {
              setDropHighlight(false);
            },

            onDrop(draggedWidgetId: string, _worldX: number, _worldY: number): boolean {
              setDropHighlight(false);
              const entry = store.getWidget(draggedWidgetId);
              if (!entry || (entry.type !== "audio-recording" && entry.type !== "file")) return false;

              void readDroppedAudioSource(entry.type, entry.docId).then((source) => {
                if (!source) return;
                // the existing doc-change subscription above already flips
                // recState "idle"/"error" -> "ready" the moment blobId goes
                // truthy, so this write is all that's needed here.
                ctx.doc.change((d) => {
                  d.blobId = source.blobId;
                  d.filename = source.filename;
                  d.mime = source.mime;
                  d.size = source.size;
                  d.blake3 = source.blake3;
                  d.duration = source.duration;
                  d.snatchedBy = source.snatchedBy;
                });
                store.removeWidget(draggedWidgetId);
              });

              return true;
            },
          }
        : undefined) as DropTargetHandler | undefined,
      destroy() {
        destroyed = true;
        stopRecordingAnim();
        stopPlayAnim();
        unregisterPendingRetry?.();
        unregisterPendingRetry = null;
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
        mouth.destroy();
        unsub();
        container.destroy({ children: true });
      },
      resize(w, h) {
        cw = w;
        ch = h;
        bgGfx.hitArea = new Rectangle(0, 0, cw, ch);
        mouth.resize(cw, ch);
        refresh();
      },
    };
  },
};

// module-level reference set by registerVoiceRecordingWidget() so the
// widget's own create() can read another dropped widget's doc via the
// full registry — same pattern animaniac/index.ts and stfu/index.ts use
// for their own cross-widget drop targets (WidgetMountContext doesn't
// carry the registry itself).
let _voiceRecordingWidgetRegistry: WidgetRegistry | null = null;

export function registerVoiceRecordingWidget(registry: WidgetRegistry): void {
  registry.register(voiceRecordingWidget);
  _voiceRecordingWidgetRegistry = registry;
}

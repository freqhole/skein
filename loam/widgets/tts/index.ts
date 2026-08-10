/**
 * standalone tts widget — authors text, previews it via the browser's
 * `speechSynthesis` (works everywhere, never gated), and — on a tauri peer
 * with `say` available — generates real, storable speech audio via the
 * "generate audio" header action. works fine with `blobId` empty: it's
 * simply a text reference nobody has "finished" into real audio yet, and
 * any tauri+`say` peer who later opens the same doc can generate it.
 */

import { Container, Graphics, Text } from "pixi.js";
import { getLocalNodeId, type PeersMap } from "../../src/file-utils/file-shared";
import { checkBlobLocality } from "../../src/file-utils/blob-locality";
import { BlobAccessDeniedError, snatchBlob } from "../../src/file-utils/snatch";
import { createDomOverlay, type DomOverlayHandle } from "../../src/widgets/dom-overlay";
import { colorToCss, contrastTextColor } from "../../src/widgets/format";
import {
  isTransparent,
  type CompactInfo,
  type HeaderAction,
  type WidgetAction,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../../src/widgets/widget-types";
import {
  addSnatcher,
  getAudioBlobData,
  resolveAudioBytes,
  type ResolvedAudioBytes,
} from "../audio-recording";
import { generateTtsAudio } from "./generate";
import { DEFAULT_TTS_RATE, MAX_TTS_RATE, MIN_TTS_RATE, ttsSchema, type TtsState } from "./schema";
import {
  cancelPreview,
  isGenerateAvailable,
  langForVoiceName,
  listVoiceNames,
  speakPreview,
  VOICE_DEFAULT,
} from "./voices";
import { computeWaveformSamples } from "./waveform";

const PADDING = 12;
const RATE_STEP = 0.1;
const WAVEFORM_HEIGHT = 28;

export const ttsWidget: WidgetFactory<typeof ttsSchema> = {
  type: "tts",
  metadata: {
    name: "tts",
    description: "author text, preview it aloud, and generate real speech audio",
    version: "0.1.0",
    category: "media",
    defaultWidth: 320,
    defaultHeight: 220,
  },
  schema: ttsSchema,
  editableProps: [
    { key: "bgColor", label: "background", type: "color" as const, default: 0x1e1e2e },
    { key: "borderColor", label: "border", type: "color" as const, default: -1 },
    { key: "borderWidth", label: "border width", type: "number" as const, min: 0, default: 0 },
    {
      key: "ttsVoiceName",
      label: "voice",
      type: "select" as const,
      options: listVoiceNames,
      default: VOICE_DEFAULT,
    },
    {
      key: "ttsRate",
      label: "rate",
      type: "number" as const,
      min: MIN_TTS_RATE,
      max: MAX_TTS_RATE,
      step: RATE_STEP,
      default: DEFAULT_TTS_RATE,
    },
  ],

  getCompactInfo: (state: TtsState): CompactInfo => ({
    label: state.ttsText ? state.ttsText.slice(0, 40) : "tts",
    domain: "audio",
    bgColor: state.bgColor,
    borderColor: state.borderColor,
    borderWidth: state.borderWidth,
    blobId: state.blobId || undefined,
    mime: state.mime || undefined,
    filename: state.filename || undefined,
    blake3: state.blake3 || undefined,
    size: state.size || undefined,
    snatchedBy: state.snatchedBy?.length ? state.snatchedBy : undefined,
  }),

  create(ctx: WidgetMountContext<typeof ttsSchema>): WidgetController {
    const container = new Container();
    let destroyed = false;
    let editing = false;
    let currentWidth = ctx.width;
    let currentHeight = ctx.height;

    let generating = false;
    let previewSpeaking = false;
    let playState: "idle" | "fetching" | "playing" = "idle";
    let statusMessage = "";
    let fetchProgressText = "";

    let audioEl: HTMLAudioElement | null = null;
    let playbackUrl: string | null = null;

    // ── background ────────────────────────────────────────────────────────
    const bg = new Graphics();
    const drawBg = (w: number, h: number, isEditing: boolean) => {
      const state = ctx.doc.current;
      bg.clear();
      bg.roundRect(0, 0, w, h, 8);
      bg.fill(isTransparent(state.bgColor) ? { color: 0, alpha: 0 } : { color: state.bgColor });
      const strokeColor = isEditing ? 0xd946ef : state.borderColor;
      const strokeWidth = isEditing ? 3 : state.borderWidth;
      if (strokeWidth > 0) {
        bg.stroke(
          isTransparent(strokeColor)
            ? { color: 0, alpha: 0, width: strokeWidth }
            : { color: strokeColor, width: strokeWidth }
        );
      }
    };
    drawBg(currentWidth, currentHeight, false);
    container.addChild(bg);

    // ── text display + placeholder ───────────────────────────────────────
    let textColor = 0xf1f5f9;
    const textDisplay = new Text({
      text: ctx.doc.current.ttsText,
      resolution: 2,
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 15,
        fill: textColor,
        wordWrap: true,
        wordWrapWidth: currentWidth - PADDING * 2,
      },
    });
    textDisplay.x = PADDING;
    textDisplay.y = PADDING;
    container.addChild(textDisplay);

    const updateTextColor = () => {
      const state = ctx.doc.current;
      textColor = isTransparent(state.bgColor) ? 0xf1f5f9 : contrastTextColor(state.bgColor);
      textDisplay.style.fill = textColor;
    };

    const placeholder = new Text({
      text: "tap to write text to speak",
      resolution: 2,
      style: { fontFamily: "system-ui, sans-serif", fontSize: 15, fill: 0x64748b },
    });
    placeholder.x = PADDING;
    placeholder.y = PADDING;
    container.addChild(placeholder);

    const statusText = new Text({
      text: "",
      resolution: 2,
      style: { fontFamily: "system-ui, sans-serif", fontSize: 11, fill: 0x94a3b8 },
    });
    statusText.x = PADDING;
    container.addChild(statusText);

    const waveform = new Graphics();
    container.addChild(waveform);

    const drawWaveform = (w: number, y: number) => {
      waveform.clear();
      const samples = ctx.doc.current.waveformSamples;
      if (!samples || samples.length === 0) return;
      const availW = w - PADDING * 2;
      const barW = availW / samples.length;
      const midY = y + WAVEFORM_HEIGHT / 2;
      for (let i = 0; i < samples.length; i++) {
        const barH = Math.max(2, samples[i] * WAVEFORM_HEIGHT);
        const x = PADDING + i * barW;
        waveform.rect(x, midY - barH / 2, Math.max(1, barW - 1), barH);
      }
      waveform.fill({ color: 0xd946ef, alpha: 0.8 });
    };

    const updatePlaceholderVisibility = () => {
      placeholder.visible = !ctx.doc.current.ttsText && !editing;
      textDisplay.visible = !editing;
    };

    // no local audio bytes and no way to fetch them (e.g. a denied p2p
    // snatch) — a fresh regenerate is a much simpler recovery than a
    // friend-request retry, and it's already one click away on this peer.
    const playbackUnavailableMessage = (): string =>
      isGenerateAvailable() ? "playback unavailable — try regenerating audio" : "playback unavailable";

    const statusLine = (): string => {
      if (statusMessage) return statusMessage;
      if (generating) return "generating…";
      if (playState === "fetching") return fetchProgressText || "downloading…";
      const state = ctx.doc.current;
      if (state.blobId) {
        if (state.ttsText !== state.ttsTextAtGenerate) return "text changed — regenerate to hear updates";
        return `${Math.round(state.duration)}s · ready`;
      }
      return "";
    };

    const layout = (w: number, h: number) => {
      textDisplay.style.wordWrapWidth = w - PADDING * 2;
      placeholder.style.wordWrapWidth = w - PADDING * 2;
      statusText.y = h - PADDING - statusText.height;
      const hasWaveform = ctx.doc.current.waveformSamples?.length > 0;
      drawWaveform(w, statusText.y - (hasWaveform ? WAVEFORM_HEIGHT + 4 : 0));
    };

    const refresh = () => {
      textDisplay.text = ctx.doc.current.ttsText;
      statusText.text = statusLine();
      updatePlaceholderVisibility();
      updateTextColor();
      drawBg(currentWidth, currentHeight, editing);
      layout(currentWidth, currentHeight);
    };
    refresh();

    // ── inline text editing (double-click, mirrors label.ts/notepad.ts) ──
    let activeOverlay: DomOverlayHandle | null = null;

    const startEditing = () => {
      if (editing) return;
      if (ctx.canvasStore?.isLocalViewer()) return;
      editing = true;
      drawBg(currentWidth, currentHeight, true);
      updatePlaceholderVisibility();

      activeOverlay = createDomOverlay({
        container,
        canvasElement: ctx.canvasElement,
        width: currentWidth,
        height: currentHeight - PADDING - statusText.height,
        multiline: true,
        value: ctx.doc.current.ttsText,
        enterCommits: false,
        onCommit: (value: string) => {
          editing = false;
          activeOverlay = null;
          if (value !== ctx.doc.current.ttsText) {
            ctx.doc.change((draft) => {
              draft.ttsText = value;
            });
          }
          drawBg(currentWidth, currentHeight, false);
          refresh();
        },
        onRevert: () => {
          editing = false;
          activeOverlay = null;
          drawBg(currentWidth, currentHeight, false);
          refresh();
        },
        css: {
          fontFamily: "system-ui, sans-serif",
          fontSize: "15px",
          color: colorToCss(textColor),
          padding: `${PADDING}px`,
          overflow: "auto",
          lineHeight: "1.4",
          whiteSpace: "pre-wrap",
          wordWrap: "break-word",
        },
      });
    };

    let lastTapTime = 0;
    container.eventMode = "static";
    container.cursor = "default";
    container.on("pointertap", () => {
      if (editing) return;
      const now = Date.now();
      if (now - lastTapTime < 400) {
        startEditing();
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    });

    // ── preview (speechSynthesis) — works everywhere, never gated ────────
    const handlePreview = () => {
      const state = ctx.doc.current;
      const text = state.ttsText.trim();
      if (!text) return;
      previewSpeaking = true;
      updateHeaderActions();
      speakPreview(text, state.ttsVoiceName, state.ttsRate, () => {
        previewSpeaking = false;
        updateHeaderActions();
      });
    };

    const handleStopPreview = () => {
      cancelPreview();
      previewSpeaking = false;
      updateHeaderActions();
    };

    // ── generate real audio via say (tauri only, gated per-peer) ────────
    const handleGenerate = async () => {
      if (generating) return;
      const state = ctx.doc.current;
      const text = state.ttsText.trim();
      if (!text) return;
      generating = true;
      statusMessage = "";
      refresh();
      updateHeaderActions();
      try {
        const voiceName = state.ttsVoiceName === VOICE_DEFAULT ? "" : state.ttsVoiceName;
        const result = await generateTtsAudio(text, voiceName, state.ttsRate);
        if (destroyed) return;
        const [localNodeId, waveformSamples] = await Promise.all([
          getLocalNodeId(),
          computeWaveformSamples(result.dataBase64),
        ]);
        if (destroyed) return;
        ctx.doc.change((d) => {
          d.blobId = result.blobId;
          d.filename = result.filename;
          d.mime = result.mime;
          d.size = result.size;
          d.blake3 = result.blake3;
          d.duration = result.duration;
          d.waveformSamples = waveformSamples;
          d.ttsTextAtGenerate = text;
          d.ttsVoiceLang = langForVoiceName(voiceName);
          d.snatchedBy = addSnatcher(d.snatchedBy, localNodeId);
        });
        if (previewSpeaking) handleStopPreview();
        if (playbackUrl) {
          URL.revokeObjectURL(playbackUrl);
          playbackUrl = null;
        }
      } catch (err) {
        console.error("[tts] generate failed:", err);
        statusMessage = "generation failed";
      } finally {
        generating = false;
        refresh();
        updateHeaderActions();
      }
    };

    // ── playback of generated audio ──────────────────────────────────────
    const getPlaybackUrl = async (): Promise<string | null> => {
      if (playbackUrl) return playbackUrl;
      const { blobId, filename, mime, size, blake3 } = ctx.doc.current;
      if (!blobId) return null;

      const peers = ctx.canvasStore?.peers() as PeersMap | undefined;
      let resolved: ResolvedAudioBytes | null = null;
      try {
        resolved = await resolveAudioBytes(
          { blobId, filename, mime, size, blake3 },
          peers,
          { getBlobData: getAudioBlobData, checkBlobLocality, snatchBlob, getLocalNodeId },
          (fraction) => {
            fetchProgressText = fraction >= 0 ? `downloading… ${Math.round(fraction * 100)}%` : "downloading…";
            if (playState === "fetching") refresh();
          },
          ctx.canvasStore ? (nodeId: string) => ctx.canvasStore!.isPeerOnline(nodeId) : undefined
        );
      } catch (err) {
        if (err instanceof BlobAccessDeniedError) throw err;
        console.error("[tts] resolveAudioBytes failed:", err);
        return null;
      }
      if (destroyed || !resolved) return null;

      if (resolved.snatchedByNodeId !== null) {
        ctx.doc.change((d) => {
          d.snatchedBy = addSnatcher(d.snatchedBy, resolved!.snatchedByNodeId);
        });
      }

      const blob = new Blob([resolved.buffer], { type: mime || "audio/wav" });
      playbackUrl = URL.createObjectURL(blob);
      return playbackUrl;
    };

    const handleStartPlayback = async () => {
      playState = "fetching";
      fetchProgressText = "";
      refresh();
      updateHeaderActions();

      let url: string | null;
      try {
        url = await getPlaybackUrl();
      } catch (err) {
        if (destroyed) return;
        playState = "idle";
        statusMessage =
          err instanceof BlobAccessDeniedError
            ? "found on a peer you're not friends with yet"
            : playbackUnavailableMessage();
        refresh();
        updateHeaderActions();
        return;
      }
      if (destroyed) return;
      if (!url) {
        playState = "idle";
        statusMessage = playbackUnavailableMessage();
        refresh();
        updateHeaderActions();
        return;
      }

      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.onended = () => {
          playState = "idle";
          refresh();
          updateHeaderActions();
        };
      }
      if (audioEl.src !== url) audioEl.src = url;

      try {
        await audioEl.play();
      } catch (err) {
        console.error("[tts] play() failed:", err);
        playState = "idle";
        statusMessage = playbackUnavailableMessage();
        refresh();
        updateHeaderActions();
        return;
      }
      playState = "playing";
      refresh();
      updateHeaderActions();
    };

    const handleStopPlayback = () => {
      audioEl?.pause();
      playState = "idle";
      refresh();
      updateHeaderActions();
    };

    // ── header actions ───────────────────────────────────────────────────
    const makeHeaderActions = (): HeaderAction[] => {
      const state = ctx.doc.current;
      const actions: HeaderAction[] = [];

      // once real audio exists, the browser speechSynthesis preview is
      // redundant — "play" below is the generated audio itself.
      if (!state.blobId) {
        actions.push({
          id: "preview",
          label: previewSpeaking ? "stop preview" : "preview text aloud",
          shortLabel: previewSpeaking ? "■" : "▶",
          active: previewSpeaking,
          onClick: previewSpeaking ? handleStopPreview : handlePreview,
        });
      }

      if (isGenerateAvailable()) {
        actions.push({
          id: "generate",
          label: generating ? "generating…" : state.blobId ? "regenerate" : "generate",
          shortLabel: generating ? "…" : state.blobId ? "regen" : "gen",
          disabled: generating,
          marginLeft: actions.length ? 8 : undefined,
          onClick: handleGenerate,
        });
      }

      if (state.blobId) {
        actions.push({
          id: "play",
          label: playState === "playing" ? "stop" : playState === "fetching" ? "downloading…" : "play",
          shortLabel: playState === "playing" ? "■" : playState === "fetching" ? "…" : "▶",
          active: playState === "playing",
          disabled: playState === "fetching",
          marginLeft: actions.length ? 8 : undefined,
          onClick: playState === "playing" ? handleStopPlayback : handleStartPlayback,
        });
      }

      return actions;
    };

    const updateHeaderActions = () => {
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    // header space is often too tight to show every button (especially at
    // the widget's default size) — mirror the same actions into the prop
    // tray so they're always reachable regardless of header width.
    const widgetActions: WidgetAction[] = [
      {
        id: "preview",
        label: "preview",
        onClick: () => (previewSpeaking ? handleStopPreview() : handlePreview()),
      },
    ];
    if (isGenerateAvailable()) {
      widgetActions.push({
        id: "generate",
        label: "generate audio",
        onClick: () => void handleGenerate(),
      });
    }

    // ── doc subscription ──────────────────────────────────────────────────────────────────
    const unsub = ctx.doc.on("change", () => {
      if (!editing) refresh();
      updateHeaderActions();
    });

    return {
      container,
      headerActions: makeHeaderActions(),
      widgetActions,
      onReposition() {
        activeOverlay?.reposition();
      },
      onVisibilityChange(visible) {
        if (!visible) {
          cancelPreview();
          previewSpeaking = false;
          audioEl?.pause();
          playState = "idle";
        }
      },
      resize(width, height) {
        currentWidth = width;
        currentHeight = height;
        drawBg(width, height, editing);
        layout(width, height);
      },
      destroy() {
        destroyed = true;
        cancelPreview();
        unsub();
        if (activeOverlay) {
          activeOverlay.remove();
          activeOverlay = null;
        }
        if (audioEl) {
          audioEl.pause();
          audioEl.src = "";
          audioEl = null;
        }
        if (playbackUrl) {
          URL.revokeObjectURL(playbackUrl);
          playbackUrl = null;
        }
        container.destroy({ children: true });
      },
    };
  },
};

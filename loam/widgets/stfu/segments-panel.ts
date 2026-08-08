/**
 * stfu's "SEGMENTS" panel — a below-timeline scrollable list of rows,
 * switchable (multi-select) between the editable cut list, the read-only
 * reference data, and the audio-clips track. which sources are visible is
 * toggled externally now (clicking a track's own label in the timeline —
 * see `video-timeline.ts`/`reference-track.ts` — calls `toggleViewMode()`
 * below), not via an in-panel flyout; likewise "autoscroll" (follow the
 * playhead) is now a single toggle owned by `video-timeline.ts`'s toolbar,
 * read here via `getAutoScrollEnabled()`. design-ports editor.js's dub
 * panel (`createDubRowContainer()`/`layoutDubRow()`/
 * `createSegmentsViewControl()`/`maybeSyncPanelScroll()`), including its
 * inline tts-text authoring (`openDubEditOverlay()`'s reusable DOM
 * `<textarea>`-over-a-pixi-box technique) directly in each audio-clip row
 * — deliberately NOT a separate popup/dialog, so authoring a clip's text
 * reads as part of scanning the list rather than a context switch.
 *
 * unlike `reference-track.ts` (nested inside `video-timeline.ts`'s layered
 * containers, so its popover needs an externally-supplied `overlayParent`
 * to render on top of sibling layers), this panel is its own flat
 * top-level container.
 */

import { Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from "pixi.js";
import { createScrollableContent, type ScrollableContent } from "../../src/widgets/scrollable-content";
import { createSkeinInput, type SkeinInputHandle } from "../../src/widgets/skein-input";
import type { EditableSegment } from "./cut-segments-track";
import { contrastTextColor } from "./reference-data";
import {
  buildPanelSegments,
  findActiveSegmentIndex,
  SEGMENTS_VIEW_MODES,
  type PanelSegment,
  type SegmentsViewMode,
} from "./segments-panel-data";
import { generateTtsAudio, type TtsGenerateResult } from "../tts/generate";
import { cancelPreview, isGenerateAvailable, listVoiceNames, speakPreview, VOICE_DEFAULT } from "../tts/voices";
import type { VoicePickerOpenOptions } from "./voice-picker-dialog";
import type { AudioClip, ReferenceSpeaker, TranscriptSegment } from "./types";
import { log } from "@freqhole/reliquary/utils";

// the last voice picked (in any clip's voice picker) becomes the default for
// the NEXT brand-new clip created — deliberately a single global key (not
// scoped per-widget/per-clip) per the user's own "global setting" wording,
// since each individual clip can still override it afterward.
const LAST_VOICE_STORAGE_KEY = "skein.stfu.lastTtsVoiceName";

function loadLastVoiceName(): string {
  try {
    return localStorage.getItem(LAST_VOICE_STORAGE_KEY) || VOICE_DEFAULT;
  } catch {
    return VOICE_DEFAULT;
  }
}

function saveLastVoiceName(name: string): void {
  try {
    localStorage.setItem(LAST_VOICE_STORAGE_KEY, name);
  } catch {
    // private browsing / storage disabled / quota exceeded — not fatal, just doesn't persist
  }
}

const TAG = "stfu.segments-panel";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

// matches trek-minus-paris's --color-magenta custom property
const MAGENTA = 0xe619b3;

const ROW_HEIGHT = 60;
/** taller row for an audio clip — room for the time/meta line plus the
 *  inline tts-text box and voice/rate/generate controls below it. */
const AUDIO_ROW_HEIGHT = 150;
const ROW_GAP = 6;
const ROW_PAD_X = 8;
const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.25;
/** how many rows' worth of vertical space the scrollable list reserves */
const VISIBLE_ROWS = 2;
export const SEGMENTS_PANEL_HEIGHT = ROW_HEIGHT * VISIBLE_ROWS + ROW_GAP * (VISIBLE_ROWS - 1);

export interface SegmentsPanelOptions {
  canvasElement: HTMLCanvasElement;
  getEditableSegments: () => EditableSegment[];
  getTranscriptSegments: () => TranscriptSegment[];
  getReferenceSpeakers: () => Record<string, ReferenceSpeaker>;
  getAudioClips: () => AudioClip[];
  onSeek: (t: number) => void;
  /** commits an audio clip's edited tts text (fires on blur/Enter, same as
   *  every other skein-input-backed text field in this codebase). */
  onClipTextCommit: (clip: AudioClip, text: string) => void;
  /** fires once a speechSynthesis preview of a clip's tts text finishes,
   *  reporting how long it actually took to speak (wall-clock seconds) —
   *  the caller uses this to size the clip's timeline box for a clip that
   *  hasn't been generated/recorded yet (no `audioBlobId`), since there's
   *  no real audio file duration to fall back on until then. */
  onPreviewDurationMeasured?: (clip: AudioClip, seconds: number) => void;
  /** fires once tts generation succeeds for a clip's inline "generate"
   *  button — caller writes the result onto the clip's doc fields. */
  onClipGenerate: (
    clip: AudioClip,
    text: string,
    result: TtsGenerateResult,
    voiceName: string,
    voiceLang: string,
    rate: number
  ) => void;
  /** localStorage key for the view-modes pref (browser-local UI state) */
  storageKey: string;
  /** opens the (widget-wide) voice-picker dialog for a row's voice button —
   *  the panel itself is only ~150px tall, nowhere near enough room for a
   *  scrollable voice list, so the dialog is owned/mounted at the widget
   *  root by `index.ts` instead and just triggered from here. */
  onOpenVoicePicker: (opts: VoicePickerOpenOptions) => void;
  /** whether "autoscroll" (follow the playhead) is currently on — owned by
   *  `video-timeline.ts`'s toolbar toggle now, read here every `onTimeUpdate()`. */
  getAutoScrollEnabled: () => boolean;
  /** initial panel height in px — defaults to `SEGMENTS_PANEL_HEIGHT` (the
   *  original fixed size) if omitted. `resize()`'s own `height` argument is
   *  the only other way to change it afterward (see `index.ts`'s vertical
   *  resize handles, which own the persisted preference for this value). */
  initialHeight?: number;
}

export interface SegmentsPanelHandle {
  container: Container;
  /** re-draw rows — call after editableSegments/transcriptSegments/referenceSpeakers/audioClips change. */
  refresh(): void;
  /** `height` is optional — omit it to just reflow at the current height
   *  (e.g. a plain width-only resize) rather than changing it. */
  resize(width: number, height?: number): void;
  /** call on every video timeupdate with the current playhead time — advances autoscroll. */
  onTimeUpdate(currentTime: number): void;
  /**
   * highlight the cut-list row matching `seg` (by [start, end], the same
   * identity `cut-segments-track.ts` reports its selection with) and
   * scroll it into view; pass `null` to clear the highlight. a no-op
   * while the cut list isn't currently a visible source.
   */
  setSelectedSegment(seg: EditableSegment | null): void;
  /** highlight the audio-clip row matching `clipId` and scroll it into
   *  view; pass `null` to clear. a no-op while audio clips aren't
   *  currently a visible source. */
  setSelectedClip(clipId: string | null): void;
  /** flip whether `mode` is one of the currently visible sources — called
   *  from a track's own label click (`video-timeline.ts`/`reference-track.ts`),
   *  now that the in-panel flyout that used to trigger this is gone. keeps
   *  at least one mode active (mirrors the old flyout's own guard). */
  toggleViewMode(mode: SegmentsViewMode): void;
  /** whether `mode` is currently one of the visible sources — lets a
   *  track's own label render an active/inactive highlight. */
  isViewModeActive(mode: SegmentsViewMode): boolean;
  destroy(): void;
}

interface PanelPrefs {
  viewModes: SegmentsViewMode[];
}

const ALL_MODE_IDS = SEGMENTS_VIEW_MODES.map((m) => m.id);

function sanitizeModes(raw: unknown): SegmentsViewMode[] {
  const valid = Array.isArray(raw) ? raw.filter((m): m is SegmentsViewMode => ALL_MODE_IDS.includes(m)) : [];
  return valid.length > 0 ? valid : ["cutlist"];
}

function loadPrefs(storageKey: string): PanelPrefs {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { viewModes: ["cutlist"] };
    const parsed = JSON.parse(raw);
    // migrate the old single-`viewMode` shape transparently
    const modesSource = Array.isArray(parsed.viewModes) ? parsed.viewModes : [parsed.viewMode];
    return {
      viewModes: sanitizeModes(modesSource),
    };
  } catch {
    return { viewModes: ["cutlist"] };
  }
}

function savePrefs(storageKey: string, prefs: PanelPrefs): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(prefs));
  } catch {
    // private browsing / quota exceeded / disabled storage — not fatal, prefs just don't persist
  }
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2);
  return `${m}:${s.padStart(5, "0")}`;
}


interface AudioRowExtras {
  root: Container;
  input: SkeinInputHandle;
  bind(clip: AudioClip, width: number, y: number): void;
  destroy(): void;
}

/**
 * inline tts-authoring controls for one audio-clip row: a `createSkeinInput()`
 * text box (commits via `onEnter`, same convention `hub-profile-panel.ts`
 * uses) plus a button opening the full voice-picker dialog, rate +/- steppers,
 * a "▶ preview"/"■ stop" speechSynthesis button, and a "generate"
 * button — ported from clip-editor-panel.ts's popover, but always visible
 * as part of the row rather than behind a popup. one instance is created
 * lazily per pooled row slot and re-`bind()`-ed to whichever clip currently
 * occupies that slot.
 */
function createAudioRowExtras(
  canvasElement: HTMLCanvasElement,
  onClipTextCommit: SegmentsPanelOptions["onClipTextCommit"],
  onClipGenerate: SegmentsPanelOptions["onClipGenerate"],
  onOpenVoicePicker: SegmentsPanelOptions["onOpenVoicePicker"],
  onPreviewDurationMeasured: SegmentsPanelOptions["onPreviewDurationMeasured"]
): AudioRowExtras {
  let currentClip: AudioClip | null = null;
  let voiceName = VOICE_DEFAULT;
  let rate = 1;
  let generating = false;
  let previewing = false;
  let errorMessage = "";
  let lastWidth = 0;

  const root = new Container();

  function drawButton(g: Graphics, w: number, h: number, hovered: boolean, disabled: boolean): void {
    g.clear();
    const color = disabled ? 0x2a2a2a : hovered ? 0x3a3a52 : 0x2a2a3e;
    g.roundRect(0, 0, w, h, 4).fill({ color });
  }

  const input = createSkeinInput({
    canvasElement,
    width: 100,
    height: 40,
    placeholder: "what should this clip say?",
    fontSize: 11,
    onEnter: (value) => {
      if (currentClip) onClipTextCommit(currentClip, value);
    },
  });
  root.addChild(input.input);

  const voiceButton = new Container();
  voiceButton.eventMode = "static";
  voiceButton.cursor = "pointer";
  const voiceBg = new Graphics();
  const voiceLabel = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  voiceBg.eventMode = "static";
  voiceBg.cursor = "pointer";
  voiceButton.addChild(voiceBg, voiceLabel);
  root.addChild(voiceButton);

  function layoutVoiceButton(): void {
    voiceLabel.text = `voice: ${voiceName}`;
    voiceLabel.x = 6;
    voiceLabel.y = 4;
    drawButton(voiceBg, Math.max(70, voiceLabel.width + 12), 20, false, false);
  }
  layoutVoiceButton();
  voiceButton.on("pointerover", () => drawButton(voiceBg, Math.max(70, voiceLabel.width + 12), 20, true, false));
  voiceButton.on("pointerout", () => drawButton(voiceBg, Math.max(70, voiceLabel.width + 12), 20, false, false));
  voiceButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onOpenVoicePicker({
      text: input.value,
      currentVoiceName: voiceName,
      rate,
      onTextChange: (text) => {
        if (currentClip) onClipTextCommit(currentClip, text);
      },
      onSelectVoice: (name) => {
        voiceName = name;
        saveLastVoiceName(name);
        // `layoutVoiceButton()` alone only resizes the voice button itself —
        // `layout()` is what repositions the rate stepper/generate button
        // against its (now possibly wider/narrower) width.
        layoutVoiceButton();
        layout();
      },
    });
  });

  // preview (speechSynthesis) works everywhere, unlike `generate` below —
  // never gated on `isGenerateAvailable()`, matches the tts widget's own
  // "preview text aloud" action.
  const previewButton = new Container();
  previewButton.eventMode = "static";
  previewButton.cursor = "pointer";
  const previewBg = new Graphics();
  const previewLabel = new Text({
    text: "\u25b6 preview",
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  previewBg.eventMode = "static";
  previewBg.cursor = "pointer";
  previewButton.addChild(previewBg, previewLabel);
  root.addChild(previewButton);

  function layoutPreviewButton(hovered = false): void {
    previewLabel.text = previewing ? "\u25a0 stop" : "\u25b6 preview";
    previewLabel.x = 6;
    previewLabel.y = 4;
    drawButton(previewBg, Math.max(70, previewLabel.width + 12), 20, hovered, false);
  }
  layoutPreviewButton();
  previewButton.on("pointerover", () => layoutPreviewButton(true));
  previewButton.on("pointerout", () => layoutPreviewButton(false));
  previewButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    if (previewing) {
      cancelPreview();
      previewing = false;
      layoutPreviewButton();
      return;
    }
    const text = input.value.trim();
    if (!text) {
      errorMessage = "enter some text first";
      layout();
      return;
    }
    previewing = true;
    errorMessage = "";
    layoutPreviewButton();
    log.debug(TAG, `previewing clip ${currentClip?.id ?? "?"} via speechSynthesis (voice=${voiceName}, rate=${rate})`);
    const previewClip = currentClip;
    const startedAt = performance.now();
    speakPreview(text, voiceName === VOICE_DEFAULT ? "" : voiceName, rate, () => {
      previewing = false;
      layoutPreviewButton();
      // only trust this as a real duration measurement if the clip is
      // still the same one (not swapped out mid-preview via `bind()`) and
      // doesn't already have real generated/recorded audio to size itself
      // from instead.
      if (previewClip && previewClip.id === currentClip?.id && !previewClip.audioBlobId) {
        const seconds = (performance.now() - startedAt) / 1000;
        if (seconds > 0) onPreviewDurationMeasured?.(previewClip, seconds);
      }
    });
  });

  const rateMinusButton = new Container();
  rateMinusButton.eventMode = "static";
  rateMinusButton.cursor = "pointer";
  const rateMinusBg = new Graphics();
  const rateMinusLabel = new Text({
    text: "\u2212",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  rateMinusLabel.position.set(7, 3);
  rateMinusBg.eventMode = "static";
  rateMinusBg.cursor = "pointer";
  drawButton(rateMinusBg, 20, 20, false, false);
  rateMinusButton.addChild(rateMinusBg, rateMinusLabel);
  root.addChild(rateMinusButton);
  rateMinusButton.on("pointerover", () => drawButton(rateMinusBg, 20, 20, true, false));
  rateMinusButton.on("pointerout", () => drawButton(rateMinusBg, 20, 20, false, false));
  rateMinusButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    rate = Math.max(RATE_MIN, Math.round((rate - RATE_STEP) * 100) / 100);
    rateLabel.text = `${rate.toFixed(2)}x`;
  });

  const rateLabel = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  root.addChild(rateLabel);

  const ratePlusButton = new Container();
  ratePlusButton.eventMode = "static";
  ratePlusButton.cursor = "pointer";
  const ratePlusBg = new Graphics();
  const ratePlusLabel = new Text({
    text: "+",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  ratePlusLabel.position.set(6, 3);
  ratePlusBg.eventMode = "static";
  ratePlusBg.cursor = "pointer";
  drawButton(ratePlusBg, 20, 20, false, false);
  ratePlusButton.addChild(ratePlusBg, ratePlusLabel);
  root.addChild(ratePlusButton);
  ratePlusButton.on("pointerover", () => drawButton(ratePlusBg, 20, 20, true, false));
  ratePlusButton.on("pointerout", () => drawButton(ratePlusBg, 20, 20, false, false));
  ratePlusButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    rate = Math.min(RATE_MAX, Math.round((rate + RATE_STEP) * 100) / 100);
    rateLabel.text = `${rate.toFixed(2)}x`;
  });

  const generateButton = new Container();
  generateButton.eventMode = "static";
  generateButton.cursor = "pointer";
  const generateBg = new Graphics();
  const generateLabel = new Text({
    text: "generate",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xffffff },
    resolution: TEXT_RESOLUTION,
  });
  generateLabel.position.set(10, 5);
  generateBg.eventMode = "static";
  generateBg.cursor = "pointer";
  generateButton.addChild(generateBg, generateLabel);
  root.addChild(generateButton);
  generateButton.on("pointerover", () => drawButton(generateBg, Math.max(70, generateLabel.width + 20), 24, true, generating));
  generateButton.on("pointerout", () => drawButton(generateBg, Math.max(70, generateLabel.width + 20), 24, false, generating));
  generateButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    void handleGenerate();
  });

  const errorText = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: 0xef4444, wordWrap: true },
    resolution: TEXT_RESOLUTION,
  });
  root.addChild(errorText);

  async function handleGenerate(): Promise<void> {
    if (generating || !currentClip) {
      log.debug(TAG, `handleGenerate ignored (generating=${generating}, hasClip=${!!currentClip})`);
      return;
    }
    const text = input.value.trim();
    if (!text) {
      errorMessage = "enter some text first";
      layout();
      return;
    }
    const clipId = currentClip.id;
    generating = true;
    errorMessage = "";
    layout();
    log.debug(TAG, `generating tts for clip ${clipId} (voice=${voiceName}, rate=${rate}, chars=${text.length})`);
    try {
      const result = await generateTtsAudio(text, voiceName === VOICE_DEFAULT ? "" : voiceName, rate);
      log.debug(TAG, `generated ok for clip ${clipId}: blobId=${result.blobId || "(empty)"} duration=${result.duration}`);
      if (!result.blobId) {
        errorMessage = "generation returned no audio — is the tauri app up to date?";
        return;
      }
      const names = listVoiceNames();
      const lang = names.includes(voiceName) ? voiceName : "";
      onClipGenerate(currentClip, text, result, voiceName === VOICE_DEFAULT ? "" : voiceName, lang, rate);
    } catch (err) {
      log.error(TAG, `generate failed for clip ${clipId}: ${err instanceof Error ? err.message : String(err)}`);
      errorMessage = err instanceof Error ? err.message : "generation failed";
    } finally {
      generating = false;
      layout();
    }
  }

  function layout(): void {
    const w = lastWidth;
    input.setWidth(Math.max(40, w));
    input.input.x = 0;
    input.input.y = 0;

    let by = 44;

    // preview (speechSynthesis) is always available, unlike `generate` below
    previewButton.x = 0;
    previewButton.y = by;
    by += 20 + 4;

    const generateAvailable = isGenerateAvailable();
    voiceButton.visible = generateAvailable;
    rateMinusButton.visible = generateAvailable;
    rateLabel.visible = generateAvailable;
    ratePlusButton.visible = generateAvailable;
    generateButton.visible = generateAvailable;

    if (generateAvailable) {
      voiceButton.x = 0;
      voiceButton.y = by;
      const voiceW = Math.max(70, voiceLabel.width + 12);
      rateMinusButton.x = voiceW + 6;
      rateMinusButton.y = by;
      rateLabel.text = `${rate.toFixed(2)}x`;
      rateLabel.x = rateMinusButton.x + 24;
      rateLabel.y = by + 4;
      ratePlusButton.x = rateLabel.x + rateLabel.width + 8;
      ratePlusButton.y = by;

      generateLabel.text = generating ? "generating\u2026" : "generate";
      const genW = Math.max(70, generateLabel.width + 20);
      drawButton(generateBg, genW, 24, false, generating);
      generateButton.x = Math.max(0, w - genW);
      generateButton.y = by;
      generateButton.eventMode = generating ? "none" : "static";
      by += 24 + 4;
    }

    errorText.text = errorMessage;
    errorText.style.wordWrapWidth = Math.max(1, w);
    errorText.x = 0;
    errorText.y = by;
  }

  return {
    root,
    input,
    bind(clip: AudioClip, width: number, y: number) {
      root.y = y;
      lastWidth = width;
      const isSameClip = currentClip?.id === clip.id;
      currentClip = clip;
      if (!isSameClip) {
        // a clip that's never had a voice explicitly set (brand new) defaults
        // to whichever voice was last picked, in any clip's voice picker —
        // not always back to VOICE_DEFAULT.
        voiceName = clip.ttsVoiceName || loadLastVoiceName();
        rate = clip.ttsRate ?? 1;
        errorMessage = "";
        generating = false;
        if (previewing) {
          cancelPreview();
          previewing = false;
        }
        layoutVoiceButton();
        layoutPreviewButton();
      }
      if (!input.isEditing && input.value !== (clip.ttsText ?? "")) {
        input.value = clip.ttsText ?? "";
      }
      layout();
    },
    destroy() {
      if (previewing) cancelPreview();
      input.destroy();
    },
  };
}

export function createSegmentsPanel(options: SegmentsPanelOptions): SegmentsPanelHandle {
  const {
    canvasElement,
    getEditableSegments,
    getTranscriptSegments,
    getReferenceSpeakers,
    getAudioClips,
    onSeek,
    onClipTextCommit,
    onClipGenerate,
    onPreviewDurationMeasured,
    storageKey,
    onOpenVoicePicker,
    getAutoScrollEnabled,
    initialHeight,
  } = options;

  let prefs = loadPrefs(storageKey);
  let contentWidth = 0;
  let panelHeight = initialHeight ?? SEGMENTS_PANEL_HEIGHT;
  let currentSegments: PanelSegment[] = [];
  let rowTops: number[] = [];
  let lastAutoScrolledIndex = -1;
  let selectedSegment: EditableSegment | null = null;
  let selectedClipId: string | null = null;

  const container = new Container();

  const bg = new Graphics();
  container.addChild(bg);

  // -- view-mode toggling (triggered externally now \u2014 see `toggleViewMode()`
  // on the returned handle \u2014 by clicking a track's own label in
  // `video-timeline.ts`/`reference-track.ts` rather than an in-panel flyout) --

  function toggleMode(mode: SegmentsViewMode): void {
    const active = new Set(prefs.viewModes);
    if (active.has(mode)) {
      if (active.size === 1) return; // keep at least one source visible
      active.delete(mode);
    } else {
      active.add(mode);
    }
    prefs = { ...prefs, viewModes: ALL_MODE_IDS.filter((id) => active.has(id)) };
    savePrefs(storageKey, prefs);
    lastAutoScrolledIndex = -1;
    redraw();
  }

  // -- scrollable row list -------------------------------------------------------

  const listY = 0;
  let listVisibleHeight = panelHeight - listY;
  const scrollable: ScrollableContent = createScrollableContent(
    container,
    canvasElement,
    0,
    listY,
    Math.max(1, contentWidth),
    listVisibleHeight
  );

  const emptyText = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0x888888 },
    resolution: TEXT_RESOLUTION,
  });
  scrollable.content.addChild(emptyText);

  interface Row {
    container: Container;
    bg: Graphics;
    timeText: Text;
    metaText: Text;
    refText: Text;
    pillBg: Graphics;
    pillText: Text;
    /** lazily-created inline authoring controls, only for audio-clip rows */
    audio: AudioRowExtras | null;
  }
  const rowPool: Row[] = [];

  function rowAt(i: number): Row {
    while (rowPool.length <= i) {
      const rowContainer = new Container();
      rowContainer.eventMode = "static";
      rowContainer.cursor = "pointer";
      const rowBg = new Graphics();
      // the seek-on-tap gesture lives on `rowBg` itself, not `rowContainer` — a
      // container-wide `hitArea` (used by the plain cutlist/reference rows,
      // see `layoutRow()`) makes pixi hit-test that rectangle directly and
      // skip recursing into children entirely, which would swallow clicks
      // meant for an audio-clip row's inline buttons/input underneath it.
      rowBg.eventMode = "static";
      rowBg.cursor = "pointer";
      const timeText = new Text({
        text: "",
        style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0x999999 },
        resolution: TEXT_RESOLUTION,
      });
      const metaText = new Text({
        text: "",
        style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: 0x888888, letterSpacing: 0.3 },
        resolution: TEXT_RESOLUTION,
      });
      metaText.anchor.set(1, 0);
      const refText = new Text({
        text: "",
        style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xbbbbbb, wordWrap: true, lineHeight: 14 },
        resolution: TEXT_RESOLUTION,
      });
      const pillBg = new Graphics();
      const pillText = new Text({
        text: "",
        style: { fontFamily: FONT_FAMILY, fontSize: 9, fontWeight: "600" },
        resolution: TEXT_RESOLUTION,
      });
      pillText.anchor.set(0.5);
      rowContainer.addChild(rowBg, timeText, metaText, refText, pillBg, pillText);
      scrollable.content.addChild(rowContainer);
      const row: Row = { container: rowContainer, bg: rowBg, timeText, metaText, refText, pillBg, pillText, audio: null };
      rowPool.push(row);
    }
    return rowPool[i];
  }

  function ensureAudioExtras(row: Row): AudioRowExtras {
    if (!row.audio) {
      const extras = createAudioRowExtras(
        canvasElement,
        onClipTextCommit,
        onClipGenerate,
        onOpenVoicePicker,
        onPreviewDurationMeasured
      );
      row.container.addChild(extras.root);
      row.audio = extras;
    }
    return row.audio;
  }

  function layoutRow(row: Row, seg: PanelSegment, y: number): void {
    const w = Math.max(1, contentWidth);
    row.container.y = y;
    row.container.visible = true;
    row.container.hitArea = new Rectangle(0, 0, w, ROW_HEIGHT);
    row.container.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      onSeek(seg.start);
    });
    // clear any seek listener a prior audio-clip-row layout put directly on
    // `bg` (see `layoutAudioClipRow`) — harmless no-op if never registered,
    // but avoids a stale handler lingering on a reused pooled row.
    row.bg.off("pointertap");
    row.refText.visible = true;
    if (row.audio) row.audio.root.visible = false;

    row.bg.clear();
    const isSelected =
      prefs.viewModes.includes("cutlist") &&
      selectedSegment !== null &&
      selectedSegment[0] === seg.start &&
      selectedSegment[1] === seg.end &&
      seg.source === "cut list";
    row.bg
      .roundRect(0, 0, w, ROW_HEIGHT, 6)
      .fill({ color: isSelected ? 0x2a2233 : 0x222222 })
      .stroke({ width: isSelected ? 2 : 1, color: isSelected ? MAGENTA : 0x333333 });

    row.timeText.text = `${formatTime(seg.start)} \u2013 ${formatTime(seg.end)}`;
    row.timeText.x = ROW_PAD_X;
    row.timeText.y = 6;

    const pillY = 6;
    const pillHeight = 14;
    if (seg.speakerName && seg.speakerColor !== undefined) {
      row.pillText.text = seg.speakerName;
      row.pillText.style.fill = contrastTextColor(seg.speakerColor);
      const pillPadX = 6;
      const pillWidth = Math.ceil(row.pillText.width) + pillPadX * 2;
      const pillX = w - ROW_PAD_X - pillWidth;
      row.pillBg.clear().roundRect(0, 0, pillWidth, pillHeight, 3).fill({ color: seg.speakerColor });
      row.pillBg.x = pillX;
      row.pillBg.y = pillY;
      row.pillBg.visible = true;
      row.pillText.x = pillX + pillWidth / 2;
      row.pillText.y = pillY + pillHeight / 2;
      row.pillText.visible = true;

      row.metaText.text = `${seg.source} \u00b7 `;
      row.metaText.anchor.set(1, 0.5);
      row.metaText.x = pillX - 4;
      row.metaText.y = pillY + pillHeight / 2;
    } else {
      row.pillBg.visible = false;
      row.pillText.visible = false;
      row.metaText.anchor.set(1, 0);
      row.metaText.text = seg.speakerName ? `${seg.source} \u00b7 ${seg.speakerName}` : seg.source;
      row.metaText.x = w - ROW_PAD_X;
      row.metaText.y = 6;
    }

    row.refText.text = seg.text || "(no matching transcript text)";
    row.refText.style.wordWrapWidth = Math.max(1, w - ROW_PAD_X * 2);
    row.refText.x = ROW_PAD_X;
    row.refText.y = 22;
  }

  function layoutAudioClipRow(row: Row, seg: PanelSegment, y: number): void {
    const w = Math.max(1, contentWidth);
    const clip = seg.clip;
    if (!clip) return;
    row.container.y = y;
    row.container.visible = true;
    // no container-wide hitArea here (see the `rowBg` comment in `rowAt()`) —
    // the seek gesture lives on the background graphic instead, so the
    // inline audio-authoring buttons/input on top of it stay clickable.
    row.container.hitArea = null;
    row.container.off("pointertap");
    row.bg.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      onSeek(seg.start);
    });
    row.pillBg.visible = false;
    row.pillText.visible = false;
    row.refText.visible = false;

    row.bg.clear();
    const isSelected = selectedClipId !== null && selectedClipId === clip.id;
    row.bg
      .roundRect(0, 0, w, AUDIO_ROW_HEIGHT, 6)
      .fill({ color: isSelected ? 0x2a2233 : 0x222222 })
      .stroke({ width: isSelected ? 2 : 1, color: isSelected ? MAGENTA : 0x333333 });

    row.timeText.text = `${formatTime(seg.start)} \u2013 ${formatTime(seg.end)}`;
    row.timeText.x = ROW_PAD_X;
    row.timeText.y = 6;

    row.metaText.anchor.set(1, 0);
    row.metaText.text = clip.audioBlobId ? "audio clip \u00b7 recorded" : "audio clip \u00b7 pending";
    row.metaText.x = w - ROW_PAD_X;
    row.metaText.y = 6;

    const extras = ensureAudioExtras(row);
    extras.root.visible = true;
    extras.root.x = ROW_PAD_X;
    extras.bind(clip, Math.max(1, w - ROW_PAD_X * 2), 24);
  }

  function rowHeightFor(seg: PanelSegment): number {
    return seg.source === "audio clip" ? AUDIO_ROW_HEIGHT : ROW_HEIGHT;
  }

  function redraw(): void {
    const modes = new Set(prefs.viewModes);
    currentSegments = buildPanelSegments(
      modes,
      getEditableSegments(),
      getTranscriptSegments(),
      getReferenceSpeakers(),
      getAudioClips()
    );

    emptyText.visible = currentSegments.length === 0;
    emptyText.text = modes.has("cutlist")
      ? "no cut segments yet"
      : modes.has("audioclips")
        ? "no audio clips yet"
        : "no reference data loaded yet";
    emptyText.x = ROW_PAD_X;
    emptyText.y = 8;

    let y = 0;
    rowTops = [];
    currentSegments.forEach((seg, i) => {
      rowTops.push(y);
      const row = rowAt(i);
      if (seg.source === "audio clip") layoutAudioClipRow(row, seg, y);
      else layoutRow(row, seg, y);
      y += rowHeightFor(seg) + ROW_GAP;
    });
    for (let i = currentSegments.length; i < rowPool.length; i++) {
      rowPool[i].container.visible = false;
      if (rowPool[i].audio) rowPool[i].audio!.root.visible = false;
    }

    const totalHeight = currentSegments.length > 0 ? y - ROW_GAP : emptyText.height;
    scrollable.reflow(Math.max(1, contentWidth), Math.max(1, totalHeight));
  }

  function scrollRowIntoView(index: number): void {
    const seg = currentSegments[index];
    if (!seg) return;
    const rowTop = rowTops[index] ?? 0;
    const rowBottom = rowTop + rowHeightFor(seg);
    const current = scrollable.getScrollY();
    let target = current;
    if (rowTop < current) target = rowTop;
    else if (rowBottom > current + listVisibleHeight) target = rowBottom - listVisibleHeight;
    if (target !== current) scrollable.scrollToY(Math.max(0, target));
  }

  redraw();

  return {
    container,

    refresh() {
      redraw();
    },

    resize(width: number, height?: number) {
      contentWidth = Math.max(0, width);
      if (height !== undefined) {
        panelHeight = Math.max(1, height);
        listVisibleHeight = panelHeight - listY;
      }
      bg.clear();
      bg.roundRect(0, 0, contentWidth, panelHeight, 6).fill({ color: 0x1e1e1e }).stroke({
        width: 1,
        color: 0x333333,
      });
      scrollable.resize(Math.max(1, contentWidth), listVisibleHeight);
      redraw();
    },

    onTimeUpdate(currentTime: number) {
      if (!getAutoScrollEnabled()) return;
      const index = findActiveSegmentIndex(currentSegments, currentTime);
      if (index === -1 || index === lastAutoScrolledIndex) return;
      lastAutoScrolledIndex = index;
      scrollRowIntoView(index);
    },

    setSelectedSegment(seg: EditableSegment | null) {
      selectedSegment = seg;
      redraw();
      if (seg && prefs.viewModes.includes("cutlist")) {
        const index = currentSegments.findIndex(
          (s) => s.source === "cut list" && s.start === seg[0] && s.end === seg[1]
        );
        if (index !== -1) scrollRowIntoView(index);
      }
    },

    setSelectedClip(clipId: string | null) {
      selectedClipId = clipId;
      redraw();
      if (clipId && prefs.viewModes.includes("audioclips")) {
        const index = currentSegments.findIndex((s) => s.source === "audio clip" && s.clip?.id === clipId);
        if (index !== -1) scrollRowIntoView(index);
      }
    },

    toggleViewMode(mode: SegmentsViewMode) {
      toggleMode(mode);
    },

    isViewModeActive(mode: SegmentsViewMode) {
      return prefs.viewModes.includes(mode);
    },

    destroy() {
      // `scrollable.destroy()` removes its document-level wheel listener —
      // not covered by pixi's own destroy cascade below. everything else
      // (rows, the scrollBox itself) is a descendant of `container`, so one
      // recursive destroy handles it.
      for (const row of rowPool) row.audio?.destroy();
      scrollable.destroy();
      container.destroy({ children: true });
    },
  };
}

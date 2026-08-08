/**
 * stfu's per-clip "author this audio clip" popover — opened by tapping a
 * pending (audio-less) row on the audio-clips track. offers the tts-text
 * authoring path (item 4c of docs/stfu-widget-plan.md's "audio clip
 * authoring" checklist item): type text, pick a voice + rate, hit
 * "generate" to call the same `tts_generate` tauri dispatch the tts widget
 * itself uses (via `generateTtsAudio()`), and the resulting blob is written
 * straight onto this clip.
 *
 * the other two authoring paths from that checklist item are already
 * covered elsewhere and are NOT duplicated here: recording fresh audio is
 * done by placing an `audio-recording` widget and dragging it onto the
 * track ("widget → track" drag, see stfu/index.ts's dropTarget), and
 * generating via a fully-featured tts widget (voice preview, rate slider,
 * etc.) is likewise done by placing a `tts` widget and dragging it over.
 * this panel is deliberately minimal — just enough to author a clip
 * in place without leaving the track.
 *
 * mirrors reference-track.ts's `createExpandingPanel()` popover pattern.
 */

import { Container, Graphics, Text } from "pixi.js";
import { createExpandingPanel, type ExpandingPanelHandle } from "../../src/widgets/expanding-panel";
import { createSkeinInput, type SkeinInputHandle } from "../../src/widgets/skein-input";
import { isGenerateAvailable, listVoiceNames, VOICE_DEFAULT } from "../tts/voices";
import { generateTtsAudio, type TtsGenerateResult } from "../tts/generate";
import type { AudioClip } from "./types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;
const PANEL_WIDTH = 260;
const PAD = 10;
const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.25;

export interface ClipEditorPanelOptions {
  /** covers/dismisses over this container's own local bounds — pass the
   *  widget's own topmost content container (same convention as
   *  reference-track.ts's `overlayParent`). */
  overlayParent: Container;
  /** needed by the underlying `createSkeinInput()` DOM overlay. */
  canvasElement: HTMLCanvasElement;
  /** called once generation succeeds — caller writes the result onto the
   *  clip's doc fields and closes the panel. */
  onGenerated: (
    clip: AudioClip,
    text: string,
    result: TtsGenerateResult,
    voiceName: string,
    voiceLang: string,
    rate: number,
  ) => void;
}

export interface ClipEditorPanelHandle {
  /** open the panel anchored at (x, y) in `overlayParent`'s local space,
   *  pre-filled from the given clip's current tts fields. */
  open(clip: AudioClip, x: number, y: number): void;
  close(): void;
  destroy(): void;
}

export function createClipEditorPanel(options: ClipEditorPanelOptions): ClipEditorPanelHandle {
  const { overlayParent, canvasElement, onGenerated } = options;

  let currentClip: AudioClip | null = null;
  let voiceName = VOICE_DEFAULT;
  let rate = 1;
  let generating = false;
  let errorMessage = "";

  const panel = new Container();
  const bg = new Graphics();
  const title = new Text({
    text: "clip text",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0x9ca3af },
    resolution: TEXT_RESOLUTION,
  });
  const voiceButton = new Container();
  const voiceBg = new Graphics();
  const voiceLabel = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  const rateMinusButton = new Container();
  const rateMinusBg = new Graphics();
  const ratePlusButton = new Container();
  const ratePlusBg = new Graphics();
  const rateLabel = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  const generateButton = new Container();
  const generateBg = new Graphics();
  const generateLabel = new Text({
    text: "generate",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0xffffff },
    resolution: TEXT_RESOLUTION,
  });
  const errorText = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xef4444, wordWrap: true, wordWrapWidth: PANEL_WIDTH - PAD * 2 },
    resolution: TEXT_RESOLUTION,
  });

  let textInput: SkeinInputHandle | null = null;

  function drawButton(g: Graphics, w: number, h: number, hovered: boolean, disabled: boolean): void {
    g.clear();
    const color = disabled ? 0x2a2a2a : hovered ? 0x3a3a52 : 0x2a2a3e;
    g.roundRect(0, 0, w, h, 4).fill({ color });
  }

  function cycleVoice(dir: 1 | -1): void {
    const names = listVoiceNames();
    const idx = names.indexOf(voiceName);
    const next = names[(idx + dir + names.length) % names.length] ?? VOICE_DEFAULT;
    voiceName = next;
    voiceLabel.text = `voice: ${voiceName}`;
  }

  voiceBg.eventMode = "static";
  voiceBg.cursor = "pointer";
  voiceButton.addChild(voiceBg, voiceLabel);
  voiceButton.on("pointerover", () => drawButton(voiceBg, voiceButton.width || 100, 22, true, false));
  voiceButton.on("pointerout", () => drawButton(voiceBg, voiceButton.width || 100, 22, false, false));
  voiceButton.on("pointertap", (e) => {
    e.stopPropagation();
    cycleVoice(1);
    layoutVoiceButton();
  });

  function layoutVoiceButton(): void {
    voiceLabel.x = 8;
    voiceLabel.y = 4;
    const w = Math.max(100, voiceLabel.width + 16);
    drawButton(voiceBg, w, 22, false, false);
  }

  rateMinusBg.eventMode = "static";
  rateMinusBg.cursor = "pointer";
  const rateMinusLabel = new Text({
    text: "\u2212",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  rateMinusLabel.x = 8;
  rateMinusLabel.y = 3;
  rateMinusButton.addChild(rateMinusBg, rateMinusLabel);
  drawButton(rateMinusBg, 22, 22, false, false);
  rateMinusButton.on("pointerover", () => drawButton(rateMinusBg, 22, 22, true, false));
  rateMinusButton.on("pointerout", () => drawButton(rateMinusBg, 22, 22, false, false));
  rateMinusButton.on("pointertap", (e) => {
    e.stopPropagation();
    rate = Math.max(RATE_MIN, Math.round((rate - RATE_STEP) * 100) / 100);
    rateLabel.text = `${rate.toFixed(2)}x`;
  });

  ratePlusBg.eventMode = "static";
  ratePlusBg.cursor = "pointer";
  const ratePlusLabel = new Text({
    text: "+",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0xe2e2e2 },
    resolution: TEXT_RESOLUTION,
  });
  ratePlusLabel.x = 7;
  ratePlusLabel.y = 3;
  ratePlusButton.addChild(ratePlusBg, ratePlusLabel);
  drawButton(ratePlusBg, 22, 22, false, false);
  ratePlusButton.on("pointerover", () => drawButton(ratePlusBg, 22, 22, true, false));
  ratePlusButton.on("pointerout", () => drawButton(ratePlusBg, 22, 22, false, false));
  ratePlusButton.on("pointertap", (e) => {
    e.stopPropagation();
    rate = Math.min(RATE_MAX, Math.round((rate + RATE_STEP) * 100) / 100);
    rateLabel.text = `${rate.toFixed(2)}x`;
  });

  generateBg.eventMode = "static";
  generateBg.cursor = "pointer";
  generateButton.addChild(generateBg, generateLabel);
  generateLabel.x = 10;
  generateLabel.y = 5;
  generateButton.on("pointerover", () => drawButton(generateBg, generateButton.width || 90, 26, true, generating));
  generateButton.on("pointerout", () => drawButton(generateBg, generateButton.width || 90, 26, false, generating));
  generateButton.on("pointertap", (e) => {
    e.stopPropagation();
    void handleGenerate();
  });

  async function handleGenerate(): Promise<void> {
    if (generating || !currentClip) return;
    const text = textInput?.value.trim() ?? "";
    if (!text) {
      errorMessage = "enter some text first";
      layout();
      return;
    }
    generating = true;
    errorMessage = "";
    layout();
    try {
      const result = await generateTtsAudio(text, voiceName === VOICE_DEFAULT ? "" : voiceName, rate);
      const names = listVoiceNames();
      const lang = names.includes(voiceName) ? voiceName : "";
      onGenerated(currentClip, text, result, voiceName === VOICE_DEFAULT ? "" : voiceName, lang, rate);
      close();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "generation failed";
    } finally {
      generating = false;
      layout();
    }
  }

  function layout(): void {
    const generateAvailable = isGenerateAvailable();
    let y = PAD;
    title.x = PAD;
    title.y = y;
    y += title.height + 4;

    if (textInput) {
      textInput.input.x = PAD;
      textInput.input.y = y;
      y += 56 + 8;
    }

    layoutVoiceButton();
    voiceButton.x = PAD;
    voiceButton.y = y;
    rateMinusButton.x = PAD + (voiceButton.width || 100) + 6;
    rateMinusButton.y = y;
    rateLabel.text = `${rate.toFixed(2)}x`;
    rateLabel.x = rateMinusButton.x + 22 + 6;
    rateLabel.y = y + 4;
    ratePlusButton.x = rateLabel.x + rateLabel.width + 6;
    ratePlusButton.y = y;
    y += 22 + 8;

    voiceButton.visible = generateAvailable;
    rateMinusButton.visible = generateAvailable;
    ratePlusButton.visible = generateAvailable;
    rateLabel.visible = generateAvailable;

    generateButton.visible = generateAvailable;
    if (generateAvailable) {
      generateLabel.text = generating ? "generating\u2026" : "generate";
      const w = Math.max(90, generateLabel.width + 20);
      drawButton(generateBg, w, 26, false, generating);
      generateButton.x = PAD;
      generateButton.y = y;
      generateButton.eventMode = generating ? "none" : "static";
      y += 26 + 6;
    } else {
      title.text = "clip text (no tts generation backend available)";
    }

    errorText.text = errorMessage;
    errorText.x = PAD;
    errorText.y = y;
    if (errorMessage) y += errorText.height + 6;

    const panelHeight = y + PAD;
    bg.clear();
    bg.roundRect(0, 0, PANEL_WIDTH, panelHeight, 6).fill({ color: 0x1e1e1e }).stroke({ width: 1, color: 0x333333 });
    expandingPanel.resize(PANEL_WIDTH, panelHeight);
  }

  panel.addChild(bg, title, voiceButton, rateMinusButton, rateLabel, ratePlusButton, generateButton, errorText);

  const expandingPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent,
    panel,
    onOpenChange: (isOpen) => {
      if (!isOpen) {
        textInput?.destroy();
        textInput = null;
        currentClip = null;
      }
    },
  });

  function close(): void {
    expandingPanel.close();
  }

  return {
    open(clip: AudioClip, x: number, y: number) {
      currentClip = clip;
      voiceName = clip.ttsVoiceName || VOICE_DEFAULT;
      rate = clip.ttsRate ?? 1;
      errorMessage = "";
      generating = false;

      textInput?.destroy();
      textInput = createSkeinInput({
        canvasElement,
        width: PANEL_WIDTH - PAD * 2,
        height: 56,
        placeholder: "what should this clip say?",
        value: clip.ttsText ?? "",
        fontSize: 12,
      });
      panel.addChild(textInput.input);

      panel.x = x;
      panel.y = y;
      layout();
      expandingPanel.open();
      textInput.focus();
    },
    close,
    destroy() {
      textInput?.destroy();
      textInput = null;
      expandingPanel.destroy();
    },
  };
}

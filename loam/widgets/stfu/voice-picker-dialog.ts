/**
 * stfu's tts voice picker — a full-widget modal (unlike the always-visible
 * inline audio-clip-row controls it's opened from) so there's enough room
 * to list every available voice with its own "preview" action, auditioned
 * against the clip's own (editable, carried-in) text. opened externally via
 * `open()` from `segments-panel.ts`'s per-row voice button; mirrors
 * `keyboard-shortcuts-control.ts`'s expanding-panel-centered-in-the-widget
 * pattern, but sized/positioned against the *whole* widget (not just the
 * timeline shell) since the segments panel alone isn't tall enough to hold
 * a scrollable voice list.
 */

import { Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from "pixi.js";
import { createExpandingPanel, type ExpandingPanelHandle } from "../../src/widgets/expanding-panel";
import { createScrollableContent, type ScrollableContent } from "../../src/widgets/scrollable-content";
import { createSkeinInput, type SkeinInputHandle } from "../../src/widgets/skein-input";
import { cancelPreview, langForVoiceName, listVoiceNames, speakPreview, VOICE_DEFAULT } from "../tts/voices";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;
const MAGENTA = 0xe619b3;

const DIALOG_WIDTH = 360;
const DIALOG_PAD = 12;
const ROW_HEIGHT = 30;
const ROW_GAP = 4;
const TEXT_INPUT_Y = 34;
const LIST_Y = TEXT_INPUT_Y + 30 + 10;
const MAX_LIST_HEIGHT = 280;

export interface VoicePickerOpenOptions {
  /** the clip's current text — previewed aloud, and editable in-dialog. */
  text: string;
  /** "" means the system/browser default voice. */
  currentVoiceName: string;
  rate: number;
  /** fires as the dialog's own text field changes, so edits made while
   *  auditioning voices are reflected back in the row (and previewed with). */
  onTextChange?: (text: string) => void;
  onSelectVoice: (voiceName: string) => void;
}

export interface VoicePickerDialogOptions {
  /** widget-root container — the dialog covers the *whole* widget, not just
   *  the timeline shell or segments panel, so mount it high enough to. */
  overlayParent: Container;
  canvasElement: HTMLCanvasElement;
  /** fires as the dialog opens/closes — the widget's DOM video overlay sits
   *  above pixi content (a real `<video>` element, `z-index: 15000`), so it
   *  would otherwise visually cover this dialog; the caller uses this to
   *  pause + hide it while the dialog is open. */
  onOpenChange?: (open: boolean) => void;
}

export interface VoicePickerDialogHandle {
  /** call with the full widget's current (width, height) on mount/resize. */
  resize(width: number, height: number): void;
  open(opts: VoicePickerOpenOptions): void;
  destroy(): void;
}

export function createVoicePickerDialog(options: VoicePickerDialogOptions): VoicePickerDialogHandle {
  const { overlayParent, canvasElement, onOpenChange } = options;

  let current: VoicePickerOpenOptions | null = null;
  let previewingVoice: string | null = null;
  let overlayWidth = 0;
  let overlayHeight = 0;

  const panel = new Container();
  panel.eventMode = "static";
  panel.on("pointerdown", (e) => e.stopPropagation());

  const panelBg = new Graphics();
  panel.addChild(panelBg);

  const titleText = new Text({
    text: "choose a voice",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fontWeight: "700", fill: 0xffffff },
    resolution: TEXT_RESOLUTION,
  });
  titleText.position.set(DIALOG_PAD, 10);
  panel.addChild(titleText);

  const closeButton = new Container();
  closeButton.eventMode = "static";
  closeButton.cursor = "pointer";
  const closeLabel = new Text({
    text: "\u2715",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0x999999 },
    resolution: TEXT_RESOLUTION,
  });
  closeButton.addChild(closeLabel);
  panel.addChild(closeButton);
  closeButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    expandingPanel.close();
  });

  const input: SkeinInputHandle = createSkeinInput({
    canvasElement,
    width: DIALOG_WIDTH - DIALOG_PAD * 2,
    height: 30,
    placeholder: "text to preview...",
    fontSize: 11,
    onChange: (v) => current?.onTextChange?.(v),
  });
  input.input.x = DIALOG_PAD;
  input.input.y = TEXT_INPUT_Y;
  panel.addChild(input.input);

  const scrollable: ScrollableContent = createScrollableContent(
    panel,
    canvasElement,
    DIALOG_PAD,
    LIST_Y,
    DIALOG_WIDTH - DIALOG_PAD * 2,
    1
  );

  interface VoiceRow {
    container: Container;
    bg: Graphics;
    label: Text;
    previewButton: Container;
    previewBg: Graphics;
    previewLabel: Text;
  }
  const rowPool: VoiceRow[] = [];
  let currentNames: string[] = [];
  let rowWidth = DIALOG_WIDTH - DIALOG_PAD * 2;

  function rowAt(i: number): VoiceRow {
    while (rowPool.length <= i) {
      const rowContainer = new Container();
      rowContainer.eventMode = "static";
      rowContainer.cursor = "pointer";
      const rowBg = new Graphics();
      rowBg.eventMode = "static";
      const label = new Text({
        text: "",
        style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xe2e2e2 },
        resolution: TEXT_RESOLUTION,
      });
      const previewButton = new Container();
      previewButton.eventMode = "static";
      previewButton.cursor = "pointer";
      const previewBg = new Graphics();
      previewBg.eventMode = "static";
      const previewLabel = new Text({
        text: "\u25b6 preview",
        style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xe2e2e2 },
        resolution: TEXT_RESOLUTION,
      });
      previewButton.addChild(previewBg, previewLabel);
      rowContainer.addChild(rowBg, label, previewButton);
      scrollable.content.addChild(rowContainer);
      rowPool.push({ container: rowContainer, bg: rowBg, label, previewButton, previewBg, previewLabel });
    }
    return rowPool[i];
  }

  // re-run for every row (not just the clicked one) whenever `previewingVoice`
  // changes, so switching to a new voice's preview also resets the
  // previously-active row's button back to non-playing — otherwise it gets
  // stuck showing the "playing" state.
  function refreshPreviewButtons(): void {
    currentNames.forEach((name, i) => {
      if (i < rowPool.length) drawPreviewButton(rowPool[i], name);
    });
  }

  function drawPreviewButton(row: VoiceRow, voiceName: string): void {
    const isPreviewing = previewingVoice === voiceName;
    row.previewLabel.text = isPreviewing ? "\u25a0 stop" : "\u25b6 preview";
    row.previewLabel.position.set(6, 4);
    const w = Math.max(60, row.previewLabel.width + 12);
    row.previewBg.clear().roundRect(0, 0, w, 20, 4).fill({ color: isPreviewing ? MAGENTA : 0x3a3a3e });
    row.previewButton.x = rowWidth - w - 8;
    row.previewButton.y = (ROW_HEIGHT - 20) / 2;
  }

  function redrawRows(): void {
    if (!current) return;
    // the picker only ever previews via `speechSynthesis`, so restrict it to
    // english voices — non-english `say` voices are still selectable for
    // generation elsewhere, just not useful to audition text written in
    // english here.
    const names = listVoiceNames().filter(
      (name) => name === VOICE_DEFAULT || langForVoiceName(name).toLowerCase().startsWith("en")
    );
    currentNames = names;
    let y = 0;
    names.forEach((name, i) => {
      const row = rowAt(i);
      row.container.visible = true;
      row.container.y = y;
      const selected = (current?.currentVoiceName || VOICE_DEFAULT) === name;
      row.bg
        .clear()
        .roundRect(0, 0, rowWidth, ROW_HEIGHT, 4)
        .fill({ color: selected ? 0x2a2233 : 0x222222 })
        .stroke({ width: selected ? 2 : 1, color: selected ? MAGENTA : 0x333333 });
      row.label.text = name;
      row.label.position.set(10, (ROW_HEIGHT - row.label.height) / 2);
      row.container.hitArea = new Rectangle(0, 0, rowWidth, ROW_HEIGHT);
      drawPreviewButton(row, name);

      row.container.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        current?.onSelectVoice(name);
        expandingPanel.close();
      });
      row.previewButton.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        if (previewingVoice === name) {
          cancelPreview();
          previewingVoice = null;
          refreshPreviewButtons();
          return;
        }
        previewingVoice = name;
        refreshPreviewButtons();
        const text = input.value.trim() || "this is a voice preview";
        speakPreview(text, name === VOICE_DEFAULT ? "" : name, current?.rate ?? 1, () => {
          if (previewingVoice === name) {
            previewingVoice = null;
            refreshPreviewButtons();
          }
        });
      });

      y += ROW_HEIGHT + ROW_GAP;
    });
    for (let i = names.length; i < rowPool.length; i++) rowPool[i].container.visible = false;
    const contentHeight = names.length > 0 ? y - ROW_GAP : 0;
    scrollable.reflow(rowWidth, Math.max(1, contentHeight));

    const listHeight = Math.min(MAX_LIST_HEIGHT, Math.max(ROW_HEIGHT, contentHeight));
    scrollable.resize(rowWidth, listHeight);

    const panelHeight = LIST_Y + listHeight + DIALOG_PAD;
    panelBg
      .clear()
      .roundRect(0, 0, DIALOG_WIDTH, panelHeight, 8)
      .fill({ color: 0x222222 })
      .stroke({ width: 1, color: 0x3a3a3a });
    closeButton.x = DIALOG_WIDTH - 24;
    closeButton.y = 8;
    centerPanel(panelHeight);
  }

  function centerPanel(panelHeight: number): void {
    panel.x = Math.max(0, (overlayWidth - DIALOG_WIDTH) / 2);
    panel.y = Math.max(0, (overlayHeight - panelHeight) / 2);
  }

  const expandingPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent,
    panel,
    onOpenChange: (open) => {
      if (!open) {
        if (previewingVoice) cancelPreview();
        previewingVoice = null;
        current = null;
      }
      onOpenChange?.(open);
    },
  });

  return {
    resize(width: number, height: number) {
      overlayWidth = width;
      overlayHeight = height;
      expandingPanel.resize(width, height);
      if (expandingPanel.isOpen) redrawRows();
    },
    open(opts: VoicePickerOpenOptions) {
      current = opts;
      previewingVoice = null;
      input.value = opts.text;
      rowWidth = DIALOG_WIDTH - DIALOG_PAD * 2;
      redrawRows();
      expandingPanel.open();
    },
    destroy() {
      if (previewingVoice) cancelPreview();
      input.destroy();
      expandingPanel.destroy();
    },
  };
}

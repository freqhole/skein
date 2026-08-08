/**
 * stfu's reference/diarization track — renders per-speaker colored segments
 * (once reference data has been loaded, see `reference-data.ts` + the
 * "load reference data..." widget action in `index.ts`) into
 * `video-timeline.ts`'s `referenceContentLayer`, and a "REFERENCE" label
 * button that opens a speaker-visibility popover. direct design-port of
 * `editor.js`'s `rebuildReferenceGraphics()`/`createRefLabelButton()`/
 * `openSpeakerDialog()` — the popover itself is built with the generic
 * `expanding-panel.ts` helper (no full-modal dialog infra exists yet in
 * skein) rather than editor.js's own dialog system, but the row layout
 * (checkbox/swatch/label), "select all"/"clear all" buttons, and empty
 * state copy match it closely.
 *
 * this track needs zero reference data to mount cleanly — an empty track
 * row and an empty-state popover are both valid states.
 */

import { Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from "pixi.js";
import { createExpandingPanel, type ExpandingPanelHandle } from "../../src/widgets/expanding-panel";
import { REFERENCE_TRACK_HEIGHT, type VideoTimelineHandle } from "./video-timeline";
import type { ReferenceSpeaker, TranscriptSegment } from "./types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

// matches trek-minus-paris's --color-magenta custom property
const MAGENTA = 0xe619b3;

const MARGIN_Y = 4;
const LABEL_PAD_X = 8;
const DIALOG_WIDTH = 220;
const ROW_HEIGHT = 26;
const HEADER_BTN_HEIGHT = 24;
const HEADER_BTN_GAP = 8;

export interface ReferenceTrackOptions {
  timeline: VideoTimelineHandle;
  overlayParent: Container;
  getReferenceSpeakers: () => Record<string, ReferenceSpeaker>;
  getTranscriptSegments: () => TranscriptSegment[];
  /** localStorage key for the visible-speakers preference (browser-local UI
   *  state, mirrors editor.js's `trek-editor-visible-speakers`). */
  storageKey: string;
}

export interface ReferenceTrackHandle {
  /** re-draw segment graphics and the (if open) speaker popover — call
   *  after `referenceSpeakers`/`transcriptSegments` change for any reason. */
  refresh(): void;
  /** call whenever the widget's own width changes. */
  resize(contentWidth: number): void;
  destroy(): void;
}

function makeSecondaryButton(label: string, onClick: () => void): { container: Container; draw(width: number): void } {
  const container = new Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  const bg = new Graphics();
  const text = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 11, fill: 0xdddddd },
    resolution: TEXT_RESOLUTION,
  });
  text.anchor.set(0.5);
  container.addChild(bg, text);

  let currentWidth = 0;
  const paint = (color: number) => {
    bg.clear();
    bg.roundRect(0, 0, currentWidth, HEADER_BTN_HEIGHT, 4).fill({ color });
  };
  container.on("pointerover", () => paint(0x4a4a4a));
  container.on("pointerout", () => paint(0x3a3a3a));
  container.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onClick();
  });

  return {
    container,
    draw(width: number) {
      currentWidth = width;
      paint(0x3a3a3a);
      text.x = width / 2;
      text.y = HEADER_BTN_HEIGHT / 2;
      container.hitArea = new Rectangle(0, 0, width, HEADER_BTN_HEIGHT);
    },
  };
}

export function createReferenceTrack(options: ReferenceTrackOptions): ReferenceTrackHandle {
  const { timeline, overlayParent, getReferenceSpeakers, getTranscriptSegments, storageKey } = options;

  let contentWidth = 0;
  let visibleSpeakers = new Set<string>();
  let knownSpeakers: string[] = [];
  let initializedVisibility = false;

  function loadVisibility(): void {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return;
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) {
        visibleSpeakers = new Set(arr.filter((l): l is string => typeof l === "string"));
        initializedVisibility = true;
      }
    } catch {
      // malformed/unavailable storage — fall through to the "all visible" default
    }
  }

  function persistVisibility(): void {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...visibleSpeakers]));
    } catch {
      // private browsing / quota — not fatal, just doesn't persist
    }
  }

  loadVisibility();

  // -- segment graphics (pooled, redrawn from scratch on every refresh) --------

  const segmentPool: Graphics[] = [];

  function segmentGraphicsAt(i: number): Graphics {
    while (segmentPool.length <= i) {
      const g = new Graphics();
      timeline.referenceContentLayer.addChild(g);
      segmentPool.push(g);
    }
    return segmentPool[i];
  }

  function redrawSegments(): void {
    const speakers = getReferenceSpeakers();
    const segments = getTranscriptSegments();

    const allLabels = Object.keys(speakers).sort();
    if (!initializedVisibility) {
      visibleSpeakers = new Set(allLabels);
      initializedVisibility = true;
    }
    knownSpeakers = allLabels;

    let i = 0;
    for (const seg of segments) {
      if (!seg.speaker || !visibleSpeakers.has(seg.speaker)) continue;
      const x1 = timeline.timeToScreenX(seg.start);
      const x2 = timeline.timeToScreenX(seg.end);
      if (x2 < 0 || x1 > contentWidth) continue; // fully offscreen
      const w = Math.max(2, x2 - x1);
      const color = speakers[seg.speaker]?.color ?? 0x60a5fa;
      const g = segmentGraphicsAt(i++);
      g.clear();
      g.rect(0, MARGIN_Y, w, Math.max(1, REFERENCE_TRACK_HEIGHT - 2 * MARGIN_Y)).fill({ color, alpha: 0.55 });
      g.x = x1;
      g.visible = true;
    }
    for (; i < segmentPool.length; i++) segmentPool[i].visible = false;
  }

  const offViewChange = timeline.onViewChange(() => redrawSegments());

  // -- "REFERENCE" label button --------------------------------------------------

  const labelButton = new Container();
  labelButton.eventMode = "static";
  labelButton.cursor = "pointer";
  timeline.referenceHitArea.addChild(labelButton);

  const labelBorder = new Graphics();
  const labelText = new Text({
    text: "REFERENCE",
    style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: 0x888888, letterSpacing: 0.3 },
    resolution: TEXT_RESOLUTION,
  });
  labelText.anchor.set(0, 0.5);
  const caret = new Graphics();
  labelButton.addChild(labelBorder, labelText, caret);

  function drawLabelButton(hover: boolean): void {
    const caretW = 6;
    const caretH = 4;
    const gap = 5;
    const caretX = labelText.width + gap;
    caret.clear();
    caret
      .moveTo(caretX, -caretH / 2)
      .lineTo(caretX + caretW, -caretH / 2)
      .lineTo(caretX + caretW / 2, caretH / 2)
      .closePath()
      .fill({ color: 0x888888 });
    const totalW = caretX + caretW;
    const pad = 4;
    labelBorder.clear();
    if (hover) {
      labelBorder.roundRect(-pad, -8, totalW + pad * 2, 16, 3).stroke({ width: 1, color: 0x555555 });
    }
    labelButton.hitArea = new Rectangle(-pad, -8, totalW + pad * 2, 16);
  }
  drawLabelButton(false);
  labelButton.x = LABEL_PAD_X;
  labelButton.y = REFERENCE_TRACK_HEIGHT / 2;

  labelButton.on("pointerover", () => drawLabelButton(true));
  labelButton.on("pointerout", () => drawLabelButton(false));
  labelButton.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    expandingPanel.toggle();
    if (expandingPanel.isOpen) refreshPanel();
  });

  // -- speaker-visibility popover -------------------------------------------------

  const panel = new Container();
  const panelBg = new Graphics();
  panel.addChild(panelBg);

  const selectAllBtn = makeSecondaryButton("select all", () => {
    visibleSpeakers = new Set(knownSpeakers);
    onVisibleSpeakersChanged();
  });
  const clearAllBtn = makeSecondaryButton("clear all", () => {
    visibleSpeakers = new Set();
    onVisibleSpeakersChanged();
  });
  panel.addChild(selectAllBtn.container, clearAllBtn.container);

  const emptyText = new Text({
    text: "no diarization data found for this video",
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      fill: 0x888888,
      wordWrap: true,
      wordWrapWidth: DIALOG_WIDTH - LABEL_PAD_X * 2,
    },
    resolution: TEXT_RESOLUTION,
  });
  panel.addChild(emptyText);

  interface SpeakerRow {
    container: Container;
    bg: Graphics;
    checkbox: Graphics;
    swatch: Graphics;
    label: Text;
  }
  const rowPool: SpeakerRow[] = [];

  function rowAt(i: number): SpeakerRow {
    while (rowPool.length <= i) {
      const container = new Container();
      container.eventMode = "static";
      container.cursor = "pointer";
      const bg = new Graphics();
      const checkbox = new Graphics();
      const swatch = new Graphics();
      const label = new Text({
        text: "",
        style: { fontFamily: FONT_FAMILY, fontSize: 12, fill: 0xdddddd },
        resolution: TEXT_RESOLUTION,
      });
      container.addChild(bg, checkbox, swatch, label);
      panel.addChild(container);
      rowPool.push({ container, bg, checkbox, swatch, label });
    }
    return rowPool[i];
  }

  function onVisibleSpeakersChanged(): void {
    persistVisibility();
    redrawSegments();
    refreshPanel();
  }

  function refreshPanel(): void {
    const speakers = getReferenceSpeakers();
    const labels = Object.keys(speakers).sort();
    knownSpeakers = labels;

    const w = DIALOG_WIDTH;
    const btnW = (w - LABEL_PAD_X * 2 - HEADER_BTN_GAP) / 2;
    selectAllBtn.draw(btnW);
    clearAllBtn.draw(btnW);
    selectAllBtn.container.x = LABEL_PAD_X;
    selectAllBtn.container.y = LABEL_PAD_X;
    clearAllBtn.container.x = LABEL_PAD_X + btnW + HEADER_BTN_GAP;
    clearAllBtn.container.y = LABEL_PAD_X;

    const y = LABEL_PAD_X + HEADER_BTN_HEIGHT + LABEL_PAD_X;
    emptyText.visible = labels.length === 0;
    emptyText.x = LABEL_PAD_X;
    emptyText.y = y;

    labels.forEach((label, i) => {
      const row = rowAt(i);
      row.container.visible = true;
      row.container.x = LABEL_PAD_X;
      row.container.y = y + i * ROW_HEIGHT;
      row.container.hitArea = new Rectangle(0, 0, w - LABEL_PAD_X * 2, ROW_HEIGHT);

      const checked = visibleSpeakers.has(label);
      row.checkbox.clear();
      row.checkbox
        .roundRect(0, (ROW_HEIGHT - 14) / 2, 14, 14, 3)
        .fill({ color: checked ? MAGENTA : 0x1a1a1a })
        .stroke({ width: 1, color: checked ? MAGENTA : 0x555555 });
      if (checked) {
        row.checkbox
          .moveTo(3, ROW_HEIGHT / 2)
          .lineTo(6, ROW_HEIGHT / 2 + 3)
          .lineTo(11, ROW_HEIGHT / 2 - 4)
          .stroke({ width: 1.5, color: 0xffffff });
      }

      const color = speakers[label]?.color ?? 0x60a5fa;
      row.swatch.clear().roundRect(22, (ROW_HEIGHT - 10) / 2, 10, 10, 2).fill({ color });

      row.label.text = label;
      row.label.x = 40;
      row.label.y = (ROW_HEIGHT - row.label.height) / 2;

      row.bg.clear();
      row.container.off("pointerover").on("pointerover", () => {
        row.bg.clear().rect(0, 0, w - LABEL_PAD_X * 2, ROW_HEIGHT).fill({ color: 0x2c2c2c });
      });
      row.container.off("pointerout").on("pointerout", () => row.bg.clear());
      row.container.off("pointertap").on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        if (visibleSpeakers.has(label)) visibleSpeakers.delete(label);
        else visibleSpeakers.add(label);
        onVisibleSpeakersChanged();
      });
    });
    for (let i = labels.length; i < rowPool.length; i++) rowPool[i].container.visible = false;

    const panelHeight =
      labels.length > 0
        ? y + labels.length * ROW_HEIGHT + LABEL_PAD_X
        : y + emptyText.height + LABEL_PAD_X;

    panelBg.clear();
    panelBg.roundRect(0, 0, w, panelHeight, 6).fill({ color: 0x1e1e1e }).stroke({ width: 1, color: 0x333333 });

    panel.x = LABEL_PAD_X;
    panel.y = REFERENCE_TRACK_HEIGHT + 4;

    expandingPanel.resize(Math.max(contentWidth, panel.x + w), panel.y + panelHeight);
  }

  const expandingPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent,
    panel,
    onOpenChange: (open) => {
      if (open) refreshPanel();
    },
  });

  redrawSegments();

  return {
    refresh() {
      redrawSegments();
      if (expandingPanel.isOpen) refreshPanel();
    },

    resize(newContentWidth: number) {
      contentWidth = Math.max(0, newContentWidth);
      redrawSegments();
      if (expandingPanel.isOpen) refreshPanel();
    },

    destroy() {
      offViewChange();
      expandingPanel.destroy();
      labelButton.destroy({ children: true });
      segmentPool.forEach((g) => g.destroy());
    },
  };
}

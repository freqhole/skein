/**
 * stfu's "SEGMENTS" panel — a below-timeline scrollable list of rows (time
 * range + matched transcript text), switchable between the editable cut
 * list and read-only reference data via a hover-pill flyout (same visual
 * language as `reference-track.ts`'s speaker popover), with an
 * "autoscroll" toggle that follows the playhead. design-ports editor.js's
 * dub panel (`createDubRowContainer()`/`layoutDubRow()`/
 * `createSegmentsViewControl()`/`maybeSyncPanelScroll()`) — MINUS its
 * tts-editing/voice-preview machinery, which belongs to a future dubbing
 * feature, not this checklist item ("time range + matched transcript
 * text", a view toggle, and autoscroll only).
 *
 * unlike `reference-track.ts` (nested inside `video-timeline.ts`'s layered
 * containers, so its popover needs an externally-supplied `overlayParent`
 * to render on top of sibling layers), this panel is its own flat
 * top-level container — the flyout/backdrop are just appended as its last
 * children, no external overlay parent needed.
 */

import { Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from "pixi.js";
import { createExpandingPanel, type ExpandingPanelHandle } from "../../src/widgets/expanding-panel";
import { createScrollableContent, type ScrollableContent } from "../../src/widgets/scrollable-content";
import type { EditableSegment } from "./cut-segments-track";
import { contrastTextColor } from "./reference-data";
import {
  buildPanelSegments,
  findActiveSegmentIndex,
  SEGMENTS_VIEW_MODES,
  type PanelSegment,
  type SegmentsViewMode,
} from "./segments-panel-data";
import type { ReferenceSpeaker, TranscriptSegment } from "./types";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

// matches trek-minus-paris's --color-magenta / --color-magenta-hover custom properties
const MAGENTA = 0xe619b3;
const MAGENTA_HOVER = 0xff33c9;

export const SEGMENTS_TOOLBAR_HEIGHT = 20;
const ROW_HEIGHT = 60;
const ROW_GAP = 6;
const ROW_PAD_X = 8;
const PAD_X = 8;
const TOOLBAR_GAP = 4;
/** how many rows' worth of vertical space the scrollable list reserves below the toolbar */
const VISIBLE_ROWS = 2;
export const SEGMENTS_PANEL_HEIGHT =
  SEGMENTS_TOOLBAR_HEIGHT + TOOLBAR_GAP + ROW_HEIGHT * VISIBLE_ROWS + ROW_GAP * (VISIBLE_ROWS - 1);

export interface SegmentsPanelOptions {
  canvasElement: HTMLCanvasElement;
  getEditableSegments: () => EditableSegment[];
  getTranscriptSegments: () => TranscriptSegment[];
  getReferenceSpeakers: () => Record<string, ReferenceSpeaker>;
  onSeek: (t: number) => void;
  /** localStorage key for the view-mode + autoscroll prefs (browser-local UI state) */
  storageKey: string;
}

export interface SegmentsPanelHandle {
  container: Container;
  /** re-draw rows — call after editableSegments/transcriptSegments/referenceSpeakers change. */
  refresh(): void;
  resize(width: number): void;
  /** call on every video timeupdate with the current playhead time — advances autoscroll. */
  onTimeUpdate(currentTime: number): void;
  /**
   * highlight the cut-list row matching `seg` (by [start, end], the same
   * identity `cut-segments-track.ts` reports its selection with) and
   * scroll it into view; pass `null` to clear the highlight. a no-op while
   * the panel is showing "reference" mode, since selection only applies to
   * cut-list segments.
   */
  setSelectedSegment(seg: EditableSegment | null): void;
  destroy(): void;
}

interface PanelPrefs {
  viewMode: SegmentsViewMode;
  autoscroll: boolean;
}

function loadPrefs(storageKey: string): PanelPrefs {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { viewMode: "cutlist", autoscroll: false };
    const parsed = JSON.parse(raw);
    return {
      viewMode: parsed.viewMode === "reference" ? "reference" : "cutlist",
      autoscroll: Boolean(parsed.autoscroll),
    };
  } catch {
    return { viewMode: "cutlist", autoscroll: false };
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

function createToggleButton(
  label: string,
  getActive: () => boolean,
  onClick: () => void
): { container: Container; width: number; draw(): void } {
  const container = new Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  const bg = new Graphics();
  const text = new Text({
    text: label,
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xdddddd },
    resolution: TEXT_RESOLUTION,
  });
  text.anchor.set(0.5);
  container.addChild(bg, text);

  const height = 20;
  let width = 0;
  let hover = false;

  const self = {
    container,
    width: 0,
    draw() {
      width = Math.max(60, Math.ceil(text.width) + 16);
      self.width = width;
      text.x = width / 2;
      text.y = height / 2;
      container.hitArea = new Rectangle(0, 0, width, height);
      const active = getActive();
      bg.clear();
      bg.roundRect(0, 0, width, height, 4).fill({ color: active ? (hover ? MAGENTA_HOVER : MAGENTA) : hover ? 0x4a4a4a : 0x3a3a3a });
      text.style.fill = active ? 0xffffff : 0xdddddd;
    },
  };

  container.on("pointerover", () => {
    hover = true;
    self.draw();
  });
  container.on("pointerout", () => {
    hover = false;
    self.draw();
  });
  container.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onClick();
  });

  return self;
}

export function createSegmentsPanel(options: SegmentsPanelOptions): SegmentsPanelHandle {
  const { canvasElement, getEditableSegments, getTranscriptSegments, getReferenceSpeakers, onSeek, storageKey } =
    options;

  let prefs = loadPrefs(storageKey);
  let contentWidth = 0;
  let currentSegments: PanelSegment[] = [];
  let lastAutoScrolledIndex = -1;
  let selectedSegment: EditableSegment | null = null;

  const container = new Container();

  const bg = new Graphics();
  container.addChild(bg);

  // -- toolbar: view-mode label+caret (left) / autoscroll toggle (right) -------

  const toolbar = new Container();
  container.addChild(toolbar);

  const viewModeLabel = new Container();
  viewModeLabel.eventMode = "static";
  viewModeLabel.cursor = "pointer";
  const viewModeLabelBorder = new Graphics();
  const viewModeLabelText = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0x888888, letterSpacing: 0.4 },
    resolution: TEXT_RESOLUTION,
  });
  viewModeLabelText.anchor.set(0, 0.5);
  const viewModeCaret = new Graphics();
  viewModeLabel.addChild(viewModeLabelBorder, viewModeLabelText, viewModeCaret);
  toolbar.addChild(viewModeLabel);

  function drawViewModeLabel(hover: boolean): void {
    const mode = SEGMENTS_VIEW_MODES.find((m) => m.id === prefs.viewMode) ?? SEGMENTS_VIEW_MODES[0];
    viewModeLabelText.text = mode.label.toUpperCase();
    const caretW = 6;
    const caretH = 4;
    const gap = 6;
    const caretX = viewModeLabelText.width + gap;
    viewModeCaret
      .clear()
      .moveTo(caretX, -caretH / 2)
      .lineTo(caretX + caretW, -caretH / 2)
      .lineTo(caretX + caretW / 2, caretH / 2)
      .closePath()
      .fill({ color: 0x888888 });
    const totalW = caretX + caretW;
    const pad = 4;
    viewModeLabelBorder.clear();
    if (hover) {
      viewModeLabelBorder.roundRect(-pad, -8, totalW + pad * 2, 16, 3).stroke({ width: 1, color: 0x555555 });
    }
    viewModeLabel.hitArea = new Rectangle(-pad, -8, totalW + pad * 2, 16);
  }
  drawViewModeLabel(false);
  viewModeLabel.x = PAD_X;
  viewModeLabel.y = SEGMENTS_TOOLBAR_HEIGHT / 2;
  viewModeLabel.on("pointerover", () => drawViewModeLabel(true));
  viewModeLabel.on("pointerout", () => drawViewModeLabel(false));
  viewModeLabel.on("pointertap", (e: FederatedPointerEvent) => {
    e.stopPropagation();
    viewModeFlyoutPanel.toggle();
  });

  // -- view-mode flyout (2 chips: "cut list" / "reference") --------------------

  const viewModeFlyout = new Container();
  interface Chip {
    container: Container;
    bg: Graphics;
    label: Text;
    mode: SegmentsViewMode;
  }
  const chips: Chip[] = SEGMENTS_VIEW_MODES.map((mode) => {
    const chipContainer = new Container();
    chipContainer.eventMode = "static";
    chipContainer.cursor = "pointer";
    const chipBg = new Graphics();
    const chipLabel = new Text({
      text: mode.label,
      style: { fontFamily: FONT_FAMILY, fontSize: 10, fontWeight: "600", fill: 0xffffff },
      resolution: TEXT_RESOLUTION,
    });
    chipLabel.anchor.set(0.5);
    chipContainer.addChild(chipBg, chipLabel);
    viewModeFlyout.addChild(chipContainer);
    chipContainer.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      setViewMode(mode.id);
      viewModeFlyoutPanel.close();
    });
    return { container: chipContainer, bg: chipBg, label: chipLabel, mode: mode.id };
  });

  function layoutChips(): void {
    const chipHeight = 20;
    const chipGap = 4;
    const chipPadX = 8;
    let x = 0;
    for (const chip of chips) {
      const w = Math.ceil(chip.label.width) + chipPadX * 2;
      chip.label.x = w / 2;
      chip.label.y = chipHeight / 2;
      const active = chip.mode === prefs.viewMode;
      chip.bg.clear().roundRect(0, 0, w, chipHeight, 4).fill({ color: active ? MAGENTA : 0x3a3a3a });
      chip.container.hitArea = new Rectangle(0, 0, w, chipHeight);
      chip.container.x = x;
      x += w + chipGap;
    }
    viewModeFlyout.x = PAD_X;
    viewModeFlyout.y = SEGMENTS_TOOLBAR_HEIGHT / 2 - 10;
    // covers the whole panel (not just the toolbar strip) so the backdrop
    // dims the row list behind it too while the flyout is open.
    viewModeFlyoutPanel.resize(contentWidth, SEGMENTS_PANEL_HEIGHT);
  }

  const viewModeFlyoutPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent: container,
    panel: viewModeFlyout,
    onOpenChange: (open) => {
      if (open) layoutChips();
    },
  });

  const autoscrollBtn = createToggleButton(
    "autoscroll",
    () => prefs.autoscroll,
    () => {
      prefs = { ...prefs, autoscroll: !prefs.autoscroll };
      savePrefs(storageKey, prefs);
      autoscrollBtn.draw();
    }
  );
  toolbar.addChild(autoscrollBtn.container);

  function layoutToolbar(): void {
    autoscrollBtn.draw();
    autoscrollBtn.container.x = contentWidth - PAD_X - autoscrollBtn.width;
    autoscrollBtn.container.y = (SEGMENTS_TOOLBAR_HEIGHT - 20) / 2;
  }

  // -- scrollable row list -------------------------------------------------------

  const listY = SEGMENTS_TOOLBAR_HEIGHT + TOOLBAR_GAP;
  const listVisibleHeight = SEGMENTS_PANEL_HEIGHT - listY;
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
  }
  const rowPool: Row[] = [];

  function rowAt(i: number): Row {
    while (rowPool.length <= i) {
      const rowContainer = new Container();
      rowContainer.eventMode = "static";
      rowContainer.cursor = "pointer";
      const rowBg = new Graphics();
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
      const row: Row = { container: rowContainer, bg: rowBg, timeText, metaText, refText, pillBg, pillText };
      rowPool.push(row);
    }
    return rowPool[i];
  }

  function layoutRow(row: Row, seg: PanelSegment, index: number): void {
    const w = Math.max(1, contentWidth);
    row.container.y = index * (ROW_HEIGHT + ROW_GAP);
    row.container.visible = true;
    row.container.hitArea = new Rectangle(0, 0, w, ROW_HEIGHT);
    row.container.off("pointertap").on("pointertap", () => onSeek(seg.start));

    row.bg.clear();
    const isSelected =
      prefs.viewMode === "cutlist" &&
      selectedSegment !== null &&
      selectedSegment[0] === seg.start &&
      selectedSegment[1] === seg.end;
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

  function setViewMode(mode: SegmentsViewMode): void {
    if (prefs.viewMode === mode) return;
    prefs = { ...prefs, viewMode: mode };
    savePrefs(storageKey, prefs);
    lastAutoScrolledIndex = -1;
    drawViewModeLabel(false);
    redraw();
  }

  function redraw(): void {
    currentSegments = buildPanelSegments(
      prefs.viewMode,
      getEditableSegments(),
      getTranscriptSegments(),
      getReferenceSpeakers()
    );

    emptyText.visible = currentSegments.length === 0;
    emptyText.text =
      prefs.viewMode === "reference" ? "no reference data loaded yet" : "no cut segments yet";
    emptyText.x = ROW_PAD_X;
    emptyText.y = 8;

    currentSegments.forEach((seg, i) => layoutRow(rowAt(i), seg, i));
    for (let i = currentSegments.length; i < rowPool.length; i++) rowPool[i].container.visible = false;

    const totalHeight =
      currentSegments.length > 0 ? currentSegments.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP : emptyText.height;
    scrollable.reflow(Math.max(1, contentWidth), Math.max(1, totalHeight));

    if (viewModeFlyoutPanel.isOpen) layoutChips();
  }

  function scrollRowIntoView(index: number): void {
    const rowTop = index * (ROW_HEIGHT + ROW_GAP);
    const rowBottom = rowTop + ROW_HEIGHT;
    const current = scrollable.getScrollY();
    let target = current;
    if (rowTop < current) target = rowTop;
    else if (rowBottom > current + listVisibleHeight) target = rowBottom - listVisibleHeight;
    if (target !== current) scrollable.scrollToY(Math.max(0, target));
  }

  drawViewModeLabel(false);
  redraw();

  return {
    container,

    refresh() {
      redraw();
    },

    resize(width: number) {
      contentWidth = Math.max(0, width);
      bg.clear();
      bg.roundRect(0, 0, contentWidth, SEGMENTS_PANEL_HEIGHT, 6).fill({ color: 0x1e1e1e }).stroke({
        width: 1,
        color: 0x333333,
      });
      layoutToolbar();
      scrollable.resize(Math.max(1, contentWidth), listVisibleHeight);
      redraw();
    },

    onTimeUpdate(currentTime: number) {
      if (!prefs.autoscroll) return;
      const index = findActiveSegmentIndex(currentSegments, currentTime);
      if (index === -1 || index === lastAutoScrolledIndex) return;
      lastAutoScrolledIndex = index;
      scrollRowIntoView(index);
    },

    setSelectedSegment(seg: EditableSegment | null) {
      selectedSegment = seg;
      redraw();
      if (seg && prefs.viewMode === "cutlist") {
        const index = currentSegments.findIndex((s) => s.start === seg[0] && s.end === seg[1]);
        if (index !== -1) scrollRowIntoView(index);
      }
    },

    destroy() {
      // `scrollable.destroy()` removes its document-level wheel listener —
      // not covered by pixi's own destroy cascade below. everything else
      // (rows, chips, the flyout's backdrop/panel, the scrollBox itself) is
      // a descendant of `container`, so one recursive destroy handles it.
      scrollable.destroy();
      container.destroy({ children: true });
    },
  };
}

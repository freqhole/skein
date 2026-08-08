/**
 * stfu's keyboard-shortcuts help — a small "?" trigger (mounted trailing in
 * `video-timeline.ts`'s toolbar row, via `toolbarTrailingSlot`) that expands
 * in place into a read-only reference panel listing every keyboard shortcut
 * and mouse/drag interaction this widget currently supports. direct design
 * port of trek-minus-paris's `editor.js` keyboard-shortcuts dialog (its
 * `SHORTCUTS_LIST`/`MOUSE_INTERACTIONS_LIST`), reusing skein's own generic
 * `expanding-panel.ts` helper instead of editor.js's canvas-wide dialog
 * system (same pattern `cut-mode-control.ts` already established).
 *
 * this list is a plain static reference — it isn't derived from the actual
 * keydown handler in index.ts, so keep the two in sync by hand whenever a
 * shortcut is added/changed/removed.
 */

import { Container, Graphics, Text } from "pixi.js";
import { createExpandingPanel, type ExpandingPanelHandle } from "../../src/widgets/expanding-panel";
import { TIMELINE_SHELL_HEIGHT } from "./video-timeline";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

const COLLAPSED_SIZE = 20;
const PANEL_WIDTH = 320;
const PANEL_PAD = 12;
const ROW_GAP = 6;
const KEY_COLUMN_WIDTH = 108;

/** [key label, description] — mirrors trek-minus-paris's own `SHORTCUTS_LIST`,
 *  trimmed to what stfu's `handleKeyDown` (index.ts) actually implements
 *  today (playback/view only — no selection/undo stack yet). */
const SHORTCUTS_LIST: Array<[string, string]> = [
  ["space", "play / pause"],
  ["\u2190 / \u2192", "seek 1s"],
  ["shift + \u2190 / \u2192", "seek 10s"],
  ["+ / -", "zoom timeline in / out"],
  ["0", "fit timeline to view"],
];

/** mirrors trek-minus-paris's `MOUSE_INTERACTIONS_LIST`, trimmed/updated to
 *  stfu's actual pointer gestures (cut-segments-track.ts/reference-track.ts/
 *  audio-clips-track.ts/video-timeline.ts). */
const MOUSE_INTERACTIONS_LIST: string[] = [
  "click the timestamps/ticks strip: seek to that time",
  "drag empty cut-list track: create a new segment",
  "drag a segment's body: move it",
  "drag a segment's edge: trim it",
  "click a segment's \u00d7: delete it",
  "drag a reference segment down into the cut list: copy it there",
  "click the \"reference\" label: toggle speaker visibility",
  "drag an audio-recording/tts/voice-recording widget onto the audio track: place a clip",
  "drag a clip off the audio track: lift it back out as its own widget",
  "scroll/wheel over any track: pan the timeline",
];

export interface KeyboardShortcutsControlOptions {
  /** mount point for the collapsed trigger \u2014 pass
   *  `timeline.toolbarTrailingSlot`. */
  toolbar: Container;
  /** mount point for the expanded panel + backdrop \u2014 pass `timeline.container`. */
  overlayParent: Container;
}

export interface KeyboardShortcutsControlHandle {
  /** call whenever the timeline shell's own width changes. */
  resize(contentWidth: number): void;
  destroy(): void;
}

function wrapText(text: string, style: ConstructorParameters<typeof Text>[0], wrapWidth: number): Text {
  return new Text({
    text,
    style: {
      fontFamily: FONT_FAMILY,
      fontSize: 11,
      fill: 0xdddddd,
      wordWrap: true,
      wordWrapWidth: wrapWidth,
      ...(style as object),
    },
    resolution: TEXT_RESOLUTION,
  });
}

export function createKeyboardShortcutsControl(
  options: KeyboardShortcutsControlOptions
): KeyboardShortcutsControlHandle {
  const { toolbar, overlayParent } = options;

  // -- collapsed "?" trigger -------------------------------------------------

  const collapsed = new Container();
  const collapsedBg = new Graphics();
  const collapsedLabel = new Text({
    text: "?",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fontWeight: "700", fill: 0xdddddd },
    resolution: TEXT_RESOLUTION,
  });
  collapsedLabel.anchor.set(0.5);
  collapsedLabel.position.set(COLLAPSED_SIZE / 2, COLLAPSED_SIZE / 2);
  collapsed.addChild(collapsedBg, collapsedLabel);
  collapsed.eventMode = "static";
  collapsed.cursor = "pointer";
  toolbar.addChild(collapsed);

  let collapsedHover = false;
  function drawCollapsed(): void {
    collapsedBg
      .clear()
      .roundRect(0, 0, COLLAPSED_SIZE, COLLAPSED_SIZE, 4)
      .fill({ color: collapsedHover ? 0x4a4a4a : 0x3a3a3a });
  }
  drawCollapsed();

  collapsed.on("pointerover", () => {
    collapsedHover = true;
    drawCollapsed();
  });
  collapsed.on("pointerout", () => {
    collapsedHover = false;
    drawCollapsed();
  });
  collapsed.on("pointertap", (e) => {
    e.stopPropagation();
    expandingPanel.toggle();
  });

  // -- expanded panel ---------------------------------------------------------

  const panel = new Container();
  panel.eventMode = "static";
  panel.on("pointerdown", (e) => e.stopPropagation());

  const panelBg = new Graphics();
  panel.addChild(panelBg);

  const titleText = new Text({
    text: "keyboard shortcuts",
    style: { fontFamily: FONT_FAMILY, fontSize: 12, fontWeight: "700", fill: 0xffffff },
    resolution: TEXT_RESOLUTION,
  });
  titleText.position.set(PANEL_PAD, PANEL_PAD);
  panel.addChild(titleText);

  let y = PANEL_PAD + titleText.height + 10;

  const descWidth = PANEL_WIDTH - PANEL_PAD * 2 - KEY_COLUMN_WIDTH;
  for (const [key, desc] of SHORTCUTS_LIST) {
    const keyPillBg = new Graphics();
    const keyLabel = new Text({
      text: key,
      style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xf5d9ee },
      resolution: TEXT_RESOLUTION,
    });
    const descText = wrapText(desc, {}, descWidth);
    keyLabel.position.set(6, 3);
    keyPillBg
      .roundRect(0, 0, Math.min(KEY_COLUMN_WIDTH - 8, keyLabel.width + 12), 18, 4)
      .fill({ color: 0x333333 })
      .stroke({ width: 1, color: 0x444444 });
    keyPillBg.position.set(PANEL_PAD, y);
    keyLabel.position.set(PANEL_PAD + 6, y + 3);
    descText.position.set(PANEL_PAD + KEY_COLUMN_WIDTH, y + 1);
    panel.addChild(keyPillBg, keyLabel, descText);
    y += Math.max(18, descText.height) + ROW_GAP;
  }

  y += 6;
  const separator = new Graphics();
  separator.rect(PANEL_PAD, y, PANEL_WIDTH - PANEL_PAD * 2, 1).fill({ color: 0x3a3a3a });
  panel.addChild(separator);
  y += 10;

  const sectionLabel = new Text({
    text: "mouse / drag interactions",
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0x888888, letterSpacing: 0.3 },
    resolution: TEXT_RESOLUTION,
  });
  sectionLabel.position.set(PANEL_PAD, y);
  panel.addChild(sectionLabel);
  y += sectionLabel.height + 6;

  for (const item of MOUSE_INTERACTIONS_LIST) {
    const bullet = wrapText(`\u2022 ${item}`, {}, PANEL_WIDTH - PANEL_PAD * 2);
    bullet.position.set(PANEL_PAD, y);
    panel.addChild(bullet);
    y += bullet.height + 4;
  }

  const panelHeight = y + PANEL_PAD;
  panelBg
    .roundRect(0, 0, PANEL_WIDTH, panelHeight, 8)
    .fill({ color: 0x222222 })
    .stroke({ width: 1, color: 0x3a3a3a });
  panel.setChildIndex(panelBg, 0);

  const expandingPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent,
    panel,
    onOpenChange: (open) => {
      collapsed.visible = !open;
    },
  });
  panel.x = 0;
  panel.y = 0;

  return {
    resize(contentWidth: number) {
      expandingPanel.resize(Math.max(0, contentWidth), TIMELINE_SHELL_HEIGHT);
    },
    destroy() {
      expandingPanel.destroy();
      collapsed.destroy();
    },
  };
}

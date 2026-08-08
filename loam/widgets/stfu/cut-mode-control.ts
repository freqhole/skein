/**
 * stfu's cut-playback-mode picker — skip / overlay / mute toggles for how
 * playback treats a cut segment. direct port of trek-minus-paris's
 * `editor.js` `createCutModeControl()`: a small collapsed icon button, sat
 * leftmost in the toolbar row (matching `layoutToolbar()`'s own ordering),
 * that expands *in place* into a row of 3 icon+label+hint option chips plus
 * a click-away backdrop. "skip" is mutually exclusive with the other two
 * (turning it on forces "overlay"/"mute" off, since there's nothing left to
 * overlay/mute once a segment is jumped past); "overlay" and "mute" combine
 * freely. icons ported to `icons.ts` (`drawSkipCutsIcon`/`drawOverlayCutsIcon`/
 * `drawMuteCutsIcon`/`drawNoCutModeIcon`) rather than redrawn here.
 *
 * the collapsed button mounts into `video-timeline.ts`'s `toolbarRow`
 * (leftmost, after reserving space via `reserveToolbarStart()`); the
 * expanded panel mounts into `overlayParent` (pass `timeline.container`,
 * already the topmost sibling in stfu's own widget z-order) via the generic
 * `expanding-panel.ts` helper, so it draws above the track/ruler/scrollbar
 * rows without editor.js's `app.stage`-reparenting trick.
 */

import { Container, Graphics, Text, type FederatedPointerEvent } from "pixi.js";
import {
  drawMuteCutsIcon,
  drawNoCutModeIcon,
  drawOverlayCutsIcon,
  drawSkipCutsIcon,
} from "../../src/widgets/icons";
import { createExpandingPanel, type ExpandingPanelHandle } from "../../src/widgets/expanding-panel";
import { TIMELINE_SHELL_HEIGHT } from "./video-timeline";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

// matches trek-minus-paris's --color-magenta / --color-magenta-hover custom properties
const MAGENTA = 0xe619b3;
const MAGENTA_HOVER = 0xff33c9;

const COLLAPSED_SIZE = 20;
const COLLAPSED_GAP = 10;
/** total leading width the collapsed button reserves in the toolbar row —
 *  pass to `timeline.reserveToolbarStart()`. */
export const CUT_MODE_CONTROL_RESERVED_WIDTH = COLLAPSED_SIZE + COLLAPSED_GAP;

const CHIP_WIDTH = 138;
const CHIP_HEIGHT = 92;
const CHIP_GAP = 4;
const CHIP_ICON_SIZE = 16;
const CHIP_PAD = 8;

type ChipId = "skip" | "overlay" | "mute";

type IconDrawFn = (g: Graphics, x: number, y: number, size: number, color?: number, alpha?: number) => void;

const CHIPS: Array<{ id: ChipId; label: string; hint: string; icon: IconDrawFn }> = [
  { id: "skip", label: "cut video & audio", hint: "jump past cut segments", icon: drawSkipCutsIcon },
  { id: "overlay", label: "overlay cuts", hint: "show overlay on video", icon: drawOverlayCutsIcon },
  { id: "mute", label: "mute cuts", hint: "silence audio", icon: drawMuteCutsIcon },
];

export interface CutModeControlOptions {
  /** mount point for the collapsed trigger — pass `timeline.toolbarRow`. */
  toolbar: Container;
  /** mount point for the expanded panel + backdrop — pass `timeline.container`. */
  overlayParent: Container;
  getSkipEnabled: () => boolean;
  getOverlayEnabled: () => boolean;
  getMuteEnabled: () => boolean;
  getMuteEarlyMs: () => number;
  onToggleSkip: () => void;
  onToggleOverlay: () => void;
  onToggleMute: () => void;
  onMuteEarlyMsChange: (ms: number) => void;
}

export interface CutModeControlHandle {
  /** call whenever the timeline shell's own height/width changes — resizes
   *  the click-away backdrop to cover the whole shell. */
  resize(contentWidth: number): void;
  /** re-render collapsed/expanded visuals from the getters — call after any
   *  external state change (a local toggle, or a remote peer's doc edit). */
  refresh(): void;
  destroy(): void;
}

// a small draggable ms slider (0-1000) controlling muteEarlyMs — lives
// inline in the mute option chip, shown only while that option is active.
// direct port of trek-minus-paris editor.js's `createMuteEarlySlider()`.
interface MuteEarlySliderHandle {
  container: Container;
  refresh(): void;
}

function createMuteEarlySlider(
  trackWidth: number,
  getMuteEarlyMs: () => number,
  onMuteEarlyMsChange: (ms: number) => void,
  afterChange: () => void
): MuteEarlySliderHandle {
  const container = new Container();
  const TRACK_HEIGHT = 4;
  const HANDLE_RADIUS = 5;
  const TRACK_CENTER_Y = 15;

  const label = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: 0xf5d9ee },
    resolution: TEXT_RESOLUTION,
  });
  const track = new Graphics();
  const handle = new Graphics();
  const hitArea = new Graphics();
  hitArea.eventMode = "static";
  hitArea.cursor = "pointer";
  container.addChild(label, track, hitArea, handle);

  function msToX(ms: number): number {
    return (Math.min(1000, Math.max(0, ms)) / 1000) * trackWidth;
  }
  function xToMs(localX: number): number {
    const ratio = Math.min(1, Math.max(0, localX / trackWidth));
    return Math.round((ratio * 1000) / 10) * 10;
  }

  function draw(): void {
    const ms = getMuteEarlyMs();
    label.text = `latency comp ${ms}ms`;
    track.clear().roundRect(0, TRACK_CENTER_Y - TRACK_HEIGHT / 2, trackWidth, TRACK_HEIGHT, 2).fill({ color: 0x2a2a2a });
    handle.clear().circle(msToX(ms), TRACK_CENTER_Y, HANDLE_RADIUS).fill({ color: 0xffffff });
    hitArea
      .clear()
      .rect(-HANDLE_RADIUS, TRACK_CENTER_Y - 8, trackWidth + HANDLE_RADIUS * 2, 16)
      .fill({ color: 0xffffff, alpha: 0.001 });
  }
  draw();

  let dragging = false;
  function commitFromGlobal(e: FederatedPointerEvent): void {
    const local = hitArea.toLocal(e.global);
    onMuteEarlyMsChange(xToMs(local.x));
    draw();
    afterChange();
  }
  hitArea.on("pointerdown", (e) => {
    e.stopPropagation();
    dragging = true;
    commitFromGlobal(e);
  });
  hitArea.on("globalpointermove", (e) => {
    if (!dragging) return;
    commitFromGlobal(e);
  });
  const endDrag = (e: FederatedPointerEvent) => {
    e.stopPropagation();
    dragging = false;
  };
  hitArea.on("pointerup", endDrag);
  hitArea.on("pointerupoutside", endDrag);

  return { container, refresh: draw };
}

export function createCutModeControl(options: CutModeControlOptions): CutModeControlHandle {
  const {
    toolbar,
    overlayParent,
    getSkipEnabled,
    getOverlayEnabled,
    getMuteEnabled,
    getMuteEarlyMs,
    onToggleSkip,
    onToggleOverlay,
    onToggleMute,
    onMuteEarlyMsChange,
  } = options;

  // -- collapsed button (leftmost in the toolbar row) -----------------------------

  const collapsed = new Container();
  const collapsedBg = new Graphics();
  const collapsedIconA = new Graphics();
  const collapsedIconB = new Graphics();
  collapsedIconB.visible = false;
  collapsed.addChild(collapsedBg, collapsedIconA, collapsedIconB);
  collapsed.eventMode = "static";
  collapsed.cursor = "pointer";
  toolbar.addChild(collapsed);

  let collapsedHover = false;

  function drawCollapsed(): void {
    collapsedBg.clear().roundRect(0, 0, COLLAPSED_SIZE, COLLAPSED_SIZE, 4).fill({ color: collapsedHover ? 0x4a4a4a : 0x3a3a3a });
    collapsedIconA.clear();
    collapsedIconA.scale.set(1);
    collapsedIconA.position.set(0, 0);
    collapsedIconB.clear();
    collapsedIconB.visible = false;

    if (getSkipEnabled()) {
      drawSkipCutsIcon(collapsedIconA, 0, 0, COLLAPSED_SIZE, 0xdddddd);
      return;
    }
    const activeIcons: IconDrawFn[] = [];
    if (getOverlayEnabled()) activeIcons.push(drawOverlayCutsIcon);
    if (getMuteEnabled()) activeIcons.push(drawMuteCutsIcon);

    if (activeIcons.length === 0) {
      drawNoCutModeIcon(collapsedIconA, 0, 0, COLLAPSED_SIZE, 0x777777);
    } else if (activeIcons.length === 1) {
      activeIcons[0](collapsedIconA, 0, 0, COLLAPSED_SIZE, 0xdddddd);
    } else {
      // both active — two mini icons in opposite corners rather than one overwriting the other
      const miniScale = 0.62;
      const miniSize = COLLAPSED_SIZE * miniScale;
      collapsedIconA.scale.set(miniScale);
      collapsedIconA.position.set(0, COLLAPSED_SIZE - miniSize);
      activeIcons[0](collapsedIconA, 0, 0, COLLAPSED_SIZE, 0xdddddd);
      collapsedIconB.visible = true;
      collapsedIconB.scale.set(miniScale);
      collapsedIconB.position.set(COLLAPSED_SIZE - miniSize, 0);
      activeIcons[1](collapsedIconB, 0, 0, COLLAPSED_SIZE, 0xdddddd);
    }
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

  // -- expanded panel (3 chips + mute-latency slider) -----------------------------

  const panel = new Container();
  panel.eventMode = "static";
  panel.on("pointerdown", (e) => e.stopPropagation());

  const activeGetterById: Record<ChipId, () => boolean> = {
    skip: getSkipEnabled,
    overlay: getOverlayEnabled,
    mute: getMuteEnabled,
  };

  const chipViews = CHIPS.map((chip, i) => {
    const c = new Container();
    c.x = i * (CHIP_WIDTH + CHIP_GAP);
    const bg = new Graphics();
    bg.eventMode = "static";
    bg.cursor = "pointer";
    const icon = new Graphics();
    const label = new Text({
      text: chip.label,
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 11,
        fontWeight: "600",
        fill: 0xffffff,
        wordWrap: true,
        wordWrapWidth: CHIP_WIDTH - CHIP_PAD - CHIP_ICON_SIZE - 5 - 6,
      },
      resolution: TEXT_RESOLUTION,
    });
    const hint = new Text({
      text: chip.hint,
      style: {
        fontFamily: FONT_FAMILY,
        fontSize: 9,
        fill: 0xaaaaaa,
        wordWrap: true,
        wordWrapWidth: CHIP_WIDTH - CHIP_PAD * 2,
      },
      resolution: TEXT_RESOLUTION,
    });
    c.addChild(bg, icon, label, hint);

    const muteSlider =
      chip.id === "mute" ? createMuteEarlySlider(CHIP_WIDTH - CHIP_PAD * 2, getMuteEarlyMs, onMuteEarlyMsChange, refresh) : null;
    if (muteSlider) c.addChild(muteSlider.container);

    let hover = false;
    function draw(): void {
      const active = activeGetterById[chip.id]();
      bg.clear()
        .roundRect(0, 0, CHIP_WIDTH, CHIP_HEIGHT, 4)
        .fill({ color: active ? (hover ? MAGENTA_HOVER : MAGENTA) : hover ? 0x4a4a4a : 0x3a3a3a });
      icon.clear();
      chip.icon(icon, CHIP_PAD, CHIP_PAD, CHIP_ICON_SIZE, 0xffffff);
      label.x = CHIP_PAD + CHIP_ICON_SIZE + 5;
      label.y = CHIP_PAD;
      hint.x = CHIP_PAD;
      hint.y = Math.max(CHIP_PAD + CHIP_ICON_SIZE, label.y + label.height) + 5;
      hint.style.fill = active ? 0xf5d9ee : 0xaaaaaa;
      if (muteSlider) {
        muteSlider.container.visible = active;
        if (active) {
          muteSlider.container.x = CHIP_PAD;
          muteSlider.container.y = hint.y + hint.height + 16;
          muteSlider.refresh();
        }
      }
    }
    draw();

    bg.on("pointerover", () => {
      hover = true;
      draw();
    });
    bg.on("pointerout", () => {
      hover = false;
      draw();
    });
    bg.on("pointertap", (e) => {
      e.stopPropagation();
      if (chip.id === "skip") onToggleSkip();
      else if (chip.id === "overlay") onToggleOverlay();
      else onToggleMute();
    });

    panel.addChild(c);
    return { draw };
  });

  // -- expand/collapse wiring ------------------------------------------------------

  const expandingPanel: ExpandingPanelHandle = createExpandingPanel({
    overlayParent,
    panel,
    onOpenChange: (open) => {
      collapsed.visible = !open;
    },
  });
  panel.x = 0;
  panel.y = 0;

  function refresh(): void {
    chipViews.forEach(({ draw }) => draw());
    drawCollapsed();
  }

  refresh();

  return {
    resize(contentWidth: number) {
      expandingPanel.resize(Math.max(0, contentWidth), TIMELINE_SHELL_HEIGHT);
    },
    refresh,
    destroy() {
      expandingPanel.destroy();
      collapsed.destroy();
    },
  };
}


/**
 * a small fixed-width drag slider for the timeline's own selected-clip
 * action bar (see index.ts's `updateTimelineActionBar()`) — volume/gain
 * adjustment for an audio-bearing clip. no generic pixi slider component
 * exists elsewhere in this codebase, so this is purpose-built, matching
 * timeline-chrome.ts's own button sizing/color conventions (same
 * TOOLBAR_HEIGHT, same drag-listener pattern as track-item-interaction.ts:
 * listeners attached once at construction, gated by a `dragging` flag,
 * rather than attached/detached per-drag).
 */

import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import { TOOLBAR_HEIGHT } from "../../src/widgets/timeline/timeline-chrome";

const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;
const TRACK_PAD = 8;
const LABEL_WIDTH = 30;
const LABEL_GAP = 4;

export interface GainSliderHandle {
  container: Container;
  buttonWidth: number;
  /** syncs the displayed value with an external change (e.g. a remote
   *  peer's edit, or a commit landing) — ignored while the user is
   *  actively dragging so it can't fight their own in-progress drag. */
  setValue(value: number): void;
  /** toggles a small busy dot while a gain rendition is being computed,
   *  without touching the slider's own interactivity. */
  setBusy(busy: boolean): void;
  destroy(): void;
}

export interface GainSliderOptions {
  width?: number;
  min?: number;
  max?: number;
  initialValue: number;
  /** called continuously while dragging — the caller is responsible for
   *  debouncing any expensive work (e.g. re-rendering a gain rendition). */
  onChange: (value: number) => void;
}

export function createGainSlider(options: GainSliderOptions): GainSliderHandle {
  const { width = 90, min = 0, max = 11, initialValue, onChange } = options;
  const h = TOOLBAR_HEIGHT;
  const trackY = h / 2;
  const trackWidth = width - TRACK_PAD * 2;
  const totalWidth = width + LABEL_GAP + LABEL_WIDTH;

  const c = new Container();
  const bg = new Graphics();
  const track = new Graphics();
  const handle = new Graphics();
  const busyDot = new Graphics();
  busyDot.circle(0, 0, 3).fill({ color: 0xa78bfa });
  busyDot.x = width - 7;
  busyDot.y = 6;
  busyDot.visible = false;
  // "1.0" (never "100%") to match the widget-level volume prop's own
  // raw-number display (property-tray.ts's number control) — same value,
  // same format, wherever it's shown.
  const valueLabel = new Text({
    text: "",
    style: { fontFamily: FONT_FAMILY, fontSize: 10, fill: 0xc8c8d8 },
    resolution: TEXT_RESOLUTION,
  });
  valueLabel.anchor.set(0, 0.5);
  valueLabel.x = width + LABEL_GAP;
  valueLabel.y = trackY;

  let value = initialValue;
  let dragging = false;

  function valueToX(v: number): number {
    const frac = Math.max(0, Math.min(1, (v - min) / (max - min)));
    return TRACK_PAD + frac * trackWidth;
  }
  function xToValue(x: number): number {
    const frac = Math.max(0, Math.min(1, (x - TRACK_PAD) / trackWidth));
    return min + frac * (max - min);
  }

  function draw(): void {
    bg.clear();
    bg.roundRect(0, 0, width, h, 4).fill({ color: 0x2a2a3e });
    track.clear();
    const filledX = valueToX(value);
    track.roundRect(TRACK_PAD, trackY - 1.5, trackWidth, 3, 1.5).fill({ color: 0x1a1a2a });
    track.roundRect(TRACK_PAD, trackY - 1.5, Math.max(0, filledX - TRACK_PAD), 3, 1.5).fill({ color: 0xa78bfa });
    handle.clear();
    handle.circle(filledX, trackY, 5).fill({ color: dragging ? 0xa78bfa : 0xe2e2e2 });
    valueLabel.text = value.toFixed(1);
  }
  draw();

  c.addChild(bg, track, handle, busyDot, valueLabel);
  // only the track box itself is draggable — the number label to its
  // right is just a readout, not part of the hit area.
  c.hitArea = new Rectangle(0, 0, width, h);
  c.eventMode = "static";
  c.cursor = "ew-resize";

  function updateFromPointer(e: FederatedPointerEvent): void {
    const local = c.toLocal(e.global);
    value = xToValue(local.x);
    draw();
    onChange(value);
  }

  function onPointerDown(e: FederatedPointerEvent): void {
    e.stopPropagation();
    dragging = true;
    updateFromPointer(e);
  }
  function onGlobalPointerMove(e: FederatedPointerEvent): void {
    if (!dragging) return;
    updateFromPointer(e);
  }
  function onPointerUp(): void {
    if (!dragging) return;
    dragging = false;
    draw();
  }

  c.on("pointerdown", onPointerDown);
  c.on("globalpointermove", onGlobalPointerMove);
  c.on("pointerup", onPointerUp);
  c.on("pointerupoutside", onPointerUp);

  return {
    container: c,
    buttonWidth: totalWidth,
    setValue(v: number) {
      if (dragging) return;
      value = v;
      draw();
    },
    setBusy(busy: boolean) {
      busyDot.visible = busy;
    },
    destroy() {
      c.off("pointerdown", onPointerDown);
      c.off("globalpointermove", onGlobalPointerMove);
      c.off("pointerup", onPointerUp);
      c.off("pointerupoutside", onPointerUp);
    },
  };
}

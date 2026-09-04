/**
 * ruler row: tick marks + pooled time labels, redrawn from the current
 * camera view — extracted from `stfu/video-timeline.ts`'s ruler, made
 * generic (no stfu-specific state). label pooling avoids creating/
 * destroying `Text` objects every redraw (expensive — each involves a
 * canvas text-measurement pass).
 */

import { Container, Graphics, Text } from "pixi.js";
import { formatTimelineTime, niceStep, type TimelineCameraView } from "./timeline-camera";

const DEFAULT_LABEL_POOL_SIZE = 16;
const FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
const TEXT_RESOLUTION = typeof window !== "undefined" ? Math.max(window.devicePixelRatio, 2) : 2;

export interface TimelineRulerOptions {
  /** the ruler row's own container — a direct child of this gets the tick
   *  `Graphics` + pooled labels; caller owns positioning/masking/hit-testing
   *  (e.g. a "click to seek" listener) of this container itself. */
  container: Container;
  labelPoolSize?: number;
  tickColor?: number;
  labelColor?: number;
}

export interface TimelineRulerHandle {
  /** redraw ticks/labels for the current camera view — call from the
   *  camera's own `onViewChange`. `rowWidth` is passed separately (not
   *  read off the view) since it's a screen-space concern the camera
   *  itself doesn't track. */
  redraw(view: TimelineCameraView, rowWidth: number, timeToScreenX: (t: number) => number): void;
  destroy(): void;
}

export function createTimelineRuler(options: TimelineRulerOptions): TimelineRulerHandle {
  const { container, labelPoolSize = DEFAULT_LABEL_POOL_SIZE, tickColor = 0x444460, labelColor = 0x707090 } = options;

  const ticks = new Graphics();
  ticks.eventMode = "none";
  container.addChild(ticks);

  const labelPool: Text[] = [];
  for (let i = 0; i < labelPoolSize; i++) {
    const t = new Text({ text: "", style: { fontFamily: FONT_FAMILY, fontSize: 9, fill: labelColor }, resolution: TEXT_RESOLUTION });
    t.visible = false;
    labelPool.push(t);
    container.addChild(t);
  }

  return {
    redraw(view: TimelineCameraView, rowWidth: number, timeToScreenX: (t: number) => number): void {
      ticks.clear();
      labelPool.forEach((t) => (t.visible = false));
      if (view.duration <= 0 || rowWidth <= 0) return;

      const approxTicks = Math.max(2, Math.floor(rowWidth / 60));
      const step = niceStep(view.viewDuration / approxTicks);
      const startT = Math.max(0, Math.floor(view.viewStartTime / step) * step);

      let poolIndex = 0;
      for (let t = startT; t <= view.viewStartTime + view.viewDuration + step; t += step) {
        const x = timeToScreenX(t);
        if (x < -40 || x > rowWidth + 40) continue;
        if (x >= 0 && x <= rowWidth) ticks.moveTo(x, 0).lineTo(x, 3);
        if (poolIndex < labelPool.length) {
          const label = labelPool[poolIndex++];
          label.text = formatTimelineTime(t);
          label.anchor.set(0.5, 0);
          label.x = Math.max(label.width / 2, Math.min(rowWidth - label.width / 2, x));
          label.y = 4;
          label.visible = true;
        }
      }
      ticks.stroke({ width: 1, color: tickColor });
    },
    destroy() {
      ticks.destroy();
      labelPool.forEach((t) => t.destroy());
      labelPool.length = 0;
    },
  };
}

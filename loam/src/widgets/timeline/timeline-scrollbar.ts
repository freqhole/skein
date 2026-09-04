/**
 * scrollbar row: track + draggable thumb, panning a `TimelineCamera` —
 * extracted from `stfu/video-timeline.ts`'s scrollbar, made generic.
 */

import { Container, Graphics } from "pixi.js";
import type { TimelineCamera } from "./timeline-camera";

export interface TimelineScrollbarOptions {
  container: Container;
  camera: Pick<TimelineCamera, "getView" | "panTo">;
  height?: number;
  trackColor?: number;
  thumbColor?: number;
  thumbIdleColor?: number;
}

export interface TimelineScrollbarHandle {
  /** redraw the track/thumb for the current row width + camera view —
   *  call from the camera's own `onViewChange` and on resize. */
  redraw(rowWidth: number): void;
  destroy(): void;
}

const MIN_THUMB_WIDTH_PX = 20;

export function createTimelineScrollbar(options: TimelineScrollbarOptions): TimelineScrollbarHandle {
  const {
    container,
    camera,
    height = 8,
    trackColor = 0x22222e,
    thumbColor = 0x555570,
    thumbIdleColor = 0x555570,
  } = options;

  const track = new Graphics();
  track.eventMode = "static";
  track.cursor = "pointer";
  const thumb = new Graphics();
  thumb.eventMode = "static";
  thumb.cursor = "grab";
  container.addChild(track, thumb);

  let lastRowWidth = 0;
  let drag: { startGlobalX: number; startViewStart: number } | null = null;

  track.on("pointerdown", (e) => {
    const view = camera.getView();
    if (view.duration <= 0 || view.viewDuration >= view.duration) return;
    const local = e.getLocalPosition(container);
    const clickRatio = lastRowWidth > 0 ? local.x / lastRowWidth : 0;
    camera.panTo(clickRatio * view.duration - view.viewDuration / 2);
  });
  thumb.on("pointerdown", (e) => {
    e.stopPropagation();
    drag = { startGlobalX: e.global.x, startViewStart: camera.getView().viewStartTime };
  });
  thumb.on("globalpointermove", (e) => {
    if (!drag) return;
    const view = camera.getView();
    if (view.duration <= 0) return;
    const maxViewStart = view.duration - view.viewDuration;
    const thumbWidthPx = Math.max(MIN_THUMB_WIDTH_PX, (view.viewDuration / view.duration) * lastRowWidth);
    const maxThumbLeft = lastRowWidth - thumbWidthPx;
    const deltaPx = e.global.x - drag.startGlobalX;
    const deltaTime = maxThumbLeft > 0 ? (deltaPx / maxThumbLeft) * maxViewStart : 0;
    camera.panTo(drag.startViewStart + deltaTime);
  });
  const endDrag = () => {
    drag = null;
  };
  thumb.on("pointerup", endDrag);
  thumb.on("pointerupoutside", endDrag);

  return {
    redraw(rowWidth: number): void {
      lastRowWidth = rowWidth;
      track.clear();
      track.rect(0, 0, rowWidth, height).fill({ color: trackColor });

      const view = camera.getView();
      if (view.duration <= 0 || view.viewDuration >= view.duration - 0.0001) {
        thumb.clear();
        thumb.roundRect(0, 0, rowWidth, height, 4).fill({ color: thumbIdleColor, alpha: 0.35 });
        thumb.eventMode = "none";
        return;
      }
      thumb.eventMode = "static";
      const thumbWidthPx = Math.max(MIN_THUMB_WIDTH_PX, (view.viewDuration / view.duration) * rowWidth);
      const maxThumbLeft = rowWidth - thumbWidthPx;
      const maxViewStart = view.duration - view.viewDuration;
      const ratio = maxViewStart > 0 ? view.viewStartTime / maxViewStart : 0;
      thumb.clear();
      thumb.roundRect(ratio * maxThumbLeft, 0, thumbWidthPx, height, 4).fill({ color: thumbColor });
    },
    destroy() {
      track.destroy();
      thumb.destroy();
    },
  };
}

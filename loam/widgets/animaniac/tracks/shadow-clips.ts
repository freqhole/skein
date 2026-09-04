/**
 * "shadow" bars for clips that live on a DIFFERENT track kind but should
 * also be visible (and deletable) on this one:
 *  - a video-segment's own embedded audio, shown on the first non-hidden
 *    audio track — deleting it just mutes the video (via `onDelete`)
 *    rather than removing the clip.
 *  - a voice-recording's talking-mouth timing, shown on the first non-
 *    hidden visual track — deleting it removes the whole clip (audio and
 *    mouth aren't separable, unlike a video's mute flag).
 *
 * deliberately NOT built on track-item-interaction.ts's full drag/resize
 * engine — a shadow bar always mirrors its real clip's own start/duration
 * exactly, so "move" only happens by dragging the REAL bar on its own
 * native track (both bars redraw from the same clip data, so they're
 * trivially "locked together" with no extra sync logic needed). this
 * module only needs hover/select/delete, reusing track-item-render.ts's
 * pure draw/hit-test helpers for a consistent look.
 */

import { Graphics, Text } from "pixi.js";
import type { FederatedPointerEvent } from "pixi.js";
import {
  DEFAULT_MARGIN_Y,
  drawTrackItemBody,
  hitDeleteGlyph,
  type TrackItemColors,
} from "../../../src/widgets/timeline/track-item-render";
import type { TrackCameraView, TrackRowContainers } from "../../../src/widgets/timeline/timeline-types";

export interface ShadowClipSpan {
  id: string;
  start: number;
  end: number;
  label: string;
  /** backing media blob isn't local yet — drawn as a dashed border. */
  remote: boolean;
  /** 0..1 live download progress, only meaningful while `remote`. */
  progress: number;
}

export interface ShadowClipsOptions {
  row: Pick<TrackRowContainers, "contentLayer">;
  camera: Pick<TrackCameraView, "timeToScreenX">;
  rowHeight: number;
  colors: TrackItemColors;
  getSelectedId: () => string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export interface ShadowClipsHandle {
  /** redraw every shadow bar from `spans` — call whenever the underlying
   *  clip list, camera view, or selection changes. */
  refresh(spans: ShadowClipSpan[]): void;
  destroy(): void;
}

export function createShadowClips(options: ShadowClipsOptions): ShadowClipsHandle {
  const { row, camera, rowHeight, colors, getSelectedId, onSelect, onDelete } = options;
  const pool = new Map<string, { g: Graphics; label: Text }>();
  let hoveredId: string | null = null;

  function entryFor(id: string): { g: Graphics; label: Text } {
    let entry = pool.get(id);
    if (!entry) {
      const g = new Graphics();
      g.eventMode = "static";
      g.cursor = "pointer";
      const label = new Text({ text: "", style: { fontSize: 9, fill: 0xd8f4fb } });
      label.anchor.set(0, 0.5);
      g.addChild(label);
      row.contentLayer.addChild(g);
      entry = { g, label };
      pool.set(id, entry);
    }
    return entry;
  }

  function redrawOne(span: ShadowClipSpan): void {
    const entry = entryFor(span.id);
    const left = camera.timeToScreenX(span.start);
    const right = camera.timeToScreenX(span.end);
    const hovered = hoveredId === span.id;
    const selected = getSelectedId() === span.id;
    drawTrackItemBody(entry.g, left, right, rowHeight, colors, hovered, null, selected, DEFAULT_MARGIN_Y, span.remote, span.progress);
    entry.label.text = span.label;
    entry.label.x = left + 6;
    entry.label.y = rowHeight / 2;

    entry.g.removeAllListeners();
    entry.g.on("pointerover", () => {
      hoveredId = span.id;
      redrawOne(span);
    });
    entry.g.on("pointerout", () => {
      if (hoveredId === span.id) hoveredId = null;
      redrawOne(span);
    });
    entry.g.on("pointertap", (e: FederatedPointerEvent) => {
      const local = entry.g.toLocal(e.global);
      if (hitDeleteGlyph(right, DEFAULT_MARGIN_Y, local.x, local.y)) {
        onDelete(span.id);
      } else {
        onSelect(span.id);
      }
    });
  }

  function refresh(spans: ShadowClipSpan[]): void {
    const activeIds = new Set(spans.map((s) => s.id));
    for (const [id, entry] of pool) {
      if (!activeIds.has(id)) {
        entry.g.destroy({ children: true });
        pool.delete(id);
      }
    }
    for (const span of spans) redrawOne(span);
  }

  return {
    refresh,
    destroy() {
      for (const entry of pool.values()) entry.g.destroy({ children: true });
      pool.clear();
    },
  };
}

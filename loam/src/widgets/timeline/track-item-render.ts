/**
 * generic draw + hit-test geometry helpers for one track item (segment/
 * clip) — extracted from `stfu/cut-segments-track.ts` so `audio-clips-
 * track.ts` and animaniac's own tracks don't each re-derive the same
 * delete-glyph/resize-handle geometry. colors are the one thing left to
 * the caller (different track/clip kinds want different tints); shape and
 * hit-testing are shared exactly, including the hard-won fixes noted
 * inline (circular delete glyph, width-capped resize handles).
 *
 * the pure geometry functions (`hitDeleteGlyph`, `modeForLocalX`) have no
 * pixi dependency and are unit-tested directly; the `draw*` functions take
 * a pixi `Graphics` and are exercised indirectly (this codebase's own
 * convention — pixi construction isn't unit-testable, see repo memory).
 */

import type { Graphics } from "pixi.js";
import type { TrackDragMode, TrackHitRegion } from "./timeline-types";

export const DEFAULT_HANDLE_PX = 8;
export const DEFAULT_MARGIN_Y = 3;
const DELETE_GLYPH_RADIUS = 7;
const DELETE_GLYPH_HIT_RADIUS = 8;

export interface TrackItemColors {
  fill: number;
  fillHover: number;
  stroke: number;
}

/** circular hit test for the delete glyph — matches its own drawn shape
 *  exactly (a square hit test reaches ~40% farther from center at the
 *  corners than the circle it's meant to cover, which silently poaches
 *  clicks meant for a resize-right drag just below it). */
export function hitDeleteGlyph(right: number, marginY: number, localX: number, localY: number): boolean {
  return Math.hypot(localX - (right - 2), localY - marginY) <= DELETE_GLYPH_HIT_RADIUS;
}

/** resolves which drag mode a pointer-down at `localX` (within
 *  `[left, right]`) should start — caps the resize-handle zone to a third
 *  of the item's own width so a narrow item (common at typical zoom
 *  levels) still keeps a reachable "move" region in the middle, rather
 *  than both edges' zones overlapping and swallowing the whole item. */
export function modeForLocalX(left: number, right: number, localX: number, handlePx = DEFAULT_HANDLE_PX): TrackDragMode {
  const cappedHandlePx = Math.max(2, Math.min(handlePx, (right - left) / 3));
  const distLeft = Math.abs(localX - left);
  const distRight = Math.abs(localX - right);
  if (distLeft <= cappedHandlePx && distLeft <= distRight) return "resize-left";
  if (distRight <= cappedHandlePx) return "resize-right";
  return "move";
}

/** resolves the CSS cursor for a hit region — "pointer" over delete,
 *  "w-resize"/"e-resize" over a trim handle, "grab" over the body, else
 *  `emptyCursor` (default "crosshair" — pass "default" for a track that
 *  doesn't support click-empty-space-to-create). */
export function cursorForRegion(region: TrackHitRegion | null, emptyCursor = "crosshair"): string {
  switch (region) {
    case "delete":
      return "pointer";
    case "resize-left":
      return "w-resize";
    case "resize-right":
      return "e-resize";
    case "move":
      return "grab";
    default:
      return emptyCursor;
  }
}

export function drawDeleteGlyph(g: Graphics, right: number, marginY: number): void {
  const cx = right - 2;
  const cy = marginY;
  g.circle(cx, cy, DELETE_GLYPH_RADIUS).fill({ color: 0x000000, alpha: 0.75 });
  const r = 2.6;
  g.moveTo(cx - r, cy - r)
    .lineTo(cx + r, cy + r)
    .moveTo(cx + r, cy - r)
    .lineTo(cx - r, cy + r)
    .stroke({ width: 1.3, color: 0xe08080 });
}

/** draws a dashed rounded-rect border — straight edges are dashed, corner
 *  arcs stay solid (small enough that dashing them looks noisy). used for
 *  a track item whose backing media blob isn't local yet (see
 *  `drawTrackItemBody()`'s own `remote` option) — mirrors narthex/canvas-
 *  card.ts's own dashed-border helper, kept separate since track items
 *  draw into a per-item pooled Graphics rather than one shared card. */
function drawDashedRoundRect(g: Graphics, x: number, y: number, w: number, h: number, r: number, color: number, lineWidth: number): void {
  const dashLen = 5;
  const gapLen = 3;
  const dashLine = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const nx = dx / len;
    const ny = dy / len;
    let pos = 0;
    while (pos < len) {
      const end = Math.min(pos + dashLen, len);
      g.moveTo(x1 + nx * pos, y1 + ny * pos);
      g.lineTo(x1 + nx * end, y1 + ny * end);
      pos = end + gapLen;
    }
  };
  dashLine(x + r, y, x + w - r, y); // top
  dashLine(x + w, y + r, x + w, y + h - r); // right
  dashLine(x + w - r, y + h, x + r, y + h); // bottom
  dashLine(x, y + h - r, x, y + r); // left
  g.moveTo(x + w - r, y).arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  g.moveTo(x + w, y + h - r).arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  g.moveTo(x + r, y + h).arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  g.moveTo(x, y + r).arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  g.stroke({ color, width: lineWidth });
}

/** draws one item's body (rounded rect + stroke), the hovered resize edge
 *  highlight, a selection outline, and (while hovered) the delete glyph —
 *  the exact visual language `cut-segments-track.ts` established. caller
 *  supplies colors + row height; everything else is shared. `remote`
 *  draws the border dashed instead of solid — the "backing media blob
 *  isn't local yet" cue (see snatch-controller.ts's own locality tracking).
 *  `progress` (0..1, only meaningful while `remote`) fills the background
 *  from a faint tint up to full opacity left-to-right as the blob
 *  downloads. */
export function drawTrackItemBody(
  g: Graphics,
  left: number,
  right: number,
  rowHeight: number,
  colors: TrackItemColors,
  hovered: boolean,
  hoveredRegion: TrackHitRegion | null,
  selected: boolean,
  marginY = DEFAULT_MARGIN_Y,
  remote = false,
  progress = 0
): void {
  g.clear();
  const width = Math.max(1, right - left);
  const top = marginY;
  const height = rowHeight - marginY * 2;
  const baseFill = hovered ? colors.fillHover : colors.fill;
  if (remote) {
    g.roundRect(left, top, width, height, 3).fill({ color: baseFill, alpha: 0.18 });
    const filledWidth = Math.max(0, Math.min(width, width * progress));
    if (filledWidth > 0) {
      g.roundRect(left, top, filledWidth, height, 3).fill({ color: baseFill });
    }
  } else {
    g.roundRect(left, top, width, height, 3).fill({ color: baseFill });
  }
  if (remote) {
    drawDashedRoundRect(g, left, top, width, height, 3, colors.stroke, 1);
  } else {
    g.roundRect(left, top, width, height, 3).stroke({ color: colors.stroke, width: 1 });
  }
  if (hovered && hoveredRegion === "resize-left") {
    g.rect(left, top, 3, height).fill({ color: 0xffffff });
  } else if (hovered && hoveredRegion === "resize-right") {
    g.rect(right - 3, top, 3, height).fill({ color: 0xffffff });
  }
  if (selected) {
    g.roundRect(left - 1, top - 1, width + 2, height + 2, 3).stroke({ width: 2, color: 0xffffff });
  }
  if (hovered) {
    drawDeleteGlyph(g, right, marginY);
  }
}

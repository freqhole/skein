// shared icon drawing functions for widget action buttons.
// all icons are drawn into a provided Graphics object at the specified size.
// designed to be readable at small sizes (12-20px) in compact card buttons.

import { Graphics } from "pixi.js";

/**
 * draw a save/floppy disk icon.
 * represents "save to disk" (browser mode).
 */
export function drawSaveIcon(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  color = 0xffffff,
  alpha = 0.9
): void {
  const strokeW = Math.max(1.2, size * 0.12);
  const pad = size * 0.15;
  const l = x + pad;
  const t = y + pad;
  const r = x + size - pad;
  const b = y + size - pad;
  const w = r - l;
  const h = b - t;

  // outer rectangle (the disk body) with chamfered top-right corner
  const chamfer = w * 0.2;
  g.moveTo(l, t);
  g.lineTo(r - chamfer, t);
  g.lineTo(r, t + chamfer);
  g.lineTo(r, b);
  g.lineTo(l, b);
  g.closePath();
  g.stroke({ width: strokeW, color, alpha });

  // label slot — small rectangle in the bottom center
  const slotW = w * 0.5;
  const slotH = h * 0.3;
  const slotX = l + (w - slotW) / 2;
  const slotY = b - slotH - h * 0.08;
  g.rect(slotX, slotY, slotW, slotH);
  g.stroke({ width: Math.max(1, strokeW * 0.8), color, alpha: alpha * 0.7 });

  // shutter notch — small rectangle at top center
  const notchW = w * 0.35;
  const notchH = h * 0.2;
  const notchX = l + (w - notchW) / 2;
  g.rect(notchX, t, notchW, notchH);
  g.stroke({ width: Math.max(1, strokeW * 0.8), color, alpha: alpha * 0.7 });
}

/**
 * draw a reveal/open icon — box with arrow pointing upper-right.
 * represents "reveal in Finder" (Tauri) or "open externally".
 */
export function drawRevealIcon(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  color = 0xffffff,
  alpha = 0.9
): void {
  const strokeW = Math.max(1.2, size * 0.12);
  const pad = size * 0.15;
  const l = x + pad;
  const t = y + pad;
  const r = x + size - pad;
  const b = y + size - pad;

  // box — three sides (left, bottom, right), open at top
  g.moveTo(l, t + (b - t) * 0.3);
  g.lineTo(l, b);
  g.lineTo(r, b);
  g.lineTo(r, t + (b - t) * 0.3);
  g.stroke({ width: strokeW, color, alpha });

  // arrow shaft — from center going to upper-right
  const arrowStartX = l + (r - l) * 0.35;
  const arrowStartY = t + (b - t) * 0.65;
  const arrowEndX = r - (r - l) * 0.05;
  const arrowEndY = t + (b - t) * 0.05;
  g.moveTo(arrowStartX, arrowStartY);
  g.lineTo(arrowEndX, arrowEndY);
  g.stroke({ width: strokeW, color, alpha });

  // arrowhead
  const headLen = (r - l) * 0.2;
  g.moveTo(arrowEndX - headLen, arrowEndY);
  g.lineTo(arrowEndX, arrowEndY);
  g.lineTo(arrowEndX, arrowEndY + headLen);
  g.stroke({ width: strokeW, color, alpha });
}

/**
 * draw two right-pointing chevrons — "jump ahead" (stfu's cut-mode "skip" toggle).
 * direct port of trek-minus-paris editor.js's `drawSkipModeIcon()`.
 */
export function drawSkipCutsIcon(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  color = 0xffffff,
  alpha = 1
): void {
  const midY = y + size / 2;
  const chevW = size * 0.22;
  const chevH = size * 0.5;
  [x + size * 0.2, x + size * 0.52].forEach((cx) => {
    g.moveTo(cx, midY - chevH / 2).lineTo(cx + chevW, midY).lineTo(cx, midY + chevH / 2);
  });
  g.stroke({ width: 2, color, alpha });
}

/**
 * draw an "×" — same glyph the cut overlay itself uses (stfu's cut-mode "overlay" toggle).
 * direct port of trek-minus-paris editor.js's `drawShowModeIcon()`.
 */
export function drawOverlayCutsIcon(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  color = 0xffffff,
  alpha = 1
): void {
  const pad = size * 0.28;
  g.moveTo(x + pad, y + pad).lineTo(x + size - pad, y + size - pad);
  g.moveTo(x + size - pad, y + pad).lineTo(x + pad, y + size - pad);
  g.stroke({ width: 2, color, alpha });
}

/**
 * draw a crossed-out speaker (stfu's cut-mode "mute" toggle).
 * direct port of trek-minus-paris editor.js's `drawMuteModeIcon()`.
 */
export function drawMuteCutsIcon(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  color = 0xffffff,
  alpha = 1
): void {
  const bodyW = size * 0.52;
  const bodyH = size * 0.68;
  const bx = x + size * 0.1;
  const by = y + size / 2 - bodyH / 2;
  g.moveTo(bx, by + bodyH * 0.25)
    .lineTo(bx + bodyW * 0.45, by + bodyH * 0.25)
    .lineTo(bx + bodyW, by)
    .lineTo(bx + bodyW, by + bodyH)
    .lineTo(bx + bodyW * 0.45, by + bodyH * 0.75)
    .lineTo(bx, by + bodyH * 0.75)
    .closePath()
    .fill({ color, alpha });
  const slashFrom = { x: x + size * 0.8, y: y + size * 0.32 };
  const slashTo = { x: x + size * 0.36, y: y + size * 0.7 };
  g.moveTo(slashFrom.x, slashFrom.y).lineTo(slashTo.x, slashTo.y);
  g.stroke({ width: 4.5, color: 0x000000, alpha: 0.35 });
  g.moveTo(slashFrom.x, slashFrom.y).lineTo(slashTo.x, slashTo.y);
  g.stroke({ width: 2.2, color, alpha });
}

/**
 * draw a plain play triangle — no cut-playback toggle is active (stfu's cut-mode "none" state).
 * direct port of trek-minus-paris editor.js's `drawNoneModeIcon()`.
 */
export function drawNoCutModeIcon(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  color = 0x777777,
  alpha = 1
): void {
  const pad = size * 0.26;
  g.moveTo(x + pad, y + pad)
    .lineTo(x + size - pad, y + size / 2)
    .lineTo(x + pad, y + size - pad)
    .closePath()
    .fill({ color, alpha });
}

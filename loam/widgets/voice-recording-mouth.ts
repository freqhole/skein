// voice-recording-mouth.ts — procedural pixi mouth renderer for the voice-recording widget.
//
// draws animated lips, teeth, and tongue driven by an openness parameter 0..1.
// pure helper functions are exported for unit testing.

import { Container, Graphics } from "pixi.js";

// ---------------------------------------------------------------------------
// exported pure helpers
// ---------------------------------------------------------------------------

/**
 * scale each RGB channel of a hex color by factor (clamped 0..1).
 * used to derive a slightly darker lip stroke from the fill color.
 */
export function darkenHex(color: number, factor: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 0xff) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 0xff) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((color & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

// rms below this is considered silence
const NOISE_FLOOR = 0.02;
// rms at or above this drives the mouth to fully open
const SOFT_CEILING = 0.28;

/**
 * map a raw RMS amplitude (0..1) to an openness fraction (0..1).
 * values at or below noiseFloor return 0; values at or above softCeiling return 1.
 * a 0.7 power curve makes mid-volumes feel more expressive.
 */
export function volumeToRawOpenness(rms: number, noiseFloor = NOISE_FLOOR): number {
  if (rms <= noiseFloor) return 0;
  const normalized = Math.min(1, (rms - noiseFloor) / (SOFT_CEILING - noiseFloor));
  return Math.pow(normalized, 0.7);
}

/**
 * single lerp step used for smoothing openness over time.
 * attack (target > current) uses a larger alpha so the mouth snaps open on syllables;
 * decay (target < current) uses a smaller alpha so it eases closed naturally.
 */
export function smoothLerp(current: number, target: number, attack = 0.6, decay = 0.15): number {
  const alpha = target > current ? attack : decay;
  return current + (target - current) * alpha;
}

// ---------------------------------------------------------------------------
// mouth renderer
// ---------------------------------------------------------------------------

/**
 * draws a cartoon procedural mouth (lips, teeth, tongue) scaled to fill the
 * given widget bounds. all geometry is recomputed each draw() call so the
 * mouth scales correctly after a resize without caching stale coordinates.
 */
export class MouthRenderer {
  private readonly gfx: Graphics;
  private openness = 0;
  private lipsColor: number;
  private w: number;
  private h: number;

  constructor(parent: Container, width: number, height: number, lipsColor: number) {
    this.w = width;
    this.h = height;
    this.lipsColor = lipsColor;
    this.gfx = new Graphics();
    this.gfx.eventMode = "none";
    parent.addChild(this.gfx);
    this.draw();
  }

  setOpenness(v: number): void {
    this.openness = Math.max(0, Math.min(1, v));
    this.draw();
  }

  setLipsColor(color: number): void {
    this.lipsColor = color;
    this.draw();
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.draw();
  }

  draw(): void {
    const { gfx, openness, lipsColor, w, h } = this;
    gfx.clear();

    // geometry: scale to widget bounds with horizontal padding
    const padX = w * 0.13;
    const cx = w / 2;
    // slightly below center feels more natural on a rectangular widget
    const cy = h * 0.5;
    const mouthW = w - padX * 2;
    const maxGapHalf = mouthW * 0.20;
    const lipH = mouthW * 0.115;
    const cupidDip = lipH * 0.42;

    // mouths widen slightly as they open
    const stretch = 1 + openness * 0.08;
    const hw = (mouthW / 2) * stretch;
    const lx = cx - hw;
    const rx = cx + hw;

    const gapHalf = openness * maxGapHalf;
    const upperBotY = cy - gapHalf;
    const lowerTopY = cy + gapHalf;
    const upperTopY = upperBotY - lipH;
    const lowerBotY = lowerTopY + lipH;

    const strokeColor = darkenHex(lipsColor, 0.7);

    // -- inner mouth cavity (fades in as mouth opens) --
    if (openness > 0.04) {
      const alpha = Math.min(1, (openness - 0.04) / 0.12);
      gfx.moveTo(lx, cy);
      gfx.bezierCurveTo(lx + hw * 0.28, upperBotY, rx - hw * 0.28, upperBotY, rx, cy);
      gfx.bezierCurveTo(rx - hw * 0.28, lowerTopY, lx + hw * 0.28, lowerTopY, lx, cy);
      gfx.closePath();
      gfx.fill({ color: 0x1a0508, alpha });
    }

    // -- teeth: row of slightly off-white rounded rects --
    if (openness > 0.18) {
      const alpha = Math.min(1, (openness - 0.18) / 0.18);
      const teethTop = upperBotY + 1.5;
      const teethH = Math.max(2, gapHalf * 0.52);
      const toothCount = 5;
      const totalW = hw * 1.15;
      const toothW = totalW / toothCount - 1.8;
      const startX = cx - totalW / 2;
      for (let i = 0; i < toothCount; i++) {
        const tx = startX + i * (toothW + 1.8);
        gfx.roundRect(tx, teethTop, toothW, teethH, 2);
      }
      gfx.fill({ color: 0xf5eee0, alpha });
    }

    // -- tongue: rises from the lower lip when mouth is wide open --
    if (openness > 0.48) {
      const alpha = Math.min(1, (openness - 0.48) / 0.28);
      const rise = (openness - 0.48) / 0.52;
      const tongueH = Math.max(1, gapHalf * 0.48 * rise);
      const tongueW = hw * 0.72;
      // ellipse centered just above the lower lip inner edge
      gfx.ellipse(cx, lowerTopY, tongueW / 2, tongueH / 2);
      gfx.fill({ color: 0xe05878, alpha });
    }

    // -- upper lip: filled bezier shape with cupid's bow inner edge --
    // outer arc: left corner → top peak → right corner
    gfx.moveTo(lx, cy);
    gfx.bezierCurveTo(lx + hw * 0.22, upperTopY, rx - hw * 0.22, upperTopY, rx, cy);
    // inner arc back with cupid's bow dip at center
    gfx.bezierCurveTo(
      rx - hw * 0.18, upperBotY,
      cx + hw * 0.14, upperBotY + cupidDip,
      cx, upperBotY + cupidDip
    );
    gfx.bezierCurveTo(
      cx - hw * 0.14, upperBotY + cupidDip,
      lx + hw * 0.18, upperBotY,
      lx, cy
    );
    gfx.closePath();
    gfx.fill({ color: lipsColor });
    // stroke outer edge only
    gfx.moveTo(lx, cy);
    gfx.bezierCurveTo(lx + hw * 0.22, upperTopY, rx - hw * 0.22, upperTopY, rx, cy);
    gfx.stroke({ color: strokeColor, width: 1.2 });

    // -- lower lip: filled bezier shape --
    gfx.moveTo(lx, cy);
    gfx.bezierCurveTo(lx + hw * 0.18, lowerTopY, rx - hw * 0.18, lowerTopY, rx, cy);
    gfx.bezierCurveTo(rx - hw * 0.14, lowerBotY, lx + hw * 0.14, lowerBotY, lx, cy);
    gfx.closePath();
    gfx.fill({ color: lipsColor });
    // stroke outer edge only
    gfx.moveTo(rx, cy);
    gfx.bezierCurveTo(rx - hw * 0.14, lowerBotY, lx + hw * 0.14, lowerBotY, lx, cy);
    gfx.stroke({ color: strokeColor, width: 1.2 });
  }

  destroy(): void {
    this.gfx.destroy();
  }
}

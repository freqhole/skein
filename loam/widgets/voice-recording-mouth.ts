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

/** samples per second in a precomputed playback envelope */
export const ENVELOPE_HZ = 30;

/** clamp a lip thickness value to the 1..10 range the widget exposes */
export function clampThickness(t: number): number {
  if (!Number.isFinite(t)) return 5;
  return Math.max(1, Math.min(10, t));
}

/**
 * precompute an rms envelope from decoded pcm samples: one rms value per
 * 1/hz seconds of audio. the playback mouth animation indexes this by
 * audioEl.currentTime instead of tapping a live AnalyserNode — webkit (the
 * tauri wkwebview) doesn't reliably route media-element audio through the
 * webaudio graph, so a live tap reads silence there.
 */
export function computeRmsEnvelope(
  samples: Float32Array,
  sampleRate: number,
  hz: number = ENVELOPE_HZ
): Float32Array {
  const window = Math.max(1, Math.floor(sampleRate / hz));
  const count = Math.max(1, Math.ceil(samples.length / window));
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const start = i * window;
    const end = Math.min(samples.length, start + window);
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += samples[j] * samples[j];
    }
    out[i] = end > start ? Math.sqrt(sum / (end - start)) : 0;
  }
  return out;
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
  /** 1 (thin) .. 10 (plump); scales the lip band height around the default 5 */
  private lipThickness: number;
  private w: number;
  private h: number;

  constructor(
    parent: Container,
    width: number,
    height: number,
    lipsColor: number,
    lipThickness = 5
  ) {
    this.w = width;
    this.h = height;
    this.lipsColor = lipsColor;
    this.lipThickness = clampThickness(lipThickness);
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
    if (color === this.lipsColor) return;
    this.lipsColor = color;
    this.draw();
  }

  setLipThickness(thickness: number): void {
    const t = clampThickness(thickness);
    if (t === this.lipThickness) return;
    this.lipThickness = t;
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
    // thickness 1..10 maps to ~0.45x..1.6x of the default lip band height
    const thicknessScale = 0.45 + ((this.lipThickness - 1) / 9) * 1.15;
    const lipH = mouthW * 0.115 * thicknessScale;
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

    // -- teeth: upper row descending from the upper lip --
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

    // -- teeth: lower row rising from the lower lip (slightly smaller and
    // dimmer than the uppers, like real mouths) --
    if (openness > 0.26) {
      const alpha = Math.min(1, (openness - 0.26) / 0.2) * 0.92;
      const teethH = Math.max(1.5, gapHalf * 0.38);
      const teethBot = lowerTopY - 1.5;
      const toothCount = 6;
      const totalW = hw * 1.0;
      const toothW = totalW / toothCount - 1.6;
      const startX = cx - totalW / 2;
      for (let i = 0; i < toothCount; i++) {
        const tx = startX + i * (toothW + 1.6);
        gfx.roundRect(tx, teethBot - teethH, toothW, teethH, 1.5);
      }
      gfx.fill({ color: 0xe9e0d0, alpha });
    }

    // -- tongue: resting on the lower lip, rising and rounding as the mouth
    // opens. two stacked ellipses give it a center groove.  --
    if (openness > 0.3) {
      const alpha = Math.min(1, (openness - 0.3) / 0.2);
      const rise = (openness - 0.3) / 0.7;
      const tongueH = Math.max(1.5, gapHalf * 0.62 * rise);
      const tongueW = hw * 0.78;
      const tongueCy = lowerTopY - tongueH * 0.25;
      gfx.ellipse(cx, tongueCy, tongueW / 2, tongueH / 2);
      gfx.fill({ color: 0xe05878, alpha });
      // center groove: a subtle darker crease down the middle
      gfx.ellipse(cx, tongueCy - tongueH * 0.08, tongueW * 0.06, tongueH * 0.34);
      gfx.fill({ color: darkenHex(0xe05878, 0.78), alpha: alpha * 0.7 });
      // highlight: small lighter sheen on the front
      gfx.ellipse(cx - tongueW * 0.18, tongueCy + tongueH * 0.1, tongueW * 0.13, tongueH * 0.16);
      gfx.fill({ color: 0xf07a95, alpha: alpha * 0.6 });
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

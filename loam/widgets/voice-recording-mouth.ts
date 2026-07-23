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

/** resting/animating mouth curvature: frown (sad), neutral (default), or smile (happy) */
export type Mood = "frown" | "neutral" | "smile";

/** teeth row shape: a flat row (straight) or one that hugs the mood-curved lip line (curved) */
export type TeethStyle = "straight" | "curved";

/** clamp a lip thickness value to the 1..10 range the widget exposes */
export function clampThickness(t: number): number {
  if (!Number.isFinite(t)) return 5;
  return Math.max(1, Math.min(10, t));
}

/** clamp a cupid's bow prominence value to the 0..10 range the widget exposes */
export function clampBowAmount(a: number): number {
  if (!Number.isFinite(a)) return 4;
  return Math.max(0, Math.min(10, a));
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
  /** cavity + teeth + tongue, clipped to the mouth-opening shape via `maskGfx` */
  private readonly innerGfx: Graphics;
  /** geometry-only mask matching the current mouth-opening shape; never rendered itself */
  private readonly maskGfx: Graphics;
  private openness = 0;
  private lipsColor: number;
  /** 1 (thin) .. 10 (plump); scales the lip band height around the default 5 */
  private lipThickness: number;
  /** resting/animating mouth curvature */
  private mood: Mood;
  /** flat teeth row vs. one that hugs the mood-curved lip line */
  private teethStyle: TeethStyle;
  /** 0 (no bow, plain arc) .. 10 (fully pronounced double-peak bow) */
  private cupidBowAmount: number;
  private w: number;
  private h: number;

  constructor(
    parent: Container,
    width: number,
    height: number,
    lipsColor: number,
    lipThickness = 5,
    mood: Mood = "neutral",
    teethStyle: TeethStyle = "straight",
    cupidBowAmount = 4
  ) {
    this.w = width;
    this.h = height;
    this.lipsColor = lipsColor;
    this.lipThickness = clampThickness(lipThickness);
    this.mood = mood;
    this.teethStyle = teethStyle;
    this.cupidBowAmount = clampBowAmount(cupidBowAmount);
    this.innerGfx = new Graphics();
    this.innerGfx.eventMode = "none";
    parent.addChild(this.innerGfx);
    // the mask must be a normal child (added + `renderable` left true) for
    // pixi to build its geometry for the stencil pass — `renderable =
    // false` blocks that too, not just its normal draw, and silently masks
    // everything away. `alpha = 0` hides it visually without touching the
    // flags the mask system depends on.
    this.maskGfx = new Graphics();
    this.maskGfx.eventMode = "none";
    this.maskGfx.alpha = 0;
    parent.addChild(this.maskGfx);
    this.innerGfx.mask = this.maskGfx;
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

  setMood(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.draw();
  }

  setTeethStyle(style: TeethStyle): void {
    if (style === this.teethStyle) return;
    this.teethStyle = style;
    this.draw();
  }

  setCupidBowAmount(amount: number): void {
    const a = clampBowAmount(amount);
    if (a === this.cupidBowAmount) return;
    this.cupidBowAmount = a;
    this.draw();
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.draw();
  }

  draw(): void {
    const { gfx, innerGfx, maskGfx, openness, lipsColor, mood, teethStyle, w, h } = this;
    gfx.clear();
    innerGfx.clear();
    maskGfx.clear();

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
    // mood pulls the mouth corners up (smile) or down (frown); this scales
    // with lip thickness (thicker lips → taller lipH → a bigger corner
    // pull), computed early since the idle-grin floor below needs to scale
    // the same way.
    const maxMoodShift = lipH * 1.3;

    // a resting/idle smile is a full toothy grin, not just a sliver of
    // upper teeth — give smile mood a baseline opening floor (independent
    // of actual talking volume) high enough to clear both the upper AND
    // lower teeth reveal thresholds below. tied to maxMoodShift (rather
    // than a flat constant) so it scales with lip thickness: thicker lips
    // pull the corners further via maxMoodShift, so the reveal gap needs
    // to grow to match or the grin looks undersized/pinched relative to
    // how far the corners lifted, and the mask (which also moves with the
    // corners) can end up clipping the outer teeth. this floor is allowed
    // to exceed the tongue threshold checked further down because tongue
    // visibility there is gated on raw talking volume, not this floor — so
    // a big idle grin never shows tongue no matter how large this gets.
    // neutral/frown get no such floor.
    const smileGapBonus =
      mood === "smile" ? Math.min(0.45, (maxMoodShift * 0.55) / maxGapHalf) : 0;
    // every mood keeps at least a sliver of a gap, even fully at rest — a
    // truly closed mouth still shows a thin dark line where the lips meet,
    // never a single seamless colored shape. kept well below the teeth
    // reveal thresholds so neutral/frown stay toothless at rest.
    const restGapFraction = 0.1;
    const effectiveOpenness = Math.max(openness, restGapFraction, smileGapBonus);
    const gapHalf = effectiveOpenness * maxGapHalf;

    // mouths widen as they open, and a grin spreads the corners outward
    // further still — a toothy smile isn't just taller, it's noticeably
    // wider than a neutral mouth at the same opening. also scaled by
    // thicknessScale: thicker lips need the extra width more, to keep the
    // outer teeth clear of the mask's pinched corners.
    const moodStretchBonus = mood === "smile" ? 0.05 + 0.05 * thicknessScale : 0;
    const stretch = 1 + effectiveOpenness * 0.08 + moodStretchBonus;
    const hw = (mouthW / 2) * stretch;
    const lx = cx - hw;
    const rx = cx + hw;

    // mood pulls the mouth CORNERS up (smile) or down (frown) by the full
    // amount, and nudges the rest of the band (teeth, tongue, cavity, lip
    // curves) by a smaller fraction so the whole mouth moves together
    // instead of only the corners shifting — otherwise the teeth/cavity
    // stay anchored to the true center while the corners droop/lift away
    // from them, creating gaps or overlap at the lip line.
    const moodOffset = mood === "smile" ? maxMoodShift : mood === "frown" ? -maxMoodShift : 0;
    const cornerY = cy - moodOffset;
    // smiling pulls the corners up a lot, but the reveal band itself
    // shouldn't rise nearly as much — a small fraction keeps both teeth
    // rows sitting closer to vertical center instead of hugging the top of
    // the mouth, which is where they ended up with the same -0.3 fraction
    // frowning uses (frowning wants the opposite: a bigger pull, handled
    // below).
    const upperCenterShift = mood === "smile" ? moodOffset * -0.1 : moodOffset * -0.3;
    // the lower half gets pulled down further than the upper half when
    // frowning specifically — user feedback repeatedly found the bottom
    // teeth "still too high" with a symmetric shift, and only the bottom
    // row was ever reported as needing it (the top row should stay put).
    const lowerCenterShift =
      mood === "frown" ? moodOffset * -0.65 : mood === "smile" ? moodOffset * -0.1 : moodOffset * -0.3;

    const upperBotY = cy - gapHalf + upperCenterShift;
    const lowerTopY = cy + gapHalf + lowerCenterShift;
    const upperTopY = upperBotY - lipH;
    const lowerBotY = lowerTopY + lipH;
    // the lower lip's inner edge is a single symmetric bezier (both control
    // points at the same y) — that shape only reaches 75% of the way from
    // corner to control point at its midpoint, so the control point is
    // pulled further than lowerTopY itself to correct for it. this control
    // point is shared verbatim between the actual lower lip curve and the
    // cavity trace below, so the two are drawn from identical geometry —
    // there's no way for a gap or overlap to appear between the black
    // cavity and the lip color, since they're literally the same path.
    const lowerInnerCtrlY = cornerY + (lowerTopY - cornerY) * (4 / 3);
    // a smiling mouth's cupid's bow dip looks disproportionately "saggy"
    // in the middle once the corners lift a lot, hiding the middle teeth
    // behind it — shallow it out for smile specifically so more of the
    // middle teeth show. shared between the cavity trace and the actual
    // upper lip curve below so they still match exactly.
    const effectiveCupidDip = mood === "smile" ? cupidDip * 0.45 : cupidDip;

    // the mouth-opening shape (same outline for the mask and the cavity
    // fill) — everything drawn into `innerGfx` (cavity, teeth, tongue) gets
    // clipped to this path, so teeth/tongue can never poke out above the
    // upper lip or below the lower lip, even when mood curvature pulls the
    // corners well away from the true vertical center. this reuses the
    // exact same control points as the visible upper/lower lip inner edges
    // further down, rather than an independently-tuned approximation — any
    // mismatch between the two was the source of a visible gap between the
    // black cavity and the lip color.
    const traceCavity = (g: Graphics): void => {
      g.moveTo(lx, cornerY);
      g.bezierCurveTo(
        lx + hw * 0.18, upperBotY,
        cx - hw * 0.14, upperBotY + effectiveCupidDip,
        cx, upperBotY + effectiveCupidDip
      );
      g.bezierCurveTo(
        cx + hw * 0.14, upperBotY + effectiveCupidDip,
        rx - hw * 0.18, upperBotY,
        rx, cornerY
      );
      g.bezierCurveTo(rx - hw * 0.18, lowerInnerCtrlY, lx + hw * 0.18, lowerInnerCtrlY, lx, cornerY);
      g.closePath();
    };

    traceCavity(maskGfx);
    maskGfx.fill({ color: 0xffffff });

    // -- inner mouth cavity: always visible, even with the mouth fully at
    // rest — a mouth is never a single sealed, colorless shape, there's
    // always a dark gap where the lips meet. solid black immediately
    // (no fade-in) so animating through small opennesses never shows a
    // seam/gap while alpha "catches up" to the gap size. --
    traceCavity(innerGfx);
    innerGfx.fill({ color: 0x000000 });

    // -- teeth: upper row descending from the upper lip. flat by default
    // ("straight") — in "curved" style each tooth instead tracks the
    // mood-curved mouth-opening boundary at its own x position (center →
    // corner) so the outer teeth hug the lip line instead of leaving a gap
    // near the corners. --
    if (effectiveOpenness > 0.18) {
      // real teeth stay close to a fixed size (tied to lip thickness)
      // rather than stretching taller the wider the mouth opens — it's the
      // GAP between the rows that should grow. "retreat" pulls the whole
      // row further away from center as the mouth opens past the reveal
      // threshold, so talking visibly moves the teeth out of the way
      // instead of just leaving them hugging the lip line while the
      // opening grows around them. capped at a fraction of lipH so it can
      // never push the row out past the mask boundary near the corners.
      const teethH = Math.max(2, lipH * 0.6 + gapHalf * 0.15);
      const retreat = Math.min(lipH * 0.9, Math.max(0, gapHalf - maxGapHalf * 0.18) * 0.9);
      const toothCount = 5;
      const totalW = hw * 1.15;
      const toothW = totalW / toothCount - 1.8;
      const startX = cx - totalW / 2;
      // straight rows stay flat for neutral/frown, but a smile lifts the
      // corners so much that a flat row leaves a visible gap between the
      // outer teeth and the corners — lean the outer teeth up toward the
      // corner curve at half strength, enough to close that gap without
      // the fuller per-tooth stagger "curved" style produces.
      const cornerLean = teethStyle === "curved" ? 1 : mood === "smile" ? 0.5 : 0;
      for (let i = 0; i < toothCount; i++) {
        const tx = startX + i * (toothW + 1.8);
        const u = cornerLean * Math.min(1, Math.abs(tx + toothW / 2 - cx) / hw);
        const localTop = upperBotY + (cornerY - upperBotY) * u * u + 1.5 - retreat;
        innerGfx.roundRect(tx, localTop, toothW, teethH, 2);
      }
      innerGfx.fill({ color: 0xf5eee0 });
    }

    // -- tongue: resting on the lower lip, rising and rounding as the mouth
    // opens. drawn BEFORE the lower teeth so the teeth sit in front of it
    // (a tongue in front of the bottom teeth isn't anatomically sound).
    // two stacked ellipses give it a center groove. gated on raw talking
    // volume (not effectiveOpenness) so mood-driven floors (e.g. the idle
    // smile grin above) never reveal tongue on their own — only actually
    // opening the mouth wide while talking does. --
    if (openness > 0.3) {
      const alpha = Math.min(1, (openness - 0.3) / 0.2);
      const rise = (openness - 0.3) / 0.7;
      const tongueH = Math.max(2, gapHalf * 0.85 * rise);
      const tongueW = hw * 0.92;
      const tongueCy = lowerTopY - tongueH * 0.42;
      innerGfx.ellipse(cx, tongueCy, tongueW / 2, tongueH / 2);
      innerGfx.fill({ color: 0xe05878, alpha });
      // center groove: a subtle darker crease down the middle
      innerGfx.ellipse(cx, tongueCy - tongueH * 0.08, tongueW * 0.06, tongueH * 0.34);
      innerGfx.fill({ color: darkenHex(0xe05878, 0.78), alpha: alpha * 0.7 });
      // highlight: small lighter sheen on the front
      innerGfx.ellipse(cx - tongueW * 0.18, tongueCy + tongueH * 0.1, tongueW * 0.13, tongueH * 0.16);
      innerGfx.fill({ color: 0xf07a95, alpha: alpha * 0.6 });
    }

    // -- teeth: lower row rising from the lower lip (slightly smaller than
    // the uppers, like real mouths) — drawn AFTER the tongue so they sit in
    // front of it. flat by default ("straight"); the extra frown-mood
    // downshift already lives in lowerTopY itself (see lowerCenterShift
    // above), so this row automatically drops further for a frown without
    // needing its own separate lean. "curved" style varies the lean per
    // tooth for a fuller curve. --
    if (effectiveOpenness > 0.26) {
      // same fixed-size + retreat treatment as the upper row, mirrored
      // downward, so the bottom row pulls away from center as the mouth
      // opens instead of just growing taller in place.
      const teethH = Math.max(2, lipH * 0.55 + gapHalf * 0.15);
      const retreat = Math.min(lipH * 0.9, Math.max(0, gapHalf - maxGapHalf * 0.26) * 0.9);
      const toothCount = 6;
      const totalW = hw * 1.0;
      const toothW = totalW / toothCount - 1.6;
      const startX = cx - totalW / 2;
      // same corner-gap fix as the upper row, mirrored for the bottom lip.
      const cornerLean = teethStyle === "curved" ? 1 : mood === "smile" ? 0.5 : 0;
      for (let i = 0; i < toothCount; i++) {
        const tx = startX + i * (toothW + 1.6);
        const u = cornerLean * Math.min(1, Math.abs(tx + toothW / 2 - cx) / hw);
        const localBot = lowerTopY + (cornerY - lowerTopY) * u * u - 1.5 + retreat;
        innerGfx.roundRect(tx, localBot - teethH, toothW, teethH, 1.5);
      }
      innerGfx.fill({ color: 0xe9e0d0 });
    }

    // -- upper lip: filled bezier shape with cupid's bow on both edges --
    // outer arc: left corner → left peak → center dip → right peak → right
    // corner. the two peaks with a shallow dip between them are the
    // cupid's bow silhouette; without them the top edge is just a plain
    // arc with no bow shape at all. cupidBowAmount (0..10) scales how far
    // the peaks/dip depart from a plain arc — 0 collapses them back to one.
    const bowScale = this.cupidBowAmount / 10;
    const bowPeakX = hw * 0.16;
    const bowPeakY = upperTopY - lipH * 0.22 * bowScale;
    const bowDipY = upperTopY + lipH * 0.1 * bowScale;
    gfx.moveTo(lx, cornerY);
    gfx.bezierCurveTo(
      lx + hw * 0.32, upperTopY,
      cx - bowPeakX - hw * 0.06, bowPeakY,
      cx - bowPeakX, bowPeakY
    );
    gfx.bezierCurveTo(cx - bowPeakX * 0.3, bowDipY, cx + bowPeakX * 0.3, bowDipY, cx + bowPeakX, bowPeakY);
    gfx.bezierCurveTo(
      cx + bowPeakX + hw * 0.06, bowPeakY,
      rx - hw * 0.32, upperTopY,
      rx, cornerY
    );
    // inner arc back with the (mood-adjusted) cupid's bow dip at center
    gfx.bezierCurveTo(
      rx - hw * 0.18, upperBotY,
      cx + hw * 0.14, upperBotY + effectiveCupidDip,
      cx, upperBotY + effectiveCupidDip
    );
    gfx.bezierCurveTo(
      cx - hw * 0.14, upperBotY + effectiveCupidDip,
      lx + hw * 0.18, upperBotY,
      lx, cornerY
    );
    gfx.closePath();
    gfx.fill({ color: lipsColor });

    // -- lower lip: filled bezier shape --
    gfx.moveTo(lx, cornerY);
    gfx.bezierCurveTo(lx + hw * 0.18, lowerInnerCtrlY, rx - hw * 0.18, lowerInnerCtrlY, rx, cornerY);
    gfx.bezierCurveTo(rx - hw * 0.14, lowerBotY, lx + hw * 0.14, lowerBotY, lx, cornerY);
    gfx.closePath();
    gfx.fill({ color: lipsColor });
  }

  destroy(): void {
    this.gfx.destroy();
    this.innerGfx.destroy();
    this.maskGfx.destroy();
  }
}

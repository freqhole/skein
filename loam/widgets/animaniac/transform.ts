/**
 * `resolveTransformAt()` — the one function `compositor.ts` calls to know
 * where/how-big/how-rotated/how-opaque to draw a clip's sprite at a given
 * local time. pure, no pixi dependency. phase-1 clips have exactly one
 * keyframe (no interpolation, just returns it); this function is written
 * to handle N keyframes from day one so phase-5 motion tweening is
 * additive (new keyframes + UI to add them) rather than a rework of
 * playback/compositor code — see docs/animaniac-plan.md's motion-tweening
 * section.
 */

import type { EasingId, Keyframe } from "./types";

export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
}

export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };

/** standard easing curves — `easing` on keyframe A (the segment's start)
 *  governs the whole A->B interpolation, matching the common animation-
 *  tool convention ("ease out of A"). */
function ease(id: EasingId, p: number): number {
  switch (id) {
    case "ease-in":
      return p * p;
    case "ease-out":
      return 1 - (1 - p) * (1 - p);
    case "ease-in-out":
      return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    default:
      return p;
  }
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

/** shortest-path angle interpolation (radians) — avoids a 350°->10°
 *  rotation spinning the long way around through 180°. */
function lerpAngle(a: number, b: number, p: number): number {
  let delta = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return a + delta * p;
}

function toTransform(kf: Keyframe): Transform {
  return { x: kf.x, y: kf.y, scaleX: kf.scaleX, scaleY: kf.scaleY, rotation: kf.rotation, opacity: kf.opacity };
}

/** resolves a clip's transform at `t` seconds after the clip's own start
 *  (NOT the timeline's absolute time — callers subtract the clip's
 *  `start` first). keyframes are consulted in `t` order regardless of
 *  their array order (a caller/UI bug shouldn't be able to produce
 *  out-of-order interpolation). */
export function resolveTransformAt(keyframes: readonly Keyframe[], t: number): Transform {
  if (keyframes.length === 0) return IDENTITY_TRANSFORM;
  if (keyframes.length === 1) return toTransform(keyframes[0]);

  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  if (t <= sorted[0].t) return toTransform(sorted[0]);
  const last = sorted[sorted.length - 1];
  if (t >= last.t) return toTransform(last);

  let a = sorted[0];
  let b = sorted[sorted.length - 1];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (t >= sorted[i].t && t <= sorted[i + 1].t) {
      a = sorted[i];
      b = sorted[i + 1];
      break;
    }
  }
  const span = b.t - a.t;
  const rawP = span > 0 ? (t - a.t) / span : 1;
  const p = ease(a.easing, Math.max(0, Math.min(1, rawP)));
  return {
    x: lerp(a.x, b.x, p),
    y: lerp(a.y, b.y, p),
    scaleX: lerp(a.scaleX, b.scaleX, p),
    scaleY: lerp(a.scaleY, b.scaleY, p),
    rotation: lerpAngle(a.rotation, b.rotation, p),
    opacity: lerp(a.opacity, b.opacity, p),
  };
}

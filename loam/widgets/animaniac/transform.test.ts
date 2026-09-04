import { describe, expect, it } from "vitest";
import { IDENTITY_TRANSFORM, resolveTransformAt } from "./transform";
import type { Keyframe } from "./types";

function kf(overrides: Partial<Keyframe>): Keyframe {
  return { t: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, easing: "linear", ...overrides };
}

describe("resolveTransformAt", () => {
  it("returns the identity transform for an empty keyframe list", () => {
    expect(resolveTransformAt([], 5)).toEqual(IDENTITY_TRANSFORM);
  });

  it("returns the single keyframe's values regardless of t (phase-1 static clip)", () => {
    const k = kf({ t: 3, x: 10, y: 20, scale: 2, rotation: 1, opacity: 0.5 });
    expect(resolveTransformAt([k], 0)).toEqual({ x: 10, y: 20, scale: 2, rotation: 1, opacity: 0.5 });
    expect(resolveTransformAt([k], 999)).toEqual({ x: 10, y: 20, scale: 2, rotation: 1, opacity: 0.5 });
  });

  it("clamps to the first/last keyframe before/after the covered range", () => {
    const a = kf({ t: 0, x: 0 });
    const b = kf({ t: 10, x: 100 });
    expect(resolveTransformAt([a, b], -5).x).toBe(0);
    expect(resolveTransformAt([a, b], 15).x).toBe(100);
  });

  it("linearly interpolates x/y/scale/opacity at the midpoint", () => {
    const a = kf({ t: 0, x: 0, y: 0, scale: 1, opacity: 0, easing: "linear" });
    const b = kf({ t: 10, x: 100, y: 50, scale: 3, opacity: 1 });
    const mid = resolveTransformAt([a, b], 5);
    expect(mid.x).toBe(50);
    expect(mid.y).toBe(25);
    expect(mid.scale).toBe(2);
    expect(mid.opacity).toBe(0.5);
  });

  it("picks the correct bracketing pair among 3+ keyframes", () => {
    const a = kf({ t: 0, x: 0 });
    const b = kf({ t: 10, x: 100 });
    const c = kf({ t: 20, x: 0 });
    expect(resolveTransformAt([a, b, c], 15).x).toBe(50);
  });

  it("sorts out-of-array-order keyframes by t before interpolating", () => {
    const a = kf({ t: 0, x: 0 });
    const b = kf({ t: 10, x: 100 });
    // b listed before a in the array — should not affect the result
    expect(resolveTransformAt([b, a], 5).x).toBe(50);
  });

  it("applies ease-in/ease-out asymmetrically (not a straight line)", () => {
    const a = kf({ t: 0, x: 0, easing: "ease-in" });
    const b = kf({ t: 10, x: 100 });
    const mid = resolveTransformAt([a, b], 5).x;
    expect(mid).toBeLessThan(50); // ease-in starts slow
  });

  it("interpolates rotation the short way around a wraparound boundary", () => {
    const a = kf({ t: 0, rotation: -0.1 });
    const b = kf({ t: 10, rotation: 0.1 });
    const mid = resolveTransformAt([a, b], 5).rotation;
    expect(mid).toBeCloseTo(0, 5);
  });
});

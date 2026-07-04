import { describe, expect, it } from "vitest";
import { findEmptySpot, type LayoutRect } from "./layout-placement";

describe("findEmptySpot", () => {
  it("returns the start position on an empty canvas", () => {
    const result = findEmptySpot([], 280, 200);
    expect(result).toEqual({ x: 60, y: 60 });
  });

  it("respects custom startX/startY on an empty canvas", () => {
    const result = findEmptySpot([], 280, 200, { startX: 10, startY: 20 });
    expect(result).toEqual({ x: 10, y: 20 });
  });

  it("skips to the next slot when the first candidate overlaps an existing widget", () => {
    const existing: LayoutRect[] = [{ x: 60, y: 60, width: 280, height: 200 }];
    const result = findEmptySpot(existing, 280, 200);
    // first candidate (60,60) collides with the existing widget exactly —
    // next column over (280 + 20 gap = 300px further right) should be free.
    expect(result).toEqual({ x: 360, y: 60 });
  });

  it("skips multiple occupied slots in row-major order", () => {
    const existing: LayoutRect[] = [
      { x: 60, y: 60, width: 280, height: 200 },
      { x: 360, y: 60, width: 280, height: 200 },
    ];
    const result = findEmptySpot(existing, 280, 200);
    expect(result).toEqual({ x: 660, y: 60 });
  });

  it("does not treat edge-touching rects as overlapping (exact-fit scenario)", () => {
    // a widget placed exactly where the first candidate's right edge would
    // land — touching, not overlapping — should NOT block that candidate.
    const existing: LayoutRect[] = [{ x: 340, y: 60, width: 280, height: 200 }];
    const result = findEmptySpot(existing, 280, 200);
    expect(result).toEqual({ x: 60, y: 60 });
  });

  it("falls back to below the bounding box when the grid is too dense to find a gap", () => {
    // fill every candidate slot within a small scan bound with an
    // overlapping widget so no gap can ever be found.
    const maxScan = 2;
    const existing: LayoutRect[] = [];
    for (let row = 0; row < maxScan; row++) {
      for (let col = 0; col < maxScan; col++) {
        existing.push({ x: 60 + col * 300, y: 60 + row * 220, width: 280, height: 200 });
      }
    }
    const result = findEmptySpot(existing, 280, 200, { maxScan });
    const maxBottom = Math.max(...existing.map((r) => r.y + r.height));
    expect(result).toEqual({ x: 60, y: maxBottom + 20 });
  });

  it("falls back to the start position when existingRects is empty even with a tiny maxScan", () => {
    const result = findEmptySpot([], 280, 200, { maxScan: 1 });
    expect(result).toEqual({ x: 60, y: 60 });
  });

  it("uses a custom gridStep when scanning candidates", () => {
    const existing: LayoutRect[] = [{ x: 60, y: 60, width: 280, height: 200 }];
    const result = findEmptySpot(existing, 280, 200, { gridStep: 10 });
    expect(result).toEqual({ x: 350, y: 60 });
  });
});

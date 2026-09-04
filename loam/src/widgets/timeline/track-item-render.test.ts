import { describe, expect, it } from "vitest";
import { cursorForRegion, hitDeleteGlyph, modeForLocalX } from "./track-item-render";

describe("hitDeleteGlyph", () => {
  it("hits within the circular radius around (right - 2, marginY)", () => {
    expect(hitDeleteGlyph(100, 3, 98, 3)).toBe(true);
    expect(hitDeleteGlyph(100, 3, 98, 10)).toBe(true); // within radius 8
  });

  it("misses outside the circular radius", () => {
    expect(hitDeleteGlyph(100, 3, 98, 20)).toBe(false);
    expect(hitDeleteGlyph(100, 3, 50, 3)).toBe(false);
  });
});

describe("modeForLocalX", () => {
  it("resolves resize-left/resize-right near a wide item's edges", () => {
    expect(modeForLocalX(0, 100, 2)).toBe("resize-left");
    expect(modeForLocalX(0, 100, 98)).toBe("resize-right");
  });

  it("resolves move in the middle of a wide item", () => {
    expect(modeForLocalX(0, 100, 50)).toBe("move");
  });

  it("caps the handle zone to a third of a narrow item's width so move stays reachable", () => {
    // width 12 -> handlePx capped to 4 (12/3), not the default 8
    expect(modeForLocalX(0, 12, 6)).toBe("move");
    expect(modeForLocalX(0, 12, 1)).toBe("resize-left");
    expect(modeForLocalX(0, 12, 11)).toBe("resize-right");
  });

  it("picks whichever edge is closer on ties/overlap", () => {
    expect(modeForLocalX(0, 10, 3)).toBe("resize-left");
    expect(modeForLocalX(0, 10, 7)).toBe("resize-right");
  });
});

describe("cursorForRegion", () => {
  it("maps every region to its expected cursor", () => {
    expect(cursorForRegion("delete")).toBe("pointer");
    expect(cursorForRegion("resize-left")).toBe("w-resize");
    expect(cursorForRegion("resize-right")).toBe("e-resize");
    expect(cursorForRegion("move")).toBe("grab");
    expect(cursorForRegion(null)).toBe("crosshair");
  });
});

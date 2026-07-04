// ---------------------------------------------------------------------------
// pure grid-scan helper for placing a new widget in an empty spot on a
// canvas, instead of the naive "stagger by total widget count" math
// previously used at every canvas-card placement call site in boot.ts (see
// docs/narthex-widgets-and-file-transfer-plan.md section 2). count-based
// staggering ignores actual occupied space, so it collides with
// manually-moved widgets, the narthex's own seeded label/markdown widgets,
// or anything else already sitting near the default stagger positions.
//
// this is a pure function — no pixi/DOM/automerge involved — fully
// unit-testable in isolation.
// ---------------------------------------------------------------------------

/** an axis-aligned bounding box — matches the subset of `WidgetEntry`
 *  (canvas-doc.ts) fields relevant to placement. */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FindEmptySpotOptions {
  /** left edge of the first candidate slot. defaults to 60 (matches the
   *  narthex's previous hardcoded stagger's own starting offset). */
  startX?: number;
  /** top edge of the first candidate slot. defaults to 60. */
  startY?: number;
  /** gap (px) left between adjacent candidate slots, both axes. defaults
   *  to 20. */
  gridStep?: number;
  /** maximum number of candidate slots scanned per axis before giving up
   *  and falling back (see below) — bounds the scan so a pathologically
   *  dense canvas can never loop forever. defaults to 20 (up to 20x20 =
   *  400 candidates scanned). */
  maxScan?: number;
}

/** simple AABB overlap test — true if `a` and `b` overlap by any nonzero
 *  area. rects that merely touch at an edge (e.g. `a.x + a.width ===
 *  b.x`) do NOT count as overlapping. */
function rectsOverlap(a: LayoutRect, b: LayoutRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * scan a row-major grid of candidate `newWidth`x`newHeight` slots, starting
 * near `(startX, startY)`, and return the first one that doesn't overlap
 * any rect in `existingRects`.
 *
 * falls back to a position below the combined bounding box of every
 * existing rect if no gap is found within `maxScan`x`maxScan` candidates —
 * this never loops forever, even against a canvas dense enough that no
 * empty grid cell exists within the bounded scan.
 */
export function findEmptySpot(
  existingRects: LayoutRect[],
  newWidth: number,
  newHeight: number,
  opts: FindEmptySpotOptions = {}
): { x: number; y: number } {
  const startX = opts.startX ?? 60;
  const startY = opts.startY ?? 60;
  const gridStep = opts.gridStep ?? 20;
  const maxScan = opts.maxScan ?? 20;

  const stepX = newWidth + gridStep;
  const stepY = newHeight + gridStep;

  for (let row = 0; row < maxScan; row++) {
    for (let col = 0; col < maxScan; col++) {
      const candidate: LayoutRect = {
        x: startX + col * stepX,
        y: startY + row * stepY,
        width: newWidth,
        height: newHeight,
      };
      const collides = existingRects.some((r) => rectsOverlap(candidate, r));
      if (!collides) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }

  // fallback — no gap found within the bounded scan. append just below the
  // combined bounding box of every existing rect, so the new widget is at
  // least visible/reachable rather than stacked exactly on top of something.
  if (existingRects.length === 0) {
    return { x: startX, y: startY };
  }
  const maxBottom = Math.max(...existingRects.map((r) => r.y + r.height));
  return { x: startX, y: maxBottom + gridStep };
}

import {
  CRATE_GAP,
  CRATE_SLOT_H,
  CRATE_SLOT_W,
  DRAWER_GAP,
  DRAWER_ROW_H,
  GRID_CELL_SIZE,
  GRID_GAP,
  GRID_LABEL_HEIGHT,
  SHELF_GAP,
  SHELF_SLOT_H,
  SHELF_SLOT_W,
  SLOT_SCALE_MULTIPLIERS,
  type SlotScale,
} from "./bin-constants";

/** a layout mode supported by the bin widget */
export type BinMode = "grid" | "shelf" | "crate" | "drawer";

/** slot position in the grid (col, row) */
export interface SlotPosition {
  col: number;
  row: number;
}

/** options that affect slot dimensions */
export interface SlotSizeOptions {
  /** scale multiplier (default 1.0) — applied to base slot dimensions */
  scale?: number;
  /** cell border stroke width (px), grid mode only — cells shrink to make
   *  room for the shared border lines instead of the border overlapping
   *  cell content. 0 (or omitted) means no shrinkage. */
  cellBorderWidth?: number;
}

/** inset (px) subtracted from a cell's own footprint per side when cell
 *  borders are enabled — capped to a fraction of the cell's own (already
 *  scaled) size so a very thick border still leaves a usable cell, but a
 *  thicker border keeps shrinking the cell right up to that cap instead of
 *  hitting a fixed ceiling regardless of how large the cell actually is. */
export function cellBorderInset(cellBorderWidth: number | undefined, referenceSize: number): number {
  if (!cellBorderWidth || cellBorderWidth <= 0) return 0;
  const maxInset = Math.floor(referenceSize * 0.3);
  return Math.min(cellBorderWidth, maxInset);
}

/** per-mode border inset, using each mode's own scaled reference dimension —
 *  shared by `slotSize` (cell shrink) and `slotGap` (spacing growth) so the
 *  border stroke drawn by BinRenderer always fits in the gap it creates,
 *  instead of overlapping into the (now smaller) neighboring cells. */
export function modeBorderInset(mode: BinMode, options?: SlotSizeOptions): number {
  const s = options?.scale ?? 1.0;
  switch (mode) {
    case "grid":
      return cellBorderInset(options?.cellBorderWidth, Math.round(GRID_CELL_SIZE * s));
    case "shelf":
      return cellBorderInset(options?.cellBorderWidth, Math.round(SHELF_SLOT_W * s));
    case "crate":
      return cellBorderInset(options?.cellBorderWidth, Math.round(CRATE_SLOT_H * s));
    case "drawer":
      return cellBorderInset(options?.cellBorderWidth, Math.round(DRAWER_ROW_H * s));
  }
}

/** resolve the effective cell-border width to use for layout — 0 unless
 *  cell borders are actually enabled. */
export function resolveCellBorderWidth(
  enabled: boolean | undefined,
  width: number | undefined
): number {
  return enabled ? (width ?? 0) : 0;
}

/** pixel coordinates of a slot's top-left corner (relative to content area) */
export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** get the slot dimensions (width, height) for a given mode, optionally scaled */
export function slotSize(
  mode: BinMode,
  options?: SlotSizeOptions
): { width: number; height: number } {
  const s = options?.scale ?? 1.0;
  const inset = modeBorderInset(mode, options) * 2;
  switch (mode) {
    case "grid": {
      const cellSize = Math.round(GRID_CELL_SIZE * s);
      return {
        width: cellSize - inset,
        height: cellSize - inset + GRID_LABEL_HEIGHT,
      };
    }
    case "shelf": {
      const w = Math.round(SHELF_SLOT_W * s);
      const h = Math.round(SHELF_SLOT_H * s);
      return {
        width: w - inset,
        height: h - inset,
      };
    }
    case "crate": {
      const w = Math.round(CRATE_SLOT_W * s);
      const h = Math.round(CRATE_SLOT_H * s);
      return {
        width: w - inset,
        height: h - inset,
      };
    }
    case "drawer": {
      const h = Math.round(DRAWER_ROW_H * s);
      return { width: 0, height: h - inset };
    }
  }
}

/** get the gap between slots for a given mode — grown by the same (capped)
 *  border inset `slotSize` shrinks cells by, so a cell-border stroke of
 *  that width fits cleanly in the gap instead of overlapping the cells
 *  on either side of it. */
export function slotGap(mode: BinMode, options?: SlotSizeOptions): number {
  const base = (() => {
    switch (mode) {
      case "grid":
        return GRID_GAP;
      case "shelf":
        return SHELF_GAP;
      case "crate":
        return CRATE_GAP;
      case "drawer":
        return DRAWER_GAP;
    }
  })();
  return base + modeBorderInset(mode, options) * 2;
}

/** leading/trailing margin reserved before the first and after the last
 *  cell along the tiled axes — half of `slotGap`, so the perimeter border
 *  gets the same clearance internal dividers get instead of sitting flush
 *  against the first/last row or column. */
export function outerMargin(mode: BinMode, options?: SlotSizeOptions): number {
  return slotGap(mode, options) / 2;
}

/** compute the number of rows needed for the given item count and column count */
export function computeRows(itemCount: number, cols: number): number {
  if (itemCount === 0) return 1;
  return Math.ceil(itemCount / Math.max(1, cols));
}

/**
 * page sizing for real prev/next pagination (as opposed to bin's own
 * scroll-based viewport) — see widgets/narthex/social/canvas-bin.ts, which
 * uses this to slice a folder's children into fixed-size pages that always
 * fit within a given viewport height, rather than scrolling a taller list.
 * schema-agnostic and pure, same spirit as `autoFitCols`/`computeRows`.
 */
export interface PageSize {
  /** columns per row, same value `autoFitCols` would return. */
  cols: number;
  /** how many rows fit within `viewportHeight` (at least 1). */
  rowsPerPage: number;
  /** `cols * rowsPerPage` — how many items fit on one page. */
  itemsPerPage: number;
}

export function computePageSize(
  mode: BinMode,
  contentWidth: number,
  viewportHeight: number,
  options?: SlotSizeOptions
): PageSize {
  const cols = autoFitCols(mode, contentWidth, options);
  const size = slotSize(mode, options);
  const gap = slotGap(mode, options);
  const rowHeight = size.height + gap;
  const rowsPerPage = rowHeight > 0 ? Math.max(1, Math.floor((viewportHeight + gap) / rowHeight)) : 1;
  return { cols, rowsPerPage, itemsPerPage: cols * rowsPerPage };
}

/**
 * compute the minimum grid dimensions needed to fit all items at their
 * current slot positions. ensures no item overflows the grid.
 * also respects minCols (from autoFitCols) so the grid is at least
 * as wide as the container allows.
 */
export function computeGridBounds(
  items: Array<{ slot: SlotPosition }>,
  minCols: number
): { cols: number; rows: number } {
  let maxCol = minCols - 1;
  let maxRow = 0;
  for (const item of items) {
    if (item.slot.col > maxCol) maxCol = item.slot.col;
    if (item.slot.row > maxRow) maxRow = item.slot.row;
  }
  return {
    cols: maxCol + 1,
    rows: items.length > 0 ? maxRow + 1 : 1,
  };
}

/**
 * auto-compute the number of columns that fit in the given content width
 * based on the slot dimensions for the current mode and scale.
 * drawer mode always returns 1.
 */
export function autoFitCols(
  mode: BinMode,
  contentWidth: number,
  options?: SlotSizeOptions
): number {
  if (mode === "drawer") return 1;

  const size = slotSize(mode, options);
  const gap = slotGap(mode, options);

  if (size.width <= 0) return 1;
  // margin (gap / 2) reserved on both sides means cols columns need exactly
  // cols * (size.width + gap) of contentWidth — see slotRect/contentDimensions.
  return Math.max(1, Math.floor(contentWidth / (size.width + gap)));
}

/**
 * get the pixel rect for a given slot position (relative to the content area origin).
 * the content area starts below the header.
 */
export function slotRect(
  mode: BinMode,
  slot: SlotPosition,
  contentWidth: number,
  options?: SlotSizeOptions
): SlotRect {
  const size = slotSize(mode, options);
  const gap = slotGap(mode, options);
  const margin = outerMargin(mode, options);

  if (mode === "drawer") {
    // drawer: full width rows stacked vertically — inset applied evenly to
    // both left and right so the row is centered, matching the leading/
    // trailing margin used on the row-stacking axis below.
    const inset = modeBorderInset(mode, options);
    return {
      x: inset,
      y: margin + slot.row * (size.height + gap),
      width: contentWidth - inset * 2,
      height: size.height,
    };
  }

  return {
    x: margin + slot.col * (size.width + gap),
    y: margin + slot.row * (size.height + gap),
    width: size.width,
    height: size.height,
  };
}

/**
 * find the first empty slot given the current items and grid dimensions.
 * returns null if the grid is full.
 */
export function firstEmptySlot(
  occupied: SlotPosition[],
  cols: number,
  rows: number
): SlotPosition | null {
  const occupiedSet = new Set(occupied.map((s) => `${s.col},${s.row}`));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!occupiedSet.has(`${c},${r}`)) {
        return { col: c, row: r };
      }
    }
  }
  return null;
}

/**
 * hit-test: given a pointer position relative to the content area,
 * return the slot position it falls in, or null if outside the grid.
 */
export function hitTestSlot(
  mode: BinMode,
  px: number,
  py: number,
  cols: number,
  rows: number,
  contentWidth: number,
  options?: SlotSizeOptions
): SlotPosition | null {
  const size = slotSize(mode, options);
  const gap = slotGap(mode, options);
  const margin = outerMargin(mode, options);

  if (mode === "drawer") {
    const row = Math.floor((py - margin) / (size.height + gap));
    if (row < 0 || row >= rows) return null;
    if (px < 0 || px > contentWidth) return null;
    return { col: 0, row };
  }

  const col = Math.floor((px - margin) / (size.width + gap));
  const row = Math.floor((py - margin) / (size.height + gap));

  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;

  // snap to nearest cell when pointer is in the gap between cells.
  // this makes drop targeting more forgiving — instead of returning null
  // (which causes the highlight to jump to the first empty slot), we
  // keep the highlight on the nearest cell.
  const cellX = px - margin - col * (size.width + gap);
  const cellY = py - margin - row * (size.height + gap);

  // if we're past the cell in X, try the next column
  if (cellX > size.width && col + 1 < cols) {
    return { col: col + 1, row };
  }
  // if we're past the cell in Y, try the next row
  if (cellY > size.height && row + 1 < rows) {
    return { col, row: row + 1 };
  }
  // if both are past, we're in a diagonal gap — just use the computed col/row
  return { col, row };
}

/**
 * compute the total content area dimensions for the current layout.
 * does not include header height or padding -- those are added by the caller.
 */
export function contentDimensions(
  mode: BinMode,
  cols: number,
  rows: number,
  contentWidth: number,
  options?: SlotSizeOptions
): { width: number; height: number } {
  const size = slotSize(mode, options);
  const gap = slotGap(mode, options);

  // the leading + trailing margins (outerMargin on each side) add up to
  // exactly one `gap`, which cancels the "no trailing gap" subtraction that
  // used to apply here — so total size is simply count * (size + gap).
  if (mode === "drawer") {
    return {
      width: contentWidth,
      height: rows * (size.height + gap),
    };
  }

  return {
    width: cols * (size.width + gap),
    height: rows * (size.height + gap),
  };
}



/** resolve a SlotScale name to its numeric multiplier */
export function resolveScale(scaleName?: SlotScale | string): number {
  if (!scaleName) return 1.0;
  return SLOT_SCALE_MULTIPLIERS[scaleName as SlotScale] ?? 1.0;
}

/** a single divider line segment, in content-area-relative coordinates */
export interface CellBorderLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * compute a "table cell fill" border layout across all occupied cells
 * (cols x rows): one shared divider line per internal boundary (centered in
 * the gap between neighboring cells), plus a single rect enclosing the
 * whole occupied region — rather than each cell drawing its own separate
 * box, which double-borders at every shared edge and reads as a stack of
 * individual boxes instead of a connected table/spreadsheet grid.
 */
export function computeCellBorderLines(
  mode: BinMode,
  cols: number,
  rows: number,
  contentWidth: number,
  options?: SlotSizeOptions
): { lines: CellBorderLine[]; outer: SlotRect } {
  const size = slotSize(mode, options);
  const gap = slotGap(mode, options);
  const effCols = mode === "drawer" ? 1 : Math.max(1, cols);
  const effRows = Math.max(1, rows);
  const cellW = mode === "drawer" ? contentWidth : size.width;
  const cellH = size.height;

  const totalW = mode === "drawer" ? contentWidth : effCols * (cellW + gap);
  const totalH = effRows * (cellH + gap);

  // dividers land exactly on each cell's pitch boundary — the leading
  // margin (gap / 2) folded into slotRect already centers each cell's own
  // half-gap clearance around these points, so no extra offset is needed.
  const lines: CellBorderLine[] = [];
  for (let c = 1; c < effCols; c++) {
    const x = c * (cellW + gap);
    lines.push({ x1: x, y1: 0, x2: x, y2: totalH });
  }
  for (let r = 1; r < effRows; r++) {
    const y = r * (cellH + gap);
    lines.push({ x1: 0, y1: y, x2: totalW, y2: y });
  }

  return { lines, outer: { x: 0, y: 0, width: totalW, height: totalH } };
}

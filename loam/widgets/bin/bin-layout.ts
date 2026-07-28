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
 *  borders are enabled — capped so a very thick border still leaves a
 *  usable cell. `maxInset` scales the cap to the mode's own (much smaller,
 *  for shelf/crate/drawer) base slot size, so the same border width
 *  doesn't shrink a 28px-tall row as aggressively as an 84px grid cell. */
export function cellBorderInset(cellBorderWidth?: number, maxInset = 16): number {
  if (!cellBorderWidth || cellBorderWidth <= 0) return 0;
  return Math.min(cellBorderWidth, maxInset);
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
  switch (mode) {
    case "grid": {
      const inset = cellBorderInset(options?.cellBorderWidth, 16) * 2;
      return {
        width: Math.round(GRID_CELL_SIZE * s) - inset,
        height: Math.round(GRID_CELL_SIZE * s) - inset + GRID_LABEL_HEIGHT,
      };
    }
    case "shelf": {
      const inset = cellBorderInset(options?.cellBorderWidth, Math.floor(SHELF_SLOT_W * 0.3)) * 2;
      return {
        width: Math.round(SHELF_SLOT_W * s) - inset,
        height: Math.round(SHELF_SLOT_H * s) - inset,
      };
    }
    case "crate": {
      const inset = cellBorderInset(options?.cellBorderWidth, Math.floor(CRATE_SLOT_H * 0.3)) * 2;
      return {
        width: Math.round(CRATE_SLOT_W * s) - inset,
        height: Math.round(CRATE_SLOT_H * s) - inset,
      };
    }
    case "drawer": {
      const inset = cellBorderInset(options?.cellBorderWidth, Math.floor(DRAWER_ROW_H * 0.3)) * 2;
      return { width: 0, height: Math.round(DRAWER_ROW_H * s) - inset };
    }
  }
}

/** get the gap between slots for a given mode */
export function slotGap(mode: BinMode): number {
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
  const gap = slotGap(mode);
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
  const gap = slotGap(mode);

  if (size.width <= 0) return 1;
  return Math.max(1, Math.floor((contentWidth + gap) / (size.width + gap)));
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
  const gap = slotGap(mode);

  if (mode === "drawer") {
    // drawer: full width rows stacked vertically
    const inset = cellBorderInset(options?.cellBorderWidth, Math.floor(DRAWER_ROW_H * 0.3)) * 2;
    return {
      x: 0,
      y: slot.row * (size.height + gap),
      width: contentWidth - inset,
      height: size.height,
    };
  }

  return {
    x: slot.col * (size.width + gap),
    y: slot.row * (size.height + gap),
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
  const gap = slotGap(mode);

  if (mode === "drawer") {
    const row = Math.floor(py / (size.height + gap));
    if (row < 0 || row >= rows) return null;
    if (px < 0 || px > contentWidth) return null;
    return { col: 0, row };
  }

  const col = Math.floor(px / (size.width + gap));
  const row = Math.floor(py / (size.height + gap));

  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;

  // snap to nearest cell when pointer is in the gap between cells.
  // this makes drop targeting more forgiving — instead of returning null
  // (which causes the highlight to jump to the first empty slot), we
  // keep the highlight on the nearest cell.
  const cellX = px - col * (size.width + gap);
  const cellY = py - row * (size.height + gap);

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
  const gap = slotGap(mode);

  if (mode === "drawer") {
    return {
      width: contentWidth,
      height: rows * (size.height + gap) - (rows > 0 ? gap : 0),
    };
  }

  return {
    width: cols * (size.width + gap) - (cols > 0 ? gap : 0),
    height: rows * (size.height + gap) - (rows > 0 ? gap : 0),
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
  const gap = slotGap(mode);
  const effCols = mode === "drawer" ? 1 : Math.max(1, cols);
  const effRows = Math.max(1, rows);
  const cellW = mode === "drawer" ? contentWidth : size.width;
  const cellH = size.height;

  const totalW = mode === "drawer" ? contentWidth : effCols * (cellW + gap) - gap;
  const totalH = effRows * (cellH + gap) - gap;

  const lines: CellBorderLine[] = [];
  for (let c = 1; c < effCols; c++) {
    const x = c * (cellW + gap) - gap / 2;
    lines.push({ x1: x, y1: 0, x2: x, y2: totalH });
  }
  for (let r = 1; r < effRows; r++) {
    const y = r * (cellH + gap) - gap / 2;
    lines.push({ x1: 0, y1: y, x2: totalW, y2: y });
  }

  return { lines, outer: { x: 0, y: 0, width: totalW, height: totalH } };
}

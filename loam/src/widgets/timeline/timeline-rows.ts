/**
 * generic stack of N timeline track rows sharing one camera — generalizes
 * `stfu/video-timeline.ts`'s `setReferenceRowCount()`/`getReferenceRow()`
 * (which only ever pools *reference-track* rows) to an arbitrary, named,
 * arbitrary-height row list, so a timeline can offer "any number of
 * strips" rather than a handful of hardcoded row kinds. rows are pooled by
 * id (added/removed/reordered via `setRows()`), matching
 * `track-item-interaction.ts`'s own id-keyed pooling convention.
 *
 * each row gets exactly the structure the "eventMode=none mask/decorative-
 * Graphics" bug-class fixes (see repo memory) require: `bg` (the real,
 * interactive hit target — `eventMode="static"`, real `hitArea`), a
 * `contentLayer` (unscaled, callers reposition children from scratch on
 * every camera view change), a `mask` that is a SIBLING of the row (never
 * a descendant — see module doc below) with `eventMode="none"`, and a
 * `labelLayer` sibling positioned in the reserved left label column. this
 * is baked in structurally here so no future track/row kind can
 * reintroduce that whole bug class by hand-rolling its own row again.
 */

import { Container, Graphics, Rectangle } from "pixi.js";
import type { TrackRowContainers } from "./timeline-types";

export interface RowSpec {
  id: string;
  height: number;
}

export interface RowHandle extends TrackRowContainers {
  id: string;
  /** the row's own background — same object as `hitArea`, exposed under
   *  both names since some callers think of it as "the row's visible
   *  background" and others as "the interaction engine's hit target". */
  bg: Graphics;
  labelLayer: Container;
  height: number;
  /** current top-left y, relative to the stack's own origin — informational,
   *  set by `layout()`. */
  y: number;
}

export interface TimelineRowStackOptions {
  /** container every row/mask/label is added to — caller positions this
   *  (e.g. as a child of the timeline shell) however it likes. */
  parent: Container;
  /** left offset (px) every row/mask is shifted by — the reserved label
   *  column width, so row content starts to the right of it. */
  labelColumnWidth: number;
  rowGap: number;
  /** fires for a "wheel" event on any row (attached to the row Container,
   *  a wheel-bubbling target, not just `bg`) — callers use this for
   *  horizontal pan (see `stfu/video-timeline.ts`'s `onWheelPan`). */
  onWheel?: (e: import("pixi.js").FederatedWheelEvent) => void;
  /** background fill color for a row with no explicit override — rows can
   *  differ (e.g. reference rows vs. cut-list vs. audio-clips each use a
   *  slightly different shade in stfu today); pass per-row via `setRows()`. */
  defaultFill?: number;
}

export interface TimelineRowStackHandle {
  /** reconcile the pool to exactly this ordered list of rows — existing
   *  row instances are reused (matched by id) rather than destroyed/
   *  recreated, so a row that's temporarily removed and re-added later
   *  (e.g. hidden then shown) doesn't lose any per-row state a caller
   *  might be tracking externally. rows no longer present are hidden, not
   *  destroyed (matches `setReferenceRowCount()`'s own "never shrinks the
   *  pool" precedent) — call `destroy()` on the whole stack to actually
   *  free them. */
  setRows(specs: RowSpec[]): void;
  getRow(id: string): RowHandle;
  /** every currently-visible row's id, in the order last passed to `setRows()`. */
  getRowIds(): string[];
  /** total height of every visible row + the gaps between them. */
  getStackHeight(): number;
  /** reposition every visible row from `startY` downward, and redraw each
   *  row's bg/mask rect to `rowWidth` — call after `setRows()`, a camera
   *  resize, or a row's own fill color changing. */
  layout(startY: number, rowWidth: number): void;
  /** convenience: the on-screen rect (relative to the stack's own parent)
   *  spanning every visible row — e.g. for a native-wheel-event hit test
   *  that needs to know "is the pointer over any track row at all"
   *  without knowing about individual rows. */
  getStackBounds(startY: number, rowWidth: number): { x: number; y: number; width: number; height: number };
  destroy(): void;
}

interface RowInternal {
  row: Container;
  bg: Graphics;
  contentLayer: Container;
  mask: Graphics;
  labelLayer: Container;
  height: number;
  fill: number;
  visible: boolean;
}

export function createTimelineRowStack(options: TimelineRowStackOptions): TimelineRowStackHandle {
  const { parent, labelColumnWidth, rowGap, onWheel, defaultFill = 0x1c1c28 } = options;

  const rows = new Map<string, RowInternal>();
  let order: string[] = [];

  function makeRow(fill: number): RowInternal {
    const row = new Container();
    row.eventMode = "static"; // wheel-bubbling target — see module doc.
    row.x = labelColumnWidth;
    if (onWheel) row.on("wheel", onWheel);
    parent.addChild(row);

    const bg = new Graphics();
    bg.eventMode = "static";
    row.addChild(bg);

    const contentLayer = new Container();
    row.addChild(contentLayer);

    // a mask must live outside the container it clips (pixi treats a
    // self-referential mask as breaking hit-testing on the masked content
    // underneath it) — sibling of `row`, not a child. `eventMode="none"`
    // hard-blocks it from ever swallowing a hit-test (see module doc).
    const mask = new Graphics();
    mask.eventMode = "none";
    mask.x = row.x;
    parent.addChild(mask);
    row.mask = mask;

    const labelLayer = new Container();
    parent.addChild(labelLayer);

    return { row, bg, contentLayer, mask, labelLayer, height: 0, fill, visible: true };
  }

  function redrawRowRect(internal: RowInternal, rowWidth: number): void {
    const w = Math.max(0, rowWidth);
    internal.bg.clear().rect(0, 0, w, internal.height).fill({ color: internal.fill });
    internal.bg.hitArea = new Rectangle(0, 0, w, internal.height);
    internal.mask.clear().rect(0, 0, w, internal.height).fill({ color: 0xffffff });
  }

  function computeStackHeight(): number {
    if (order.length === 0) return 0;
    const total = order.reduce((sum, id) => sum + (rows.get(id)?.height ?? 0), 0);
    return total + rowGap * (order.length - 1);
  }

  return {
    setRows(specs: RowSpec[]): void {
      order = specs.map((s) => s.id);
      const liveIds = new Set(order);
      for (const [id, internal] of rows) {
        if (!liveIds.has(id)) {
          internal.visible = false;
          internal.row.visible = false;
          internal.labelLayer.visible = false;
        }
      }
      for (const spec of specs) {
        let internal = rows.get(spec.id);
        if (!internal) {
          internal = makeRow(defaultFill);
          rows.set(spec.id, internal);
        }
        internal.height = spec.height;
        internal.visible = true;
        internal.row.visible = true;
        internal.labelLayer.visible = true;
      }
    },

    getRow(id: string): RowHandle {
      const internal = rows.get(id);
      if (!internal) {
        throw new Error(`timeline-rows: row "${id}" not allocated — call setRows() first`);
      }
      return {
        id,
        contentLayer: internal.contentLayer,
        hitArea: internal.bg,
        bg: internal.bg,
        labelLayer: internal.labelLayer,
        height: internal.height,
        y: internal.row.y,
      };
    },

    getRowIds(): string[] {
      return [...order];
    },

    getStackHeight(): number {
      return computeStackHeight();
    },

    layout(startY: number, rowWidth: number): void {
      let y = startY;
      for (const id of order) {
        const internal = rows.get(id);
        if (!internal) continue;
        internal.row.y = y;
        internal.mask.y = y;
        internal.labelLayer.y = y;
        redrawRowRect(internal, rowWidth);
        y += internal.height + rowGap;
      }
    },

    getStackBounds(startY: number, rowWidth: number) {
      return { x: labelColumnWidth, y: startY, width: Math.max(0, rowWidth), height: computeStackHeight() };
    },

    destroy(): void {
      for (const internal of rows.values()) {
        internal.row.destroy({ children: true });
        internal.mask.destroy();
        internal.labelLayer.destroy({ children: true });
      }
      rows.clear();
      order = [];
    },
  };
}

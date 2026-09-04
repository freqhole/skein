// doodle widget — freehand drawing with pen and eraser.
//
// architecture:
//   strokeLayer (Container, isRenderGroup=true)
//     committed stroke Graphics objects, in draw order
//     liveGfx (Graphics, always last child) — in-progress stroke
//
// isRenderGroup isolates the layer so blendMode="erase" on eraser strokes
// punches holes in the stroke layer rather than the stage background.
//
// drawing controls (tool, color, width) live in the property tray via
// editableProps — no inline toolbar.  undo/redo via keyboard shortcuts
// (Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z) and via widgetActions in the tray.
//
// extensibility hooks:
//   - stroke.tool is a plain string: add "rect" | "circle" | "text" later
//   - stroke.meta is an open record for per-tool extra state
//   - brush shapes: dispatch on stroke.meta.brush inside paintStroke()

import { Container, Graphics, Rectangle } from "pixi.js";
import { z } from "zod";
import {
  isTransparent,
  type CompactInfo,
  type HeaderAction,
  type WidgetAction,
  type WidgetController,
  type WidgetFactory,
  type WidgetMountContext,
} from "../src/widgets/widget-types";
import { fnv1aHash, renderSnapshot } from "../src/widgets/offscreen-snapshot";

// ---------------------------------------------------------------------------
// helpers (schema-level)
// ---------------------------------------------------------------------------

/** pick a random vivid color from a broad palette — used for border + pen defaults */
function randomDoodleColor(): number {
  const palette = [
    0xf472b6, 0xec4899, 0xd946ef, 0xa855f7, 0x8b5cf6, 0x6366f1, 0x3b82f6, 0x06b6d4, 0x14b8a6,
    0x22c55e, 0x84cc16, 0xeab308, 0xf97316, 0xef4444, 0xfbbf24, 0x4ade80, 0x38bdf8, 0xc084fc,
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const pointSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** 0–1 pointer pressure, sampled when pressureScale > 0; omitted otherwise */
  pressure: z.number().optional(),
  /** pen tilt/azimuth angle in radians, sampled when angleScale > 0; omitted otherwise */
  angle: z.number().optional(),
});

export const strokeSchema = z.object({
  /** session-unique id used for local undo tracking */
  id: z.string(),
  /**
   * "pen" | "eraser" — extend freely for future tools.
   * unknown tools fall through to the pen renderer for forward compat.
   */
  tool: z.string().default("pen"),
  /** 0xRRGGBB hex color; eraser ignores this field */
  color: z.number().default(0xffffff),
  /** stroke width in logical pixels */
  width: z.number().default(3),
  /** sampled pointer positions in widget-local coordinates */
  points: z.array(pointSchema).default([]),
  /** stroke opacity 0–100; 100 = fully opaque */
  opacity: z.number().default(100),
  /** brush shape: "circle" | "rect" | "diamond" | "chisel" */
  brushShape: z.string().default("circle"),
  /** 0–100; how strongly sampled pointer pressure scales width (and, when
   *  opacity < 100, alpha). 0 = pressure has no effect. baked into the
   *  stroke at draw time (like width/opacity) so rendering is stable. */
  pressureScale: z.number().default(0),
  /** 0–100; how strongly sampled pointer angle (tilt/azimuth) rotates the
   *  "diamond"/"chisel" brush shape. 0 = shape uses its fixed default angle. */
  angleScale: z.number().default(0),
  /** fixed nib angle (degrees) for the "chisel" brush when angleScale isn't
   *  actively rotating it — adjustable by dragging the chisel header button. */
  chiselAngle: z.number().default(-45),
  /**
   * open-ended per-tool metadata.
   * future: { fill: boolean } for shapes, { text, fontFamily, fontSize } for text,
   *         { brush: "flat" | "spray" } for brush types, etc.
   */
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type DoodleStroke = z.infer<typeof strokeSchema>;

export const doodleSchema = z.object({
  /** all committed strokes, in draw order */
  strokes: z.array(strokeSchema).default([]),
  /** widget background color; -1 = transparent */
  bgColor: z.number().default(-1),
  /** active drawing tool: "pen" | "eraser" */
  activeTool: z.string().default("pen"),
  /** pen color (0xRRGGBB) */
  penColor: z.number().default(0xd946ef),
  /** pen width in pixels — the baseline width when pressureScale > 0 */
  penWidth: z.number().default(3),
  /** 0–100; how strongly pointer pressure scales stroke width/opacity.
   *  0 = off (pressure sampling disabled entirely). */
  pressureScale: z.number().default(0),
  /** brush shape: "circle" | "rect" | "diamond" | "chisel" */
  brushShape: z.string().default("circle"),
  /** 0–100; how strongly pointer angle (tilt/azimuth) rotates the
   *  "diamond"/"chisel" brush shape. 0 = off (angle sampling disabled). */
  angleScale: z.number().default(0),
  /** fixed nib angle (degrees) for the "chisel" brush — the baseline used
   *  when angleScale isn't actively rotating it; adjustable via the chisel
   *  header button's drag scrubber. */
  chiselAngle: z.number().default(-45),
  /** pen opacity 1–100; 100 = fully opaque */
  penOpacity: z.number().default(100),
  /** border color; -1 = transparent (no border) */
  borderColor: z.number().default(0xa855f7),
  /** border width in pixels; 0 = no border */
  borderWidth: z.number().default(1),
  /** true once random pen/border colors have been written to the doc.
   *  ensures colors are chosen once per widget (not on every schema parse). */
  colorsSeeded: z.boolean().default(false),
  /** when true, the canvas is read-only — pointer drawing is disabled until
   *  unlocked again. persisted so the lock state survives reload and syncs
   *  to other peers viewing the same widget. */
  locked: z.boolean().default(false),
  /** small thumbnail image of the committed strokes, used as the bin
   *  compact card image — regenerated whenever the strokes/background change */
  doodleSnapshotDataUrl: z.string().default(""),
  /** cache key the snapshot above was rendered from (stroke ids + bgColor) —
   *  lets any peer detect a stale snapshot without every peer re-rendering
   *  on every doc change */
  doodleSnapshotKey: z.string().default(""),
});

export type DoodleState = z.infer<typeof doodleSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * paint a freehand stroke path onto a Graphics object using midpoint
 * quadratic bezier curves for smooth lines.
 * a single-point stroke is drawn as a filled shape so a tap leaves a mark.
 * supports four brush shapes: "circle" (round cap), "rect" (square cap),
 * "diamond" (rotated square stamps along the path), and "chisel" (a flat
 * calligraphy-nib rectangle, stamped at a fixed angle unless pointer angle
 * data rotates it — see angleScale).
 */

/** fixed nib angle (degrees) for "chisel" when no doc value/pointer angle
 *  data is available — mimics a traditional calligraphy pen's constant tilt. */
const DEFAULT_CHISEL_ANGLE_DEG = -45;
const DEG2RAD = Math.PI / 180;

/** rotate (x, y) by `angle` radians around (cx, cy) */
function rotateAround(
  x: number,
  y: number,
  cx: number,
  cy: number,
  angle: number
): { x: number; y: number } {
  if (!angle) return { x, y };
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** stamp a single brush shape (used by pressure-variable rendering below).
 *  `angle` (radians) only affects "diamond"/"chisel" — ignored otherwise. */
function stampShape(g: Graphics, shape: string, x: number, y: number, w: number, angle = 0): void {
  const hw = w / 2;
  if (shape === "diamond") {
    const pts = [
      { x, y: y - hw },
      { x: x + hw, y },
      { x, y: y + hw },
      { x: x - hw, y },
    ].map((p) => rotateAround(p.x, p.y, x, y, angle));
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
  } else if (shape === "chisel") {
    // flat calligraphy nib — a thin rectangle much longer than it is thick,
    // rotated around its center along the (fixed or pointer-driven) angle.
    const hl = w / 2;
    const ht = Math.max(0.5, w * 0.16);
    const corners = [
      { x: x - hl, y: y - ht },
      { x: x + hl, y: y - ht },
      { x: x + hl, y: y + ht },
      { x: x - hl, y: y + ht },
    ].map((p) => rotateAround(p.x, p.y, x, y, angle));
    g.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) g.lineTo(corners[i].x, corners[i].y);
    g.closePath();
  } else if (shape === "rect") {
    g.rect(x - hw, y - hw, w, w);
  } else {
    g.circle(x, y, Math.max(0.5, hw));
  }
}

/** baseline*pressure floor — a very light touch still leaves a visible mark */
const MIN_PRESSURE_SCALE = 0.35;

/**
 * pressure/angle-variable stroke rendering — stamps interpolated shapes
 * along the path with width (and, for non-fully-opaque strokes, alpha)
 * scaled per-point from pressure, and "diamond"/"chisel" rotation scaled
 * per-point from angle. only used when points carry a `pressure` or
 * `angle` sample; otherwise paintStroke falls back to its constant path.
 */
function paintPressureStroke(g: Graphics, stroke: DoodleStroke): void {
  const { points, color, width } = stroke;
  const baseAlpha = (stroke.opacity ?? 100) / 100;
  const shape = stroke.brushShape ?? "circle";
  const pressureScale = Math.max(0, Math.min(100, stroke.pressureScale ?? 0)) / 100;
  const angleScale = Math.max(0, Math.min(100, stroke.angleScale ?? 0)) / 100;
  const baseAngle = shape === "chisel" ? (stroke.chiselAngle ?? DEFAULT_CHISEL_ANGLE_DEG) * DEG2RAD : 0;

  const effectiveMinScale = 1 - pressureScale * (1 - MIN_PRESSURE_SCALE);
  const widthAt = (p: { pressure?: number }): number => {
    if (typeof p.pressure !== "number") return width;
    const pr = Math.max(0, Math.min(1, p.pressure));
    const scale = effectiveMinScale + (1 - effectiveMinScale) * pr;
    return Math.max(0.5, width * scale);
  };

  // pressure also dims opacity, but only when the chosen opacity isn't
  // already fully opaque — there's no "lighter" alpha to fall back to at 100.
  const opacityAffectedByPressure = pressureScale > 0 && baseAlpha < 1;
  const alphaAt = (p: { pressure?: number }): number => {
    if (!opacityAffectedByPressure || typeof p.pressure !== "number") return baseAlpha;
    const pr = Math.max(0, Math.min(1, p.pressure));
    const scale = effectiveMinScale + (1 - effectiveMinScale) * pr;
    return baseAlpha * scale;
  };

  const angleAt = (p: { angle?: number }): number => {
    if (typeof p.angle !== "number" || angleScale <= 0) return baseAngle;
    return baseAngle + (p.angle - baseAngle) * angleScale;
  };

  if (!opacityAffectedByPressure) {
    // fast path: one path, one fill.
    stampShape(g, shape, points[0].x, points[0].y, widthAt(points[0]), angleAt(points[0]));
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const avgW = (widthAt(a) + widthAt(b)) / 2;
      const step = Math.max(1, avgW * 0.35);
      const steps = Math.max(1, Math.ceil(dist / step));
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const w = widthAt(a) + (widthAt(b) - widthAt(a)) * t;
        const ang = angleAt(a) + (angleAt(b) - angleAt(a)) * t;
        stampShape(g, shape, x, y, w, ang);
      }
    }
    g.fill({ color, alpha: baseAlpha });
    return;
  }

  // opacity varies per-point — fill each stamp individually (more draw
  // calls, only paid when pressure + non-full opacity are both in play).
  const fillStamp = (x: number, y: number, w: number, ang: number, a: number): void => {
    stampShape(g, shape, x, y, w, ang);
    g.fill({ color, alpha: a });
  };
  fillStamp(points[0].x, points[0].y, widthAt(points[0]), angleAt(points[0]), alphaAt(points[0]));
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const avgW = (widthAt(a) + widthAt(b)) / 2;
    const step = Math.max(1, avgW * 0.35);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const w = widthAt(a) + (widthAt(b) - widthAt(a)) * t;
      const ang = angleAt(a) + (angleAt(b) - angleAt(a)) * t;
      const al = alphaAt(a) + (alphaAt(b) - alphaAt(a)) * t;
      fillStamp(x, y, w, ang, al);
    }
  }
}

function paintStroke(g: Graphics, stroke: DoodleStroke): void {
  const { points, color, width } = stroke;
  const alpha = (stroke.opacity ?? 100) / 100;
  const shape = stroke.brushShape ?? "circle";
  if (points.length === 0) return;

  if (points.some((p) => typeof p.pressure === "number" || typeof p.angle === "number")) {
    paintPressureStroke(g, stroke);
    return;
  }

  if (shape === "diamond" || shape === "chisel") {
    // stamp interpolated shapes along the full path so there are no gaps —
    // spacing is 40% of width to ensure solid overlap.
    const angle = shape === "chisel" ? (stroke.chiselAngle ?? DEFAULT_CHISEL_ANGLE_DEG) * DEG2RAD : 0;
    const step = Math.max(1, width * 0.4);

    stampShape(g, shape, points[0].x, points[0].y, width, angle);
    for (let i = 0; i < points.length - 1; i++) {
      const ax = points[i].x,
        ay = points[i].y;
      const bx = points[i + 1].x,
        by = points[i + 1].y;
      const dist = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(dist / step));
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        stampShape(g, shape, ax + (bx - ax) * t, ay + (by - ay) * t, width, angle);
      }
    }

    g.fill({ color, alpha });
    return;
  }

  const cap: "round" | "square" = shape === "rect" ? "square" : "round";
  const join: "round" | "miter" = shape === "rect" ? "miter" : "round";

  if (points.length === 1) {
    if (shape === "rect") {
      const hw = width / 2;
      g.rect(points[0].x - hw, points[0].y - hw, width, width);
      g.fill({ color, alpha });
    } else {
      g.circle(points[0].x, points[0].y, Math.max(0.5, width / 2));
      g.fill({ color, alpha });
    }
    return;
  }

  g.moveTo(points[0].x, points[0].y);
  if (points.length === 2) {
    g.lineTo(points[1].x, points[1].y);
  } else {
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      g.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    g.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  }
  g.stroke({ width, color, alpha, cap, join });
}

/** derive a stroke-orientation angle (radians) from a pointer event, for
 *  "diamond"/"chisel" brush rotation. prefers azimuthAngle (radians,
 *  chrome/safari-recent) and falls back to atan2(tiltY, tiltX) — a
 *  reasonable direction proxy from tilt on devices without azimuthAngle. */
function readPointerAngle(e: any): number | undefined {
  if (typeof e.azimuthAngle === "number") return e.azimuthAngle;
  if (typeof e.tiltX === "number" && typeof e.tiltY === "number" && (e.tiltX !== 0 || e.tiltY !== 0)) {
    return Math.atan2(e.tiltY, e.tiltX);
  }
  return undefined;
}

/**
 * build a committed stroke Graphics node with the correct blend mode.
 * eraser strokes use blendMode="erase" — they punch holes in the parent
 * isRenderGroup container.
 */
function makeStrokeNode(stroke: DoodleStroke): Graphics {
  const g = new Graphics();
  if (stroke.tool === "eraser") {
    g.blendMode = "erase";
    // color is irrelevant for erase blend mode
    paintStroke(g, { ...stroke, color: 0xffffff });
  } else {
    paintStroke(g, stroke);
  }
  return g;
}

// ---------------------------------------------------------------------------
// bin compact-card snapshot
// ---------------------------------------------------------------------------

const DOODLE_SNAPSHOT_SIZE = 128;
const DOODLE_SNAPSHOT_PADDING = 8;

/** bounding box of every point across all strokes, in the doodle's own
 *  local coordinate space (padded by each stroke's own width so thick
 *  strokes near the edge aren't clipped). null if there are no points. */
function computeStrokesBounds(
  strokes: DoodleStroke[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    const halfW = (stroke.width ?? 3) / 2;
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x - halfW);
      minY = Math.min(minY, p.y - halfW);
      maxX = Math.max(maxX, p.x + halfW);
      maxY = Math.max(maxY, p.y + halfW);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * render a small thumbnail of the doodle's committed strokes for use as a
 * bin compact card image. the strokes' own bounding box is scaled and
 * centered to fit a fixed square canvas — independent of the widget's
 * current on-canvas size, so a resized widget still thumbnails correctly.
 * reuses paintStroke/makeStrokeNode directly so the thumbnail always
 * matches the live rendering exactly (same stroke geometry, brush shapes,
 * eraser blend mode).
 *
 * exported (not just used for the bin-card thumbnail above) so animaniac's
 * `frame-capture.ts` can render a doodle-frame clip from another widget's
 * doc data alone — no live mounted pixi container needed, since this
 * operates purely on `strokes`/`bgColor` read straight off the doc.
 */
export async function renderDoodleSnapshot(
  strokes: DoodleStroke[],
  bgColor: number,
  size: number = DOODLE_SNAPSHOT_SIZE
): Promise<string | null> {
  const bounds = computeStrokesBounds(strokes);
  if (!bounds) return null;

  const contentW = Math.max(1, bounds.maxX - bounds.minX);
  const contentH = Math.max(1, bounds.maxY - bounds.minY);
  const available = size - DOODLE_SNAPSHOT_PADDING * 2;
  const scale = Math.min(available / contentW, available / contentH, 1);

  const stage = new Container();

  if (!isTransparent(bgColor)) {
    const bg = new Graphics();
    bg.rect(0, 0, size, size).fill({ color: bgColor });
    stage.addChild(bg);
  }

  // isRenderGroup=true so eraser strokes' blendMode="erase" punches holes in
  // this layer only, matching the live widget's rendering architecture.
  const strokeLayer = new Container();
  strokeLayer.isRenderGroup = true;
  strokeLayer.x = size / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
  strokeLayer.y = size / 2 - ((bounds.minY + bounds.maxY) / 2) * scale;
  strokeLayer.scale.set(scale);
  for (const stroke of strokes) {
    strokeLayer.addChild(makeStrokeNode(stroke));
  }
  stage.addChild(strokeLayer);

  // rendered at 3x resolution so the thumbnail stays sharp when the canvas
  // is zoomed in well past 100%
  const dataUrl = await renderSnapshot(stage, size, size, "webp", 3);
  stage.destroy({ children: true });
  return dataUrl;
}

/** cache key the doodle snapshot was rendered from — stroke ids (order and
 *  membership) plus bgColor, hashed down to a short string so it's cheap to
 *  store even for doodles with many strokes. */
function doodleSnapshotKey(state: DoodleState): string {
  return fnv1aHash(state.strokes.map((s) => s.id).join(",") + "|" + state.bgColor);
}

// ---------------------------------------------------------------------------
// widget factory
// ---------------------------------------------------------------------------

export const doodleWidget: WidgetFactory<typeof doodleSchema> = {
  type: "doodle",
  metadata: {
    name: "doodle",
    description: "freehand drawing with pen and eraser",
    version: "0.1.0",
    category: "basics",
    defaultWidth: 640,
    defaultHeight: 340,
  },
  schema: doodleSchema,
  editableProps: [
    { key: "locked", label: "locked", type: "boolean" as const, default: false },
    { key: "bgColor", label: "background", type: "color" as const, default: -1 },
    { key: "borderColor", label: "border", type: "color" as const, default: -1 },
    { key: "borderWidth", label: "border width", type: "number" as const, min: 0, default: 1 },
    {
      key: "activeTool",
      label: "tool",
      type: "select" as const,
      options: ["pen", "eraser"],
      default: "pen",
    },
    { key: "penColor", label: "pen color", type: "color" as const, default: 0xd946ef },
    { key: "penWidth", label: "pen width", type: "number" as const, default: 3 },
    { key: "pressureScale", label: "pressure", type: "number" as const, min: 0, max: 100, step: 5, default: 0 },
    {
      key: "brushShape",
      label: "brush shape",
      type: "select" as const,
      options: ["circle", "rect", "diamond", "chisel"],
      default: "circle",
    },
    {
      key: "angleScale",
      label: "angle",
      type: "number" as const,
      min: 0,
      max: 100,
      step: 5,
      default: 0,
      visibleWhen: { key: "brushShape", value: ["diamond", "chisel"] },
    },
    { key: "penOpacity", label: "opacity", type: "number" as const, default: 100 },
  ],

  getCompactInfo: (state: DoodleState): CompactInfo => ({
    label:
      state.strokes.length > 0
        ? `doodle · ${state.strokes.length} stroke${state.strokes.length === 1 ? "" : "s"}`
        : "empty doodle",
    thumbnailUrl: state.doodleSnapshotDataUrl || undefined,
  }),

  create(ctx: WidgetMountContext<typeof doodleSchema>): WidgetController {
    let cw = ctx.width;
    let ch = ctx.height;
    let destroyed = false;

    // ── seed random colors once ──────────────────────────────────────────────
    // schema defaults are stable fixed values; we write random colors to the
    // doc on first mount so they're stored and never re-computed.  this also
    // migrates pre-existing widgets that were created before these fields.
    if (!ctx.doc.current.colorsSeeded) {
      ctx.doc.change((draft) => {
        draft.penColor = randomDoodleColor();
        draft.borderColor = randomDoodleColor();
        draft.colorsSeeded = true;
      });
    }

    // ── root container ──────────────────────────────────────────────────────
    const container = new Container();
    container.eventMode = "static";

    // ── background ──────────────────────────────────────────────────────────
    // bgGfx is the primary pointer-event target.  attaching eventMode +
    // an explicit hitArea to a Graphics child (rather than the Container
    // root) is the reliable PixiJS v8 pattern for hit testing.
    const bgGfx = new Graphics();
    bgGfx.eventMode = "static";
    bgGfx.hitArea = new Rectangle(0, 0, cw, ch);
    bgGfx.cursor = "crosshair";
    container.addChild(bgGfx);

    // ── locked cursor ────────────────────────────────────────────────────────
    // when locked, swap the crosshair for a plain cursor so it reads as a
    // read-only view rather than an active drawing surface.
    const updateCursor = () => {
      bgGfx.cursor = ctx.doc.current.locked ? "default" : "crosshair";
    };
    updateCursor();

    const drawBackground = () => {
      const { bgColor, borderColor, borderWidth } = ctx.doc.current;
      bgGfx.clear();
      if (!isTransparent(bgColor)) {
        bgGfx.rect(0, 0, cw, ch);
        bgGfx.fill({ color: bgColor });
      }
      const bw = borderWidth ?? 0;
      if (bw > 0 && !isTransparent(borderColor ?? -1)) {
        bgGfx.rect(0, 0, cw, ch);
        bgGfx.stroke({ color: borderColor, width: bw });
      }
      // always re-stamp the hitArea after clear() in case PixiJS resets it
      bgGfx.hitArea = new Rectangle(0, 0, cw, ch);
    };
    drawBackground();

    // ── stroke layer ────────────────────────────────────────────────────────
    // isRenderGroup=true: composites to its own buffer first so that
    // blendMode="erase" on eraser strokes punches holes in the layer rather
    // than erasing against the stage background.
    const strokeLayer = new Container();
    strokeLayer.isRenderGroup = true;
    // rendering-only layer — never a pointer-event target
    strokeLayer.eventMode = "none";
    container.addChild(strokeLayer);

    // ── live stroke (always the last child of strokeLayer) ──────────────────
    // Rendered live during pointer movement. Temporarily removed during
    // doc.change() so syncStrokes inserts the new committed node before it.
    const liveGfx = new Graphics();
    strokeLayer.addChild(liveGfx);
    let liveInLayer = true;

    // ── committed stroke map: stroke id → Graphics node ────────────────────
    const rendered = new Map<string, Graphics>();

    const syncStrokes = (state: DoodleState) => {
      const docIds = new Set(state.strokes.map((s) => s.id));

      // remove Graphics for strokes deleted from the doc (remote undo / clear)
      for (const [id, g] of rendered) {
        if (!docIds.has(id)) {
          strokeLayer.removeChild(g);
          g.destroy();
          rendered.delete(id);
        }
      }

      // add Graphics for new strokes, inserting before liveGfx when it's present
      for (const stroke of state.strokes) {
        if (!rendered.has(stroke.id)) {
          const g = makeStrokeNode(stroke);
          if (liveInLayer) {
            // liveGfx is always the last child; insert immediately before it
            strokeLayer.addChildAt(g, strokeLayer.children.length - 1);
          } else {
            strokeLayer.addChild(g);
          }
          rendered.set(stroke.id, g);
        }
      }

      drawBackground();
    };

    // initial sync
    syncStrokes(ctx.doc.current);

    // ── bin compact-card snapshot ────────────────────────────────────────────
    // regenerated whenever the strokes or background change; keyed so only
    // the first peer to observe a given change renders + writes it back, and
    // every other peer's doc-change handler sees a matching key and skips it.
    const maybeRegenerateSnapshot = (): void => {
      const state = ctx.doc.current;
      const key = doodleSnapshotKey(state);
      if (state.doodleSnapshotKey === key) return;
      void renderDoodleSnapshot(state.strokes, state.bgColor).then((dataUrl) => {
        if (destroyed) return;
        // bail if superseded by a newer change, or another peer already wrote
        // this exact snapshot, while we were rendering
        if (doodleSnapshotKey(ctx.doc.current) !== key) return;
        if (ctx.doc.current.doodleSnapshotKey === key) return;
        ctx.doc.change((d) => {
          d.doodleSnapshotDataUrl = dataUrl ?? "";
          d.doodleSnapshotKey = key;
        });
      });
    };
    maybeRegenerateSnapshot();

    // ── local drawing state ─────────────────────────────────────────────────
    let drawing = false;
    let activePointerId: number | null = null;
    let activePoints: Array<{ x: number; y: number }> = [];
    let activeStrokeId = "";
    /** per-touch override, set by the long-press/eraser gesture below — null
     *  means "use the tray's activeTool" (the normal case). */
    let toolOverride: "eraser" | null = null;

    // ── undo/redo (local session only — does not undo peers' strokes) ───────
    //
    // History entries are a union so "clear all" can be treated as a single
    // undoable operation:
    //   { type: "stroke", id }          — a committed pen/eraser stroke
    //   { type: "clear", before: [...] } — a clear-all with the prior strokes
    //                                       saved for restoration on undo
    type HistoryEntry = { type: "stroke"; id: string } | { type: "clear"; before: DoodleStroke[] };
    type RedoEntry =
      | { type: "stroke"; stroke: DoodleStroke }
      | { type: "clear"; before: DoodleStroke[] };

    const myHistory: HistoryEntry[] = [];
    const redoStack: RedoEntry[] = [];

    const undo = () => {
      const entry = myHistory.pop();
      if (!entry) return;

      if (entry.type === "stroke") {
        const stroke = ctx.doc.current.strokes.find((s) => s.id === entry.id);
        if (stroke) {
          redoStack.push({ type: "stroke", stroke });
          ctx.doc.change((draft) => {
            const idx = draft.strokes.findIndex((s) => s.id === entry.id);
            if (idx >= 0) draft.strokes.splice(idx, 1);
          });
        }
      } else {
        // undo a clear: restore the snapshot and allow further per-stroke undo
        redoStack.push({ type: "clear", before: entry.before });
        ctx.doc.change((draft) => {
          for (const s of entry.before) {
            if (!draft.strokes.find((x) => x.id === s.id)) {
              draft.strokes.push(s);
            }
          }
        });
        // re-add each restored stroke as an individual undo-able entry
        for (const s of entry.before) {
          myHistory.push({ type: "stroke", id: s.id });
        }
      }
    };

    const redo = () => {
      const entry = redoStack.pop();
      if (!entry) return;

      if (entry.type === "stroke") {
        myHistory.push({ type: "stroke", id: entry.stroke.id });
        ctx.doc.change((draft) => {
          draft.strokes.push(entry.stroke);
        });
      } else {
        // redo a clear: snapshot current strokes then clear
        const snapshot = [...ctx.doc.current.strokes];
        myHistory.push({ type: "clear", before: snapshot });
        liveGfx.clear();
        ctx.doc.change((draft) => {
          draft.strokes = [];
        });
      }
    };

    const clearAll = () => {
      if (ctx.doc.current.strokes.length === 0) return;
      const snapshot = [...ctx.doc.current.strokes];
      myHistory.push({ type: "clear", before: snapshot });
      redoStack.length = 0;
      liveGfx.clear();
      ctx.doc.change((draft) => {
        draft.strokes = [];
      });
    };

    // ── keyboard shortcuts for undo/redo ────────────────────────────────────
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (!e.shiftKey && e.key === "z") {
        e.preventDefault();
        undo();
      } else if ((e.shiftKey && e.key === "z") || e.key === "y") {
        e.preventDefault();
        redo();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    // ── live redraw during pointer movement ─────────────────────────────────
    const redrawLive = () => {
      liveGfx.clear();
      if (activePoints.length === 0) return;
      const { activeTool, penColor, penWidth, brushShape, penOpacity, pressureScale, angleScale, chiselAngle } =
        ctx.doc.current;
      const effectiveTool = toolOverride ?? activeTool;
      const width = Math.max(1, penWidth);
      const stroke: DoodleStroke = {
        id: activeStrokeId,
        tool: effectiveTool,
        color: penColor,
        width,
        opacity: penOpacity ?? 100,
        brushShape: brushShape ?? "circle",
        pressureScale: pressureScale ?? 0,
        angleScale: angleScale ?? 0,
        chiselAngle: chiselAngle ?? DEFAULT_CHISEL_ANGLE_DEG,
        points: activePoints,
      };
      if (effectiveTool === "eraser") {
        liveGfx.blendMode = "erase";
        paintStroke(liveGfx, { ...stroke, color: 0xffffff });
      } else {
        liveGfx.blendMode = "normal";
        paintStroke(liveGfx, stroke);
      }
    };

    // ── pointer handlers ────────────────────────────────────────────────────
    // attached to bgGfx — a Graphics child with an explicit Rectangle hitArea.
    // this is the reliable PixiJS v8 hit-testing pattern: eventMode + hitArea
    // on a Graphics child rather than on the parent Container root.
    //
    // PixiJS v8 applies implicit pointer capture on pointerdown, so pointermove
    // and pointerup are delivered to bgGfx even when the pointer leaves the
    // widget bounds mid-stroke.

    // ── pen detection / palm-rejection (in-memory, per-mount only — never
    // written to the automerge doc; these are local drawing-surface
    // preferences, not shared widget state) ─────────────────────────────────
    let penDetected = false;
    /** when true (only togglable once a pen has been seen), only "pen"
     *  pointerType may draw — touch/mouse are ignored entirely. */
    let penLock = false;
    let lastPenActivityAt = 0;
    /** after real pen activity, ignore touch/mouse pointerdowns for this
     *  long — keeps a resting palm/wrist from starting an accidental stroke
     *  while drawing with a stylus. */
    const PALM_REJECTION_MS = 700;

    const notePointerType = (e: any): void => {
      if (e.pointerType !== "pen") return;
      lastPenActivityAt = performance.now();
      if (!penDetected) {
        penDetected = true;
        ctx.setHeaderActions?.(makeHeaderActions());
      }
    };

    const isPointerAllowed = (e: any): boolean => {
      if (e.pointerType === "pen") return true;
      if (penLock) return false;
      return performance.now() - lastPenActivityAt >= PALM_REJECTION_MS;
    };

    // samples pointer pressure/angle only when pressureScale/angleScale > 0 —
    // omitting the fields otherwise keeps old/disabled strokes on
    // paintStroke's constant-width, unrotated path.
    const capturePoint = (e: any, lp: { x: number; y: number }) => {
      const { pressureScale, angleScale } = ctx.doc.current;
      const point: { x: number; y: number; pressure?: number; angle?: number } = { x: lp.x, y: lp.y };
      if ((pressureScale ?? 0) > 0) {
        point.pressure = typeof e.pressure === "number" && e.pressure > 0 ? e.pressure : 0.5;
      }
      if ((angleScale ?? 0) > 0) {
        const angle = readPointerAngle(e);
        if (angle !== undefined) point.angle = angle;
      }
      return point;
    };

    bgGfx.on("pointerdown", (e: any) => {
      notePointerType(e);
      if (ctx.canvasStore?.isLocalViewer()) return;
      if (ctx.doc.current.locked) return;
      if (!isPointerAllowed(e)) return;
      if (drawing) {
        // a previous stroke's pointerup/pointercancel was missed (apple
        // pencil hover/palm-rejection/system-gesture edge cases can drop
        // it) — finalize the stuck stroke instead of silently ignoring
        // every pointerdown from now on (see handlePointerCancel below for
        // the other half of this fix).
        finalizeStroke();
        toolOverride = null;
      }
      e.stopPropagation();
      drawing = true;
      activePointerId = e.pointerId;
      activeStrokeId = makeId();
      activePoints = [];
      const lp = e.getLocalPosition(container);
      activePoints.push(capturePoint(e, lp));
      redrawLive();
    });

    // use globalpointermove so strokes continue tracking when pointer
    // drifts outside the bgGfx hitArea mid-stroke
    bgGfx.on("globalpointermove", (e: any) => {
      notePointerType(e);
      if (!drawing || e.pointerId !== activePointerId) return;
      const lp = e.getLocalPosition(container);
      const last = activePoints[activePoints.length - 1];
      const dx = lp.x - last.x;
      const dy = lp.y - last.y;
      // skip micro-movements (< 2px) to keep point counts manageable
      if (dx * dx + dy * dy < 4) return;
      activePoints.push(capturePoint(e, lp));
      redrawLive();
    });

    // finalizes whatever's in activePoints into a committed stroke, without
    // touching `drawing`/`activePointerId` — shared by commitStroke and the
    // mid-stroke pen/eraser split in handleContextMenu below.
    const finalizeStroke = () => {
      if (activePoints.length === 0) {
        liveGfx.clear();
        liveGfx.blendMode = "normal";
        return;
      }

      const { activeTool, penColor, penWidth, brushShape, penOpacity, pressureScale, angleScale, chiselAngle } =
        ctx.doc.current;
      const stroke: DoodleStroke = {
        id: activeStrokeId,
        tool: toolOverride ?? activeTool,
        color: penColor,
        width: Math.max(1, penWidth),
        opacity: penOpacity ?? 100,
        brushShape: brushShape ?? "circle",
        pressureScale: pressureScale ?? 0,
        angleScale: angleScale ?? 0,
        chiselAngle: chiselAngle ?? DEFAULT_CHISEL_ANGLE_DEG,
        points: [...activePoints],
      };

      // detach liveGfx before the doc change so syncStrokes inserts the
      // committed node at the correct z-position (before liveGfx)
      liveGfx.clear();
      liveGfx.blendMode = "normal";
      liveInLayer = false;
      strokeLayer.removeChild(liveGfx);

      ctx.doc.change((draft) => {
        draft.strokes.push(stroke);
      });

      // restore liveGfx as the topmost child
      strokeLayer.addChild(liveGfx);
      liveInLayer = true;

      myHistory.push({ type: "stroke", id: stroke.id });
      redoStack.length = 0; // new stroke invalidates the redo stack
      activePoints = [];
      activeStrokeId = "";
    };

    const commitStroke = (e: any) => {
      if (!drawing || (e && e.pointerId !== activePointerId)) return;
      drawing = false;
      activePointerId = null;
      finalizeStroke();
      toolOverride = null;
    };

    bgGfx.on("pointerup", commitStroke);
    bgGfx.on("pointerupoutside", commitStroke);

    // pixi's federated event system never forwards native "pointercancel"
    // (apple pencil hover/palm-rejection/system-gesture handling on iPad can
    // fire this instead of pointerup mid-stroke) — without this, `drawing`
    // gets stuck true forever and every subsequent pointerdown is ignored.
    // listen natively and reuse commitStroke's own pointerId guard.
    const handlePointerCancel = (e: PointerEvent) => commitStroke(e);
    window.addEventListener("pointercancel", handlePointerCancel, true);

    // apple pencil's long-press ("right click") surfaces as a native
    // contextmenu event on ipados safari, still mid-touch — use it as a
    // hold-to-erase gesture. splits whatever pen points were drawn so far
    // into their own committed stroke, then continues the same touch as a
    // new eraser stroke seeded from the same point (no visible gap). reverts
    // to the tray's chosen tool on release, via commitStroke's toolOverride reset.
    const handleContextMenu = (e: MouseEvent) => {
      if (!drawing) return;
      e.preventDefault();
      if (toolOverride === "eraser") return;
      const last = activePoints[activePoints.length - 1];
      finalizeStroke();
      toolOverride = "eraser";
      activeStrokeId = makeId();
      activePoints = last ? [last] : [];
      redrawLive();
    };
    window.addEventListener("contextmenu", handleContextMenu, true);

    // ── header actions: pen / eraser tool buttons ───────────────────────────
    // guards against header refresh during opacity/width/pressure/angle
    // scrubber drags
    let isDraggingOpacity = false;
    let isDraggingWidth = false;
    let isDraggingPressure = false;
    let isDraggingAngle = false;
    let isDraggingChiselAngle = false;

    // header drag-scrubbers deliver raw, unscaled pixel deltas (see
    // widget-frame.ts's createActionButton) — 1px of drag used to mean 1 unit
    // of change, which made fine adjustments hard to land. scale deltas down
    // and accumulate the fractional remainder so a full drag gesture still
    // covers the same range, just spread over more pixels.
    const DRAG_SENSITIVITY = 0.35;
    let opacityDragAccum = 0;
    let widthDragAccum = 0;
    let pressureDragAccum = 0;
    let angleDragAccum = 0;
    let chiselAngleDragAccum = 0;

    // ── header colour picker (DOM input, lives as long as it's open) ─────────
    let liveColorInput: HTMLInputElement | null = null;
    let colorCleanupTimer: ReturnType<typeof setTimeout> | null = null;

    const openHeaderColorPicker = (screenX: number, screenY: number) => {
      // remove any prior picker
      if (liveColorInput && document.body.contains(liveColorInput)) {
        document.body.removeChild(liveColorInput);
      }
      if (colorCleanupTimer !== null) {
        clearTimeout(colorCleanupTimer);
        colorCleanupTimer = null;
      }

      const { penColor } = ctx.doc.current;
      const input = document.createElement("input");
      input.type = "color";
      if (!isTransparent(penColor)) {
        input.value = "#" + (penColor & 0xffffff).toString(16).padStart(6, "0");
      }
      const SZ = 24;
      input.style.cssText = [
        "position:fixed",
        `left:${Math.round(screenX)}px`,
        `top:${Math.round(screenY)}px`,
        `width:${SZ}px`,
        `height:${SZ}px`,
        "opacity:0.001",
        "border:none",
        "padding:0",
        "z-index:10001",
      ].join(";");

      liveColorInput = input;
      document.body.appendChild(input);

      // update pen color live; cancel any pending cleanup
      const updateColor = () => {
        if (colorCleanupTimer !== null) {
          clearTimeout(colorCleanupTimer);
          colorCleanupTimer = null;
        }
        const hex = parseInt(input.value.slice(1), 16);
        ctx.doc.change((d) => {
          d.penColor = hex;
        });
      };
      input.addEventListener("input", updateColor);
      input.addEventListener("change", updateColor);

      // cleanup on blur: generous timeout lets "Show Colors…" stay open
      input.addEventListener("blur", () => {
        colorCleanupTimer = setTimeout(() => {
          if (document.body.contains(input)) document.body.removeChild(input);
          if (liveColorInput === input) liveColorInput = null;
          colorCleanupTimer = null;
        }, 3000);
      });

      // must run synchronously, in the same tick as the tap that opened
      // this — ios/ipad safari revokes "user activation" across a
      // requestAnimationFrame tick (or any other deferral), which silently
      // no-ops showPicker()/click() on a color input. this used to be
      // wrapped in requestAnimationFrame(); that's exactly why the picker
      // was so unreliable to open on ipad even though the button itself
      // was registering the tap fine.
      const opened = (input as any).showPicker
        ? (() => {
            try {
              (input as any).showPicker();
              return true;
            } catch {
              return false;
            }
          })()
        : false;
      if (!opened) input.click();
    };

    const makeHeaderActions = (): HeaderAction[] => {
      const { activeTool, brushShape, penOpacity, penWidth, locked, pressureScale, angleScale } =
        ctx.doc.current;
      const shape = brushShape ?? "circle";
      const opacity = penOpacity ?? 100;
      const width = Math.max(1, penWidth ?? 3);
      const pressure = Math.max(0, Math.min(100, pressureScale ?? 0));
      const angle = Math.max(0, Math.min(100, angleScale ?? 0));
      const angleApplicable = shape === "diamond" || shape === "chisel";
      return [
        {
          id: "eraser",
          label: "eraser",
          // rubber eraser tilted ~35° CCW, white tip on the leading edge,
          // three dashed marks below (matching the reference icon style).
          renderIcon: (parent: Container, size: number, color: number) => {
            const bw = Math.round(size * 0.7);
            const bh = Math.round(size * 0.36);
            const r = Math.max(2, Math.round(bh * 0.3));
            const tipW = Math.round(bw * 0.3);

            // ── eraser body (rotated) ──────────────────────────────────
            const bodyGfx = new Graphics();

            // full body in foreground color
            bodyGfx.roundRect(0, 0, bw, bh, r);
            bodyGfx.fill({ color, alpha: 0.92 });

            // white eraser tip on the left/leading portion
            bodyGfx.roundRect(0, 0, tipW + r, bh, r);
            bodyGfx.fill({ color: 0xffffff, alpha: 0.88 });

            // thin crimp line separating tip from body
            bodyGfx.rect(tipW, 1, 1, bh - 2);
            bodyGfx.fill({ color: 0x000000, alpha: 0.22 });

            // rotate ~35° CCW around a point near the bottom-centre of the body
            bodyGfx.pivot.set(bw * 0.5, bh * 0.65);
            bodyGfx.x = Math.round(size * 0.52);
            bodyGfx.y = Math.round(size * 0.48);
            bodyGfx.rotation = -0.62;
            parent.addChild(bodyGfx);

            // ── erasing marks (three dashes, not rotated) ──────────────
            const dashGfx = new Graphics();
            const dw = Math.round(size * 0.11);
            const dh = Math.max(1, Math.round(size * 0.065));
            const dy = Math.round(size * 0.82);
            for (let i = 0; i < 3; i++) {
              dashGfx.roundRect(Math.round(size * (0.09 + i * 0.25)), dy, dw, dh, 1);
            }
            dashGfx.fill({ color, alpha: 0.8 });
            parent.addChild(dashGfx);
          },
          active: activeTool === "eraser",
          onClick: () => setTool(activeTool === "eraser" ? "pen" : "eraser"),
        },
        {
          id: "penColor",
          label: "pen color",
          marginLeft: 4,
          renderIcon: (parent: Container, size: number, _iconColor: number) => {
            const pc = ctx.doc.current.penColor;
            const gfx = new Graphics();
            const r = Math.round(size * 0.36);
            const cx = size / 2;
            const cy = size / 2;
            if (isTransparent(pc)) {
              // mini checkerboard for transparent
              gfx.rect(cx - r, cy - r, r, r);
              gfx.fill({ color: 0xcccccc });
              gfx.rect(cx, cy, r, r);
              gfx.fill({ color: 0xcccccc });
              gfx.rect(cx, cy - r, r, r);
              gfx.fill({ color: 0x888888 });
              gfx.rect(cx - r, cy, r, r);
              gfx.fill({ color: 0x888888 });
            } else {
              gfx.circle(cx, cy, r);
              gfx.fill({ color: pc });
            }
            // ring outline for legibility on any background
            gfx.circle(cx, cy, r);
            gfx.stroke({ color: 0x000000, width: 1, alpha: 0.3 });
            gfx.circle(cx, cy, r + 1);
            gfx.stroke({ color: 0xffffff, width: 0.8, alpha: 0.2 });
            parent.addChild(gfx);
          },
          onClick: (pos) => {
            const canvasRect = ctx.canvasElement.getBoundingClientRect();
            const sx = pos ? canvasRect.left + pos.x : canvasRect.left + 60;
            const sy = pos ? canvasRect.top + pos.y : canvasRect.top + 40;
            openHeaderColorPicker(sx, sy);
          },
        },
        {
          id: "shape-circle",
          label: "○",
          active: shape === "circle",
          marginLeft: 8,
          onClick: () => setShape("circle"),
        },
        {
          id: "shape-rect",
          label: "□",
          active: shape === "rect",
          onClick: () => setShape("rect"),
        },
        {
          id: "shape-diamond",
          label: "◇",
          active: shape === "diamond",
          onClick: () => setShape("diamond"),
        },
        {
          id: "shape-chisel",
          label: "▬",
          active: shape === "chisel",
          // draggable like the opacity/width scrubbers — click selects the
          // chisel brush, click+drag rotates its nib angle. the icon itself
          // rotates live to show the current angle.
          renderIcon: (parent: Container, size: number, color: number) => {
            const chiselAngleDeg = Math.round(ctx.doc.current.chiselAngle ?? DEFAULT_CHISEL_ANGLE_DEG);
            const gfx = new Graphics();
            const barLen = size * 0.62;
            const barThick = Math.max(2, size * 0.16);
            gfx.roundRect(-barLen / 2, -barThick / 2, barLen, barThick, barThick * 0.3);
            gfx.fill({ color, alpha: 0.92 });
            gfx.x = size / 2;
            gfx.y = size / 2;
            gfx.rotation = chiselAngleDeg * DEG2RAD;
            parent.addChild(gfx);
          },
          onClick: () => setShape("chisel"),
          onDrag: (deltaX: number) => {
            isDraggingChiselAngle = true;
            chiselAngleDragAccum += deltaX * DRAG_SENSITIVITY;
            const step = Math.trunc(chiselAngleDragAccum);
            if (step === 0) return;
            chiselAngleDragAccum -= step;
            const cur = Math.round(ctx.doc.current.chiselAngle ?? DEFAULT_CHISEL_ANGLE_DEG);
            // wrap at ±180° so dragging past the edge keeps rotating instead
            // of clamping — an angle scrubber should spin freely.
            const next = (((cur + step + 180) % 360) + 360) % 360 - 180;
            if (next !== cur)
              ctx.doc.change((d) => {
                d.chiselAngle = next;
              });
          },
          onDragEnd: () => {
            isDraggingChiselAngle = false;
            chiselAngleDragAccum = 0;
            ctx.setHeaderActions?.(makeHeaderActions());
          },
        },
        {
          id: "opacity",
          label: `α${opacity}`,
          getLiveLabel: () => `α${ctx.doc.current.penOpacity ?? 100}`,
          marginLeft: 8,
          onDrag: (deltaX: number) => {
            isDraggingOpacity = true;
            opacityDragAccum += deltaX * DRAG_SENSITIVITY;
            const step = Math.trunc(opacityDragAccum);
            if (step === 0) return;
            opacityDragAccum -= step;
            const cur = ctx.doc.current.penOpacity ?? 100;
            const next = Math.max(1, Math.min(100, cur + step));
            if (next !== cur)
              ctx.doc.change((d) => {
                d.penOpacity = next;
              });
          },
          onDragEnd: () => {
            isDraggingOpacity = false;
            opacityDragAccum = 0;
            ctx.setHeaderActions?.(makeHeaderActions());
          },
        },
        {
          id: "width",
          label: `w${width}`,
          getLiveLabel: () => `w${Math.max(1, ctx.doc.current.penWidth ?? 3)}`,
          onDrag: (deltaX: number) => {
            isDraggingWidth = true;
            widthDragAccum += deltaX * DRAG_SENSITIVITY;
            const step = Math.trunc(widthDragAccum);
            if (step === 0) return;
            widthDragAccum -= step;
            const cur = Math.max(1, ctx.doc.current.penWidth ?? 3);
            const next = Math.max(1, Math.min(100, cur + step));
            if (next !== cur)
              ctx.doc.change((d) => {
                d.penWidth = next;
              });
          },
          onDragEnd: () => {
            isDraggingWidth = false;
            widthDragAccum = 0;
            ctx.setHeaderActions?.(makeHeaderActions());
          },
        },
        // pressure/angle scrubbers only show once a pen has actually been
        // used this session — irrelevant clutter for mouse/touch-only users.
        ...(penDetected
          ? [
              {
                id: "pressure",
                label: `p${pressure}`,
                getLiveLabel: () =>
                  `p${Math.max(0, Math.min(100, Math.round(ctx.doc.current.pressureScale ?? 0)))}`,
                active: pressure > 0,
                marginLeft: 8,
                // downward arrow pressing onto a curved surface — pressure applied to a stroke
                renderIcon: (parent: Container, size: number, color: number) => {
                  const cx = size * 0.5;
                  const gfx = new Graphics();
                  gfx.moveTo(cx, size * 0.16);
                  gfx.lineTo(cx, size * 0.46);
                  gfx.stroke({ width: Math.max(1.5, size * 0.11), color, alpha: 0.92, cap: "round" });
                  gfx.moveTo(cx - size * 0.17, size * 0.4);
                  gfx.lineTo(cx, size * 0.6);
                  gfx.lineTo(cx + size * 0.17, size * 0.4);
                  gfx.closePath();
                  gfx.fill({ color, alpha: 0.92 });
                  gfx.moveTo(size * 0.12, size * 0.76);
                  gfx.quadraticCurveTo(cx, size * 0.96, size * 0.88, size * 0.76);
                  gfx.stroke({ width: Math.max(1.5, size * 0.1), color, alpha: 0.92, cap: "round" });
                  parent.addChild(gfx);
                },
                onDrag: (deltaX: number) => {
                  isDraggingPressure = true;
                  pressureDragAccum += deltaX * DRAG_SENSITIVITY;
                  const step = Math.trunc(pressureDragAccum);
                  if (step === 0) return;
                  pressureDragAccum -= step;
                  const cur = Math.max(0, Math.min(100, ctx.doc.current.pressureScale ?? 0));
                  const next = Math.max(0, Math.min(100, cur + step));
                  if (next !== cur)
                    ctx.doc.change((d) => {
                      d.pressureScale = next;
                    });
                },
                onDragEnd: () => {
                  isDraggingPressure = false;
                  pressureDragAccum = 0;
                  ctx.setHeaderActions?.(makeHeaderActions());
                },
              } as HeaderAction,
            ]
          : []),
        ...(penDetected && angleApplicable
          ? [
              {
                id: "angle",
                label: `∠${angle}`,
                getLiveLabel: () =>
                  `∠${Math.max(0, Math.min(100, Math.round(ctx.doc.current.angleScale ?? 0)))}`,
                active: angle > 0,
                marginLeft: 8,
                onDrag: (deltaX: number) => {
                  isDraggingAngle = true;
                  angleDragAccum += deltaX * DRAG_SENSITIVITY;
                  const step = Math.trunc(angleDragAccum);
                  if (step === 0) return;
                  angleDragAccum -= step;
                  const cur = Math.max(0, Math.min(100, ctx.doc.current.angleScale ?? 0));
                  const next = Math.max(0, Math.min(100, cur + step));
                  if (next !== cur)
                    ctx.doc.change((d) => {
                      d.angleScale = next;
                    });
                },
                onDragEnd: () => {
                  isDraggingAngle = false;
                  angleDragAccum = 0;
                  ctx.setHeaderActions?.(makeHeaderActions());
                },
              } as HeaderAction,
            ]
          : []),
        {
          id: "undo",
          label: "↺",
          marginLeft: 8,
          onClick: undo,
        },
        {
          id: "redo",
          label: "↻",
          onClick: redo,
        },
        {
          id: "lock",
          label: locked ? "unlock" : "lock",
          active: locked,
          marginLeft: 8,
          // padlock icon — closed shackle when locked, swung open when unlocked.
          renderIcon: (parent: Container, size: number, color: number) => {
            const bodyW = Math.round(size * 0.56);
            const bodyH = Math.round(size * 0.42);
            const bodyX = Math.round((size - bodyW) / 2);
            const bodyY = Math.round(size * 0.5);
            const r = Math.max(2, Math.round(bodyW * 0.16));

            const bodyGfx = new Graphics();
            bodyGfx.roundRect(bodyX, bodyY, bodyW, bodyH, r);
            bodyGfx.fill({ color, alpha: 0.92 });
            // keyhole
            const kx = size / 2;
            const ky = bodyY + bodyH * 0.42;
            bodyGfx.circle(kx, ky, Math.max(1, bodyW * 0.09));
            bodyGfx.fill({ color: 0x000000, alpha: 0.35 });
            parent.addChild(bodyGfx);

            // shackle
            const shackleGfx = new Graphics();
            const shackleR = Math.round(bodyW * 0.34);
            const shackleW = Math.max(2, Math.round(size * 0.09));
            if (locked) {
              // closed: centered arc sitting flush on top of the body
              const cx = size / 2;
              const cy = bodyY;
              shackleGfx.arc(cx, cy, shackleR, Math.PI, 0, false);
              shackleGfx.stroke({ width: shackleW, color, cap: "round" });
            } else {
              // open: swung up and to the side, only one leg meets the body
              const cx = bodyX + bodyW * 0.32;
              const cy = bodyY - shackleR * 0.15;
              shackleGfx.arc(cx, cy, shackleR, Math.PI * 1.1, Math.PI * 0.15, false);
              shackleGfx.stroke({ width: shackleW, color, cap: "round" });
            }
            parent.addChild(shackleGfx);
          },
          onClick: () => setLocked(!locked),
        },
        // pen-lock is a local, in-memory-only session preference (never
        // written to the doc) — only offered once a pen has actually been
        // used, since it's meaningless without one.
        ...(penDetected
          ? [
              {
                id: "penLock",
                label: penLock ? "pen only" : "any input",
                active: penLock,
                marginLeft: 8,
                // pen nib silhouette — filled solid when pen-lock is active
                renderIcon: (parent: Container, size: number, color: number) => {
                  const gfx = new Graphics();
                  const cx = size * 0.5;
                  gfx.moveTo(cx, size * 0.14);
                  gfx.lineTo(cx + size * 0.16, size * 0.42);
                  gfx.lineTo(cx, size * 0.58);
                  gfx.lineTo(cx - size * 0.16, size * 0.42);
                  gfx.closePath();
                  gfx.fill({ color, alpha: penLock ? 0.95 : 0.4 });
                  gfx.rect(cx - size * 0.06, size * 0.58, size * 0.12, size * 0.28);
                  gfx.fill({ color, alpha: penLock ? 0.95 : 0.4 });
                  parent.addChild(gfx);
                },
                onClick: () => {
                  penLock = !penLock;
                  ctx.setHeaderActions?.(makeHeaderActions());
                },
              } as HeaderAction,
            ]
          : []),
      ];
    };

    const setLocked = (next: boolean) => {
      ctx.doc.change((d) => {
        d.locked = next;
      });
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    const setTool = (tool: string) => {
      ctx.doc.change((d) => {
        d.activeTool = tool;
      });
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    const setShape = (shape: string) => {
      ctx.doc.change((d) => {
        d.brushShape = shape;
      });
      ctx.setHeaderActions?.(makeHeaderActions());
    };

    // ── doc subscription ────────────────────────────────────────────────────
    // isDragging* suppresses header refreshes while a header scrubber is
    // being dragged — calling setHeaderActions mid-drag destroys the button
    // (and its pointer capture), so the drag breaks after a single pixel.
    const unsub = ctx.doc.on("change", (state) => {
      drawBackground();
      syncStrokes(state);
      updateCursor();
      maybeRegenerateSnapshot();
      if (state.locked && drawing) {
        // locked mid-stroke (e.g. by a peer) — abort the in-progress stroke
        // rather than let it commit after the fact.
        drawing = false;
        activePointerId = null;
        activePoints = [];
        activeStrokeId = "";
        toolOverride = null;
        liveGfx.clear();
        liveGfx.blendMode = "normal";
      }
      if (
        !isDraggingOpacity &&
        !isDraggingWidth &&
        !isDraggingPressure &&
        !isDraggingAngle &&
        !isDraggingChiselAngle
      ) {
        ctx.setHeaderActions?.(makeHeaderActions());
      }
    });

    // ── widget actions (shown in property tray) ──────────────────────────────
    const widgetActions: WidgetAction[] = [
      {
        id: "undo",
        label: "undo (⌘Z)",
        onClick: undo,
      },
      {
        id: "redo",
        label: "redo (⌘⇧Z)",
        onClick: redo,
      },
      {
        id: "clear",
        label: "clear canvas",
        onClick: clearAll,
      },
    ];

    return {
      container,
      headerActions: makeHeaderActions(),
      widgetActions,
      destroy() {
        destroyed = true;
        document.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("pointercancel", handlePointerCancel, true);
        window.removeEventListener("contextmenu", handleContextMenu, true);
        if (colorCleanupTimer !== null) clearTimeout(colorCleanupTimer);
        if (liveColorInput && document.body.contains(liveColorInput)) {
          document.body.removeChild(liveColorInput);
        }
        unsub();
        container.destroy({ children: true });
      },
      resize(w, h) {
        cw = w;
        ch = h;
        bgGfx.hitArea = new Rectangle(0, 0, cw, ch);
        drawBackground();
      },
    };
  },
};

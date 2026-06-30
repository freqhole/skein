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

const pointSchema = z.object({ x: z.number(), y: z.number() });

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
  /** brush shape: "circle" | "rect" | "diamond" */
  brushShape: z.string().default("circle"),
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
  penColor: z.number().default(() => randomDoodleColor()),
  /** pen width in pixels */
  penWidth: z.number().default(3),
  /** brush shape: "circle" | "rect" | "diamond" */
  brushShape: z.string().default("circle"),
  /** pen opacity 1–100; 100 = fully opaque */
  penOpacity: z.number().default(100),
  /** border color; -1 = transparent (no border) */
  borderColor: z.number().default(() => randomDoodleColor()),
  /** border width in pixels; 0 = no border */
  borderWidth: z.number().default(1),
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
 * supports three brush shapes: "circle" (round cap), "rect" (square cap),
 * and "diamond" (rotated square stamps along the path).
 */
function paintStroke(g: Graphics, stroke: DoodleStroke): void {
  const { points, color, width } = stroke;
  const alpha = (stroke.opacity ?? 100) / 100;
  const shape = stroke.brushShape ?? "circle";
  if (points.length === 0) return;

  if (shape === "diamond") {
    // stamp interpolated rotated squares along the full path so there are no
    // gaps — spacing is 40% of width to ensure solid overlap.
    const hw = width / 2;
    const step = Math.max(1, width * 0.4);

    const stamp = (x: number, y: number) => {
      g.moveTo(x, y - hw);
      g.lineTo(x + hw, y);
      g.lineTo(x, y + hw);
      g.lineTo(x - hw, y);
      g.closePath();
    };

    // always stamp the first point
    stamp(points[0].x, points[0].y);

    for (let i = 0; i < points.length - 1; i++) {
      const ax = points[i].x,
        ay = points[i].y;
      const bx = points[i + 1].x,
        by = points[i + 1].y;
      const dist = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(dist / step));
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        stamp(ax + (bx - ax) * t, ay + (by - ay) * t);
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
// widget factory
// ---------------------------------------------------------------------------

export const doodleWidget: WidgetFactory<typeof doodleSchema> = {
  type: "doodle",
  metadata: {
    name: "doodle",
    description: "freehand drawing with pen and eraser",
    version: "0.1.0",
    category: "basics",
    defaultWidth: 480,
    defaultHeight: 340,
  },
  schema: doodleSchema,
  editableProps: [
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
    { key: "penColor", label: "pen color", type: "color" as const, default: 0xffffff },
    { key: "penWidth", label: "pen width", type: "number" as const, default: 3 },
    {
      key: "brushShape",
      label: "brush shape",
      type: "select" as const,
      options: ["circle", "rect", "diamond"],
      default: "circle",
    },
    { key: "penOpacity", label: "opacity", type: "number" as const, default: 100 },
  ],

  getCompactInfo: (state: DoodleState): CompactInfo => ({
    label:
      state.strokes.length > 0
        ? `doodle · ${state.strokes.length} stroke${state.strokes.length === 1 ? "" : "s"}`
        : "empty doodle",
  }),

  create(ctx: WidgetMountContext<typeof doodleSchema>): WidgetController {
    let cw = ctx.width;
    let ch = ctx.height;

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

    // ── local drawing state ─────────────────────────────────────────────────
    let drawing = false;
    let activePointerId: number | null = null;
    let activePoints: Array<{ x: number; y: number }> = [];
    let activeStrokeId = "";

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
      const { activeTool, penColor, penWidth, brushShape, penOpacity } = ctx.doc.current;
      const width = Math.max(1, penWidth);
      const stroke: DoodleStroke = {
        id: activeStrokeId,
        tool: activeTool,
        color: penColor,
        width,
        opacity: penOpacity ?? 100,
        brushShape: brushShape ?? "circle",
        points: activePoints,
      };
      if (activeTool === "eraser") {
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

    bgGfx.on("pointerdown", (e: any) => {
      if (drawing) return;
      e.stopPropagation();
      drawing = true;
      activePointerId = e.pointerId;
      activeStrokeId = makeId();
      activePoints = [];
      const lp = e.getLocalPosition(container);
      activePoints.push({ x: lp.x, y: lp.y });
      redrawLive();
    });

    // use globalpointermove so strokes continue tracking when pointer
    // drifts outside the bgGfx hitArea mid-stroke
    bgGfx.on("globalpointermove", (e: any) => {
      if (!drawing || e.pointerId !== activePointerId) return;
      const lp = e.getLocalPosition(container);
      const last = activePoints[activePoints.length - 1];
      const dx = lp.x - last.x;
      const dy = lp.y - last.y;
      // skip micro-movements (< 2px) to keep point counts manageable
      if (dx * dx + dy * dy < 4) return;
      activePoints.push({ x: lp.x, y: lp.y });
      redrawLive();
    });

    const commitStroke = (e: any) => {
      if (!drawing || (e && e.pointerId !== activePointerId)) return;
      drawing = false;
      activePointerId = null;

      if (activePoints.length === 0) {
        liveGfx.clear();
        liveGfx.blendMode = "normal";
        return;
      }

      const { activeTool, penColor, penWidth, brushShape, penOpacity } = ctx.doc.current;
      const stroke: DoodleStroke = {
        id: activeStrokeId,
        tool: activeTool,
        color: penColor,
        width: Math.max(1, penWidth),
        opacity: penOpacity ?? 100,
        brushShape: brushShape ?? "circle",
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

    bgGfx.on("pointerup", commitStroke);
    bgGfx.on("pointerupoutside", commitStroke);

    // ── header actions: pen / eraser tool buttons ───────────────────────────
    // guards against header refresh during opacity/width scrubber drag
    let isDraggingOpacity = false;
    let isDraggingWidth = false;

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

      requestAnimationFrame(() => {
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
      });
    };

    const makeHeaderActions = (): HeaderAction[] => {
      const { activeTool, brushShape, penOpacity, penWidth } = ctx.doc.current;
      const shape = brushShape ?? "circle";
      const opacity = penOpacity ?? 100;
      const width = Math.max(1, penWidth ?? 3);
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
          id: "opacity",
          label: `α${opacity}`,
          getLiveLabel: () => `α${ctx.doc.current.penOpacity ?? 100}`,
          marginLeft: 8,
          onDrag: (deltaX: number) => {
            isDraggingOpacity = true;
            const cur = ctx.doc.current.penOpacity ?? 100;
            const next = Math.max(1, Math.min(100, Math.round(cur + deltaX)));
            if (next !== cur)
              ctx.doc.change((d) => {
                d.penOpacity = next;
              });
          },
          onDragEnd: () => {
            isDraggingOpacity = false;
            ctx.setHeaderActions?.(makeHeaderActions());
          },
        },
        {
          id: "width",
          label: `w${width}`,
          getLiveLabel: () => `w${Math.max(1, ctx.doc.current.penWidth ?? 3)}`,
          onDrag: (deltaX: number) => {
            isDraggingWidth = true;
            const cur = Math.max(1, ctx.doc.current.penWidth ?? 3);
            const next = Math.max(1, Math.min(100, Math.round(cur + deltaX)));
            if (next !== cur)
              ctx.doc.change((d) => {
                d.penWidth = next;
              });
          },
          onDragEnd: () => {
            isDraggingWidth = false;
            ctx.setHeaderActions?.(makeHeaderActions());
          },
        },
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
      ];
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
    // isDraggingOpacity suppresses header refreshes while the opacity scrubber
    // is being dragged — calling setHeaderActions mid-drag destroys the button
    // (and its pointer capture), so the drag breaks after a single pixel.
    const unsub = ctx.doc.on("change", (state) => {
      drawBackground();
      syncStrokes(state);
      if (!isDraggingOpacity && !isDraggingWidth) {
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
        document.removeEventListener("keydown", handleKeyDown);
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

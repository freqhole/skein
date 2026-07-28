import { z } from "zod";

const slotSchema = z.object({
  col: z.number(),
  row: z.number(),
});

const binItemSchema = z.object({
  widgetId: z.string(),
  slot: slotSchema,
});

export const binSchema = z.object({
  /** layout mode */
  mode: z.enum(["grid", "shelf", "crate", "drawer"]).default("grid"),
  /** display title for the bin header */
  title: z.string().default(""),
  /** number of columns */
  cols: z.number().default(3),
  /** number of rows — auto-computed from items.length / cols */
  rows: z.number().default(1),
  /** ordered list of child widgets and their slot positions */
  items: z.array(binItemSchema).default([]),
  /** shelf text direction — top = text reads top-to-bottom, bottom = bottom-to-top */
  shelfTextOrigin: z.enum(["top", "bottom"]).default("top"),
  /** slot size preset — controls density of the grid */
  slotScale: z.enum(["s", "m", "l", "xl"]).default("m"),
  /** border width around the whole bin, in px — 0 means no border */
  borderWidth: z.number().default(0),
  /** border color, as a 0xRRGGBB number — -1 means no border regardless of width */
  borderColor: z.number().default(-1),
  /** when true, also draws a shared table-like grid of border lines between
   *  every cell (not just the bin's own outer border) — reuses borderWidth
   *  and borderColor above rather than a separate style/thickness setting */
  cellBorders: z.boolean().default(false),
  /**
   * cover/thumbnail image for the bin itself, as a data URL (webp, resized to
   * ~500px on the long edge) — empty string means no cover set. shown behind
   * the grid contents, and used as the compact-card thumbnail when the bin
   * is collapsed inside another bin.
   */
  coverThumbnailDataUrl: z.string().default(""),
});

export type BinState = z.infer<typeof binSchema>;

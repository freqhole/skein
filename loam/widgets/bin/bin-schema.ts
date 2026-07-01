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
});

export type BinState = z.infer<typeof binSchema>;

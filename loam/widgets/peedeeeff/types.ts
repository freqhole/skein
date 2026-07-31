import type { Sprite, Texture } from "pixi.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export const peedeeeffSchema = z.object({
  blobId: z.string().default(""),
  filename: z.string().default(""),
  mime: z.string().default(""),
  blake3: z.string().default(""),
  size: z.number().default(0),
  pageCount: z.number().default(0),
  pageBlobIds: z.array(z.string()).default([]),
  pageBlake3s: z.array(z.string()).default([]),
  currentPage: z.number().default(0),
  pagesPerView: z.number().default(1),
  syncPage: z.boolean().default(true),
  background: z.number().default(0xffffff),
  // best-effort persisted thumbnail (first page) for bin/compact display —
  // bins never mount a child widget's full lifecycle, only read
  // getCompactInfo(), so there's nothing else to lazily fetch a thumbnail
  // for a document sitting in a bin. populated once at creation time (see
  // file.ts / bin/index.ts's multi-file upload flows) via the same
  // `getThumbnailDataUrl` pipeline the file widget already uses.
  thumbnailDataUrl: z.string().default(""),
  // coordination for hub/peer-driven rendering (browser peers can't render
  // documents themselves — see peedeeeff/index.ts's handleUpload). purely
  // an efficiency guard against multiple online peers all issuing the same
  // render request concurrently — rendering itself is idempotent (page
  // blobs are content-addressed), so a stale/missing claim is harmless.
  processingClaimedBy: z.string().default(""),
  processingClaimedAt: z.number().default(0),
});

export type PeedeeeffState = z.infer<typeof peedeeeffSchema>;

// ---------------------------------------------------------------------------
// page loading
// ---------------------------------------------------------------------------

export type PageLoadState = "empty" | "loading" | "loaded" | "error";
export type ActionState = "checking" | "local" | "remote" | "snatching" | "snatched";

export interface PageSlot {
  state: PageLoadState;
  texture: Texture | null;
  sprite: Sprite | null;
  assetKey: string;
  abort: AbortController | null;
}

// ---------------------------------------------------------------------------
// nav constants
// ---------------------------------------------------------------------------

export const NAV_BTN_W = 32;
export const NAV_BTN_H = 48;
export const NAV_BTN_RADIUS = 6;
export const NAV_HIDE_DELAY = 1200;
export const GO_START_SIZE = 26;

/** a processing claim older than this is considered abandoned (peer likely
 *  went offline mid-render) and may be reclaimed by another peer. */
export const PROCESSING_CLAIM_STALE_MS = 45_000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

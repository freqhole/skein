/**
 * shared type vocabulary for the `timeline/` kit — kept in its own module
 * (no logic) so `track-item-interaction.ts`/`track-item-render.ts`/callers
 * can all reference the same shapes without a circular import.
 */

import type { Container } from "pixi.js";

/** the minimum shape `track-item-interaction.ts` needs from a track item —
 *  callers with a richer item type (e.g. animaniac's `Clip` union) just
 *  need `id`/`start`/`end` to also be present (readable, not necessarily
 *  the item's own literal fields — see `TrackItemAdapter` below). */
export interface TrackItemSpan {
  id: string;
  start: number;
  end: number;
}

export type TrackDragMode = "create" | "move" | "resize-left" | "resize-right";
export type TrackHitRegion = "delete" | TrackDragMode;

/** visual state passed to a caller's `drawItem()` — everything needed to
 *  render one item's body/handles/glyph without the drawing code needing
 *  to know about drag/hover/selection bookkeeping itself. */
export interface TrackItemDrawState {
  left: number;
  right: number;
  hovered: boolean;
  hoveredRegion: TrackHitRegion | null;
  selected: boolean;
}

/** adapts a caller's own item type `T` to the plain `{id,start,end}` shape
 *  the interaction engine operates on, and back again for writes — lets
 *  `stfu`'s bare `[start, end]` tuples and animaniac's richer `Clip`
 *  objects share the same engine without either shape needing to change. */
export interface TrackItemAdapter<T> {
  getId: (item: T, index: number) => string;
  getSpan: (item: T) => { start: number; end: number };
  /** produce an updated item with a new [start, end] — must preserve
   *  every other field of `item` (e.g. a clip's own kind/blobId/keyframes). */
  withSpan: (item: T, span: { start: number; end: number }) => T;
}

/** the subset of `TimelineCamera` (see `timeline-camera.ts`) the
 *  interaction/render modules need — kept narrow so tests can pass a
 *  trivial stub instead of a full camera. */
export interface TrackCameraView {
  timeToScreenX: (t: number) => number;
  screenXToTime: (x: number) => number;
}

/** the pixi containers one track row contributes — matches the fields
 *  `video-timeline.ts`/`timeline-rows.ts` already expose per row. */
export interface TrackRowContainers {
  /** unscaled layer to draw item Graphics into (repositioned from scratch
   *  on every camera view change, x=0 is the row's own left edge). */
  contentLayer: Container;
  /** the row's background/hit-area — real pointer listeners attach here. */
  hitArea: Container;
}

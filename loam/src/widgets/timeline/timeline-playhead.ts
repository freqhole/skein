/**
 * one continuous vertical playhead line spanning a timeline's current row
 * stack — a single `Graphics`, not one line per row (drawing one per row
 * with gaps between rows reads as a dashed/broken line, not one
 * continuous playhead — see `stfu/video-timeline.ts`'s own history on
 * this exact bug). generic: takes only geometry, no camera/row knowledge.
 */

import { Container, Graphics } from "pixi.js";

export interface TimelinePlayheadHandle {
  /** redraw at screen-x `x` (in the same frame as row content — caller's
   *  `parent` should already be offset by the row label column), spanning
   *  from `top` to `top + height`. pass `x < 0` or `x` past the visible
   *  width to hide it (still redraws, just draws nothing) — callers
   *  should check visibility themselves and pass an out-of-range x rather
   *  than toggling `.visible`, keeping this module state-free. */
  update(x: number, top: number, height: number, visible: boolean): void;
  /** re-parent the playhead line to the end of `parent`'s children,
   *  making it the topmost sibling again — call after any operation that
   *  might add new siblings to `parent` (e.g. a row stack lazily creating
   *  a new track row's `Container`), since those are otherwise added
   *  AFTER (and so render on top of) a playhead created earlier. */
  bringToFront(): void;
  destroy(): void;
}

export function createTimelinePlayhead(parent: Container, color = 0xd946ef): TimelinePlayheadHandle {
  const line = new Graphics();
  line.eventMode = "none"; // purely visual — never a hit-test target
  parent.addChild(line);

  return {
    update(x: number, top: number, height: number, visible: boolean): void {
      line.clear();
      if (!visible) return;
      line.moveTo(x, top).lineTo(x, top + height).stroke({ width: 1, color });
    },
    bringToFront(): void {
      parent.addChild(line);
    },
    destroy() {
      line.destroy();
    },
  };
}

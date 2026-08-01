// shared vertical-scroll wiring for text-ish widgets (notepad, markdown)
// whose content can overflow their fixed widget height. wraps @pixi/ui's
// ScrollBox with the document-capture-phase wheel listener + the
// `_skeinWidgetScroll` flag pattern established in
// narthex/social/hub-profile-panel.ts — see that file's comment for why a
// hand-rolled pixi wheel handler (container "wheel" events, an explicit
// hitArea, a canvas-level capture listener) doesn't scroll reliably: pixi's
// wheel dispatch depends on hit-testing under the pointer, and the canvas
// viewport's own wheel handler (viewport.ts) pans the world for anything
// that falls through unless it sees the flag set first.

import { Container, Graphics } from "pixi.js";
import { ScrollBox } from "@pixi/ui";

export interface ScrollableContent {
  /** add widget content here instead of directly under the widget's own container */
  readonly content: Container;
  /** call from the widget's resize(width, height) with the *inner* (padded) area size */
  resize(width: number, height: number): void;
  /** call after content changes (text/reflow) with the new total content height */
  reflow(contentWidth: number, contentHeight: number): void;
  /** call from the widget's destroy() */
  destroy(): void;
}

/**
 * mount a scrollable content area at (x, y) sized (width, height) inside
 * `parent`. returns a `content` container to add widget-specific display
 * objects to (positioned relative to the scroll area's own origin, not
 * `parent`'s).
 */
export function createScrollableContent(
  parent: Container,
  canvasElement: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number
): ScrollableContent {
  let currentWidth = Math.max(width, 1);
  let currentHeight = Math.max(height, 1);
  let destroyed = false;

  let scrollBoxRef: ScrollBox | null = null;
  const onNativeWheel = (e: WheelEvent) => {
    if (destroyed || !scrollBoxRef) return;
    for (let node: Container | null = scrollBoxRef; node; node = node.parent) {
      if (!node.visible) return;
    }
    // pixi is configured with autoDensity, so global stage coords are CSS
    // pixels — clientX/Y relative to the canvas rect maps 1:1
    const rect = canvasElement.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const g = scrollBoxRef.getGlobalPosition();
    const inside = px >= g.x && px <= g.x + currentWidth && py >= g.y && py <= g.y + currentHeight;
    // prime/correct ScrollBox's isOver (its own document-capture handler
    // runs right after this one), and flag the event so viewport.ts's pan
    // handler leaves it alone.
    (scrollBoxRef as unknown as { isOver: boolean }).isOver = inside;
    if (inside) {
      (e as { _skeinWidgetScroll?: boolean } & WheelEvent)._skeinWidgetScroll = true;
    }
  };
  document.addEventListener("wheel", onNativeWheel, { capture: true, passive: true });

  const scrollBox = new ScrollBox({
    width: currentWidth,
    height: currentHeight,
    globalScroll: false,
    disableEasing: true,
  });
  scrollBox.x = x;
  scrollBox.y = y;
  scrollBoxRef = scrollBox;
  parent.addChild(scrollBox);

  const content = new Container();
  content.eventMode = "static";
  // explicit sizing rect: gives `content` real, deterministic bounds so
  // ScrollBox's List can measure it (a bounds-less container triggers its
  // "ScrollBox item should have size" warning and measures 0), and doubles
  // as the hit surface for isOver/drag-to-scroll over gaps between lines.
  const sizingRect = new Graphics();
  const drawSizing = (w: number, h: number) => {
    sizingRect.clear();
    sizingRect.rect(0, 0, Math.max(w, 1), Math.max(h, 1));
    sizingRect.fill({ color: 0x000000, alpha: 0.0001 });
  };
  drawSizing(currentWidth, 1);
  content.addChildAt(sizingRect, 0);
  scrollBox.addItem(content);

  return {
    content,

    resize(w: number, h: number) {
      currentWidth = Math.max(w, 1);
      currentHeight = Math.max(h, 1);
      scrollBox.setSize(currentWidth, currentHeight);
    },

    reflow(contentWidth: number, contentHeight: number) {
      drawSizing(contentWidth, contentHeight);
      scrollBox.resize(true);
    },

    destroy() {
      destroyed = true;
      document.removeEventListener("wheel", onNativeWheel, { capture: true } as EventListenerOptions);
      scrollBox.destroy({ children: true });
    },
  };
}

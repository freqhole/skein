/**
 * shared DOM overlay for hover-to-animate gifs over a PixiJS container.
 *
 * pixi textures only ever show a gif's first frame (there's no animated-gif
 * texture support in this app) — everywhere a gif is displayed on a canvas,
 * it's a static image at rest. this overlay creates a real `<img>` element
 * positioned over the PixiJS container (same `toGlobal` + canvas
 * `getBoundingClientRect` technique as `dom-overlay.ts`) so hovering plays
 * the actual animated gif, and moving away reveals the static pixi sprite
 * underneath again.
 */

import type { Container } from "pixi.js";

export interface GifHoverOverlayOptions {
  /** PixiJS Container whose global position anchors the overlay */
  container: Container;
  /** the <canvas> DOM element for getBoundingClientRect */
  canvasElement: HTMLCanvasElement;
  /** overlay width in PixiJS local coordinates */
  width: number;
  /** overlay height in PixiJS local coordinates */
  height: number;
  /** raw gif bytes as a data:/blob: URL (must be the real animated bytes,
   *  not a pre-rendered static thumbnail) */
  src: string;
  /** css object-fit for the <img> (default "contain") */
  fit?: "contain" | "cover";
  /** border radius in px, matches the underlying sprite's rounding */
  borderRadius?: number;
}

export interface GifHoverOverlayHandle {
  /** remove the element from the DOM. safe to call multiple times. */
  remove(): void;
}

/**
 * create a hover-animated gif overlay. caller is responsible for creating
 * this on `pointerenter` and calling `remove()` on `pointerleave` (or on
 * widget destroy) — there's no auto-hide timer.
 */
export function createGifHoverOverlay(options: GifHoverOverlayOptions): GifHoverOverlayHandle {
  const { container, canvasElement, width, height, src, fit = "contain", borderRadius = 0 } =
    options;

  const globalPos = container.toGlobal({ x: 0, y: 0 });
  const globalEnd = container.toGlobal({ x: width, y: height });
  const canvasRect = canvasElement.getBoundingClientRect();

  const img = document.createElement("img");
  img.src = src;
  img.draggable = false;

  const s = img.style;
  s.position = "fixed";
  s.left = `${canvasRect.left + globalPos.x}px`;
  s.top = `${canvasRect.top + globalPos.y}px`;
  s.width = `${globalEnd.x - globalPos.x}px`;
  s.height = `${globalEnd.y - globalPos.y}px`;
  s.objectFit = fit;
  s.borderRadius = `${borderRadius}px`;
  s.pointerEvents = "none";
  s.zIndex = "9000";

  document.body.appendChild(img);

  let removed = false;
  return {
    remove() {
      if (removed) return;
      removed = true;
      img.remove();
    },
  };
}

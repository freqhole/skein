/**
 * positions a real DOM `<video>` element over a moving/scaling pixi region —
 * generalized from `bin/bin-media.ts`'s original `createVideoTracker()`
 * (a hover-thumbnail-only version tied to a bin card) so any widget can host
 * a persistent, resizable video area, not just a hover-triggered preview.
 * mirrors `dom-overlay.ts`'s "DOM element tracks pixi coordinates" role, but
 * for video playback rather than text input.
 */

import type { Container } from "pixi.js";

export interface MediaDomOverlayHandle {
  video: HTMLVideoElement;
  wrapper: HTMLDivElement;
  /** stop tracking, tear down the DOM element, and remove listeners */
  close: () => void;
}

export interface MediaDomOverlayOptions {
  src: string;
  mime?: string;
  /** the pixi container whose local (0,0)..(size) rect the video tracks —
   *  local coordinates are converted to screen coordinates every tracked
   *  frame via `toGlobal()` + the canvas element's bounding rect. */
  container: Container;
  canvasElement: HTMLCanvasElement;
  /** called every tracked frame — lets the tracked area resize live
   *  (e.g. the widget frame being resized) without recreating the overlay. */
  getSize: () => { width: number; height: number };
  muted?: boolean;
  loop?: boolean;
  /** show native browser video controls (play/pause/scrub/volume).
   *  default false, matching the original hover-preview behavior. */
  controls?: boolean;
  objectFit?: "cover" | "contain";
}

/**
 * create and start tracking a DOM `<video>` positioned over `options.container`.
 * the returned handle's `close()` must be called exactly once to tear down
 * the rAF loop, DOM nodes, and fullscreen listeners.
 */
export function createMediaDomOverlay(options: MediaDomOverlayOptions): MediaDomOverlayHandle {
  const {
    src,
    mime,
    container,
    canvasElement,
    getSize,
    muted = false,
    loop = false,
    controls = false,
    objectFit = "cover",
  } = options;

  const wrapper = document.createElement("div");
  const ws = wrapper.style;
  ws.position = "fixed";
  ws.zIndex = "15000";
  ws.pointerEvents = controls ? "auto" : "none";
  ws.overflow = "hidden";
  ws.backgroundColor = "rgba(0,0,0,0.9)";
  ws.borderRadius = "3px";

  const video = document.createElement("video");
  video.src = src;
  if (mime) video.setAttribute("type", mime);
  video.playsInline = true;
  video.muted = muted;
  video.loop = loop;
  video.controls = controls;
  const vs = video.style;
  vs.width = "100%";
  vs.height = "100%";
  vs.objectFit = objectFit;
  vs.display = "block";
  vs.borderRadius = "3px";
  vs.outline = "none";
  vs.pointerEvents = controls ? "auto" : "none";
  wrapper.appendChild(video);

  // toggle pointer-events on fullscreen change so native controls stay
  // clickable while fullscreen, matching the original hover-preview behavior
  const onFullscreenChange = (): void => {
    const fsEl = document.fullscreenElement ?? (document as any).webkitFullscreenElement;
    if (fsEl === video || fsEl === wrapper) {
      ws.pointerEvents = "auto";
      vs.pointerEvents = "auto";
      video.controls = true;
    } else {
      ws.pointerEvents = controls ? "auto" : "none";
      vs.pointerEvents = controls ? "auto" : "none";
      video.controls = controls;
    }
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  document.body.appendChild(wrapper);

  let closed = false;
  let rafId = 0;

  // track last values to avoid redundant DOM updates
  let lastX = -1;
  let lastY = -1;
  let lastW = -1;
  let lastH = -1;

  const track = (): void => {
    if (closed) return;

    if (container.destroyed) {
      close();
      return;
    }

    const { width: thumbW, height: thumbH } = getSize();
    const globalPos = container.toGlobal({ x: 0, y: 0 });
    const globalEnd = container.toGlobal({ x: thumbW, y: thumbH });
    const rect = canvasElement.getBoundingClientRect();

    const screenX = Math.round(rect.left + globalPos.x);
    const screenY = Math.round(rect.top + globalPos.y);
    const screenW = Math.round(globalEnd.x - globalPos.x);
    const screenH = Math.round(globalEnd.y - globalPos.y);

    if (screenX !== lastX || screenY !== lastY || screenW !== lastW || screenH !== lastH) {
      ws.left = `${screenX}px`;
      ws.top = `${screenY}px`;
      ws.width = `${screenW}px`;
      ws.height = `${screenH}px`;
      lastX = screenX;
      lastY = screenY;
      lastW = screenW;
      lastH = screenH;
    }

    // hide if off-screen
    const canvasRight = Math.round(rect.left + rect.width);
    const canvasBottom = Math.round(rect.top + rect.height);
    const visible =
      screenX + screenW > Math.round(rect.left) &&
      screenY + screenH > Math.round(rect.top) &&
      screenX < canvasRight &&
      screenY < canvasBottom;
    ws.display = visible ? "block" : "none";

    rafId = requestAnimationFrame(track);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (rafId) cancelAnimationFrame(rafId);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    const fsEl = document.fullscreenElement ?? (document as any).webkitFullscreenElement;
    if (fsEl === video || fsEl === wrapper) {
      document.exitFullscreen?.().catch(() => {});
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    wrapper.remove();
  };

  rafId = requestAnimationFrame(track);

  return { video, wrapper, close };
}

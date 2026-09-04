/**
 * feature-flagged alternative video renderer for animaniac's composition
 * preview (see `local-prefs.ts`'s `isDomVideoOverlayEnabled()`) — mounts
 * real HTML `<video>` elements (`position: absolute`, inside a wrapper
 * clipped to the preview area's own screen rect) directly over the pixi
 * canvas instead of feeding pixi.js's own `VideoSource`/
 * `Texture.from(video)` GPU path (see `compositor.ts`'s `makeVideoEntry()`),
 * which hits a still-open upstream pixi.js bug ("WebGL: INVALID_VALUE:
 * Offset overflows texture dimensions",
 * https://github.com/pixijs/pixijs/issues/11001) and generally poor video
 * decode/playback quality on some platforms (tauri's wkwebview/webkitgtk
 * in particular).
 *
 * deliberately does NOT own video element lifecycle (creation, seeking,
 * play/pause, mute-sync) — `compositor.ts`'s own pool already does all of
 * that identically regardless of the flag (see its own `domVideoMode`
 * option, which only changes whether it ALSO attaches a pixi Sprite/
 * VideoSource for the same element). this module just asks the compositor
 * for each active video-segment clip's own `<video>` element + current
 * on-screen rect (derived from the exact same keyframe transform pixi
 * itself applies — including a live drag-transform in progress via
 * `preview-transform-editor.ts`'s `beginLiveEdit()`) and positions/
 * reparents it every tick. clicking/dragging/resizing still works exactly
 * as before: `preview-transform-editor.ts` hit-tests against its own
 * geometry (natural size + transform), never against the pixi sprite's
 * actual visible pixels, so an invisible pixi placeholder underneath is
 * enough.
 */

import type { Container } from "pixi.js";
import type { CompositorHandle } from "./compositor";
import { activeClipsAt, clipsForTrack, sortedTracks } from "./track-model";
import type { Clip, Track } from "./types";

export interface DomVideoOverlayOptions {
  /** anchors the wrapper's own screen rect — must match the compositor's
   *  own (masked) preview content area exactly, in the SAME local
   *  coordinate space `getPreviewSize()` describes. */
  previewClipLayer: Container;
  canvasElement: HTMLCanvasElement;
  getPreviewSize: () => { width: number; height: number };
  getTracks: () => Track[];
  getClips: () => Clip[];
  compositor: CompositorHandle;
}

export interface DomVideoOverlayHandle {
  /** call every tick alongside `compositor.update()` (AFTER it, so this
   *  tick's transform is already fresh) with the current absolute
   *  timeline time. no-ops harmlessly if there are no active video-segment
   *  clips. */
  update(t: number): void;
  /** detach every currently-mounted `<video>` element without destroying
   *  it (compositor still owns it) — call when the feature flag is
   *  toggled off mid-session so no stale element is left floating. */
  clear(): void;
  destroy(): void;
}

export function createDomVideoOverlay(options: DomVideoOverlayOptions): DomVideoOverlayHandle {
  const { previewClipLayer, canvasElement, getPreviewSize, getTracks, getClips, compositor } = options;

  const wrapper = document.createElement("div");
  const ws = wrapper.style;
  ws.position = "fixed";
  ws.overflow = "hidden";
  ws.pointerEvents = "none";
  // above the pixi <canvas> element itself, below real UI chrome (modals/
  // toasts/etc. all use much higher z-indices elsewhere in this codebase).
  ws.zIndex = "500";
  document.body.appendChild(wrapper);

  const mounted = new Map<string, HTMLVideoElement>();

  function unmount(clipId: string): void {
    const video = mounted.get(clipId);
    if (!video) return;
    video.remove();
    mounted.delete(clipId);
  }

  function computeWrapperRect(): { x: number; y: number; w: number; h: number } {
    const { width, height } = getPreviewSize();
    const topLeft = previewClipLayer.toGlobal({ x: 0, y: 0 });
    const bottomRight = previewClipLayer.toGlobal({ x: width, y: height });
    const canvasRect = canvasElement.getBoundingClientRect();
    return {
      x: canvasRect.left + topLeft.x,
      y: canvasRect.top + topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };
  }

  function update(t: number): void {
    const tracks = getTracks();
    const clips = getClips();
    const active = activeClipsAt(clips, t).filter((c): c is Extract<Clip, { kind: "video-segment" }> => c.kind === "video-segment");
    const activeIds = new Set(active.map((c) => c.id));

    for (const id of mounted.keys()) {
      if (!activeIds.has(id)) unmount(id);
    }

    if (active.length === 0) {
      wrapper.style.width = "0px";
      wrapper.style.height = "0px";
      return;
    }

    const wrapperRect = computeWrapperRect();
    wrapper.style.left = `${wrapperRect.x}px`;
    wrapper.style.top = `${wrapperRect.y}px`;
    wrapper.style.width = `${Math.max(0, wrapperRect.w)}px`;
    wrapper.style.height = `${Math.max(0, wrapperRect.h)}px`;

    // z-order: matches compositor.ts's own convention (top-of-track-list
    // drawn on top) — same reversed-`sortedTracks()` walk.
    const orderedClips: Clip[] = [];
    for (const track of sortedTracks(tracks.filter((tr) => !tr.hidden)).reverse()) {
      orderedClips.push(...clipsForTrack(active, track.id));
    }

    orderedClips.forEach((clip, i) => {
      const video = compositor.getVideoElement(clip.id);
      const rect = compositor.getVideoScreenRect(clip.id);
      if (!video || !rect) return;
      if (!mounted.has(clip.id)) {
        video.style.position = "absolute";
        video.style.transformOrigin = "center";
        video.style.objectFit = "fill";
        video.style.pointerEvents = "none";
        wrapper.appendChild(video);
        mounted.set(clip.id, video);
      }
      const s = video.style;
      s.left = `${rect.centerX - wrapperRect.x}px`;
      s.top = `${rect.centerY - wrapperRect.y}px`;
      s.width = `${rect.width}px`;
      s.height = `${rect.height}px`;
      s.opacity = String(rect.opacity);
      s.transform = `translate(-50%, -50%) rotate(${rect.rotationDeg}deg)`;
      s.zIndex = String(i);
    });
  }

  function clear(): void {
    for (const id of [...mounted.keys()]) unmount(id);
  }

  function destroy(): void {
    clear();
    wrapper.remove();
  }

  return { update, clear, destroy };
}

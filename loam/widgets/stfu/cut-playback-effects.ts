/**
 * "cut playback" preview effects — the red-tinted "cut" overlay + optional
 * skip/mute behavior applied while the video plays over a cut-list segment.
 * direct port of trek-minus-paris editor.js's `#cut-overlay` (see
 * editor.css) plus its skip/mute-early logic. pulled out of index.ts to
 * keep that file from growing further.
 */

import type { EditableSegment } from "./cut-segments-track";

/** builds the DOM overlay element (giant red "×" + "cut" label) — appended
 *  into the media overlay's own wrapper div by the caller (see
 *  media-dom-overlay.ts) so it's torn down automatically alongside the
 *  video element. starts fully transparent; toggled via `setCutOverlayActive()`. */
export function createCutOverlayElement(): HTMLDivElement {
  const el = document.createElement("div");
  const s = el.style;
  s.position = "absolute";
  s.inset = "0";
  s.display = "flex";
  s.flexDirection = "column";
  s.alignItems = "center";
  s.justifyContent = "center";
  s.gap = "0.5rem";
  s.background = "rgba(200, 0, 0, 0.18)";
  s.opacity = "0";
  s.pointerEvents = "none";
  s.transition = "opacity 0.08s ease";

  const xMark = document.createElement("div");
  xMark.textContent = "\u00d7";
  const xs = xMark.style;
  xs.fontSize = "9rem";
  xs.lineHeight = "1";
  xs.fontWeight = "700";
  xs.color = "rgba(255, 45, 45, 0.9)";
  xs.textShadow = "0 0 24px rgba(0, 0, 0, 0.7)";

  const label = document.createElement("div");
  label.textContent = "cut";
  const ls = label.style;
  ls.fontSize = "1.1rem";
  ls.fontWeight = "600";
  ls.letterSpacing = "0.25em";
  ls.textTransform = "uppercase";
  ls.color = "rgba(255, 255, 255, 0.92)";
  ls.background = "rgba(0, 0, 0, 0.55)";
  ls.padding = "0.2rem 0.9rem";
  ls.borderRadius = "4px";

  el.appendChild(xMark);
  el.appendChild(label);
  return el;
}

export function setCutOverlayActive(overlayEl: HTMLDivElement | null, active: boolean): void {
  if (overlayEl) overlayEl.style.opacity = active ? "1" : "0";
}

export function findContainingSegment(segments: EditableSegment[], t: number): EditableSegment | null {
  for (const seg of segments) {
    if (t >= seg[0] && t < seg[1]) return seg;
  }
  return null;
}

export interface ApplyCutPlaybackEffectsOptions {
  video: HTMLVideoElement;
  overlayEl: HTMLDivElement | null;
  editableSegments: EditableSegment[];
  cutSkipEnabled: boolean;
  cutMuteEnabled: boolean;
  overlayEnabled: boolean;
  muteEarlyMs: number;
}

/** call on every video "timeupdate" — skips past a cut segment (skip mode),
 *  or toggles the "cut" overlay + mute-just-before-a-cut (overlay/mute
 *  mode), depending on the widget's current cut-mode-control settings. */
export function applyCutPlaybackEffects(options: ApplyCutPlaybackEffectsOptions): void {
  const { video, overlayEl, editableSegments, cutSkipEnabled, cutMuteEnabled, overlayEnabled, muteEarlyMs } = options;

  if (cutSkipEnabled) {
    setCutOverlayActive(overlayEl, false);
    video.muted = false;
    if (video.paused || video.seeking) return;
    let seg = findContainingSegment(editableSegments, video.currentTime);
    let guard = 0;
    while (seg && guard < 10) {
      video.currentTime = Math.min(video.duration || seg[1], seg[1] + 0.01);
      seg = findContainingSegment(editableSegments, video.currentTime);
      guard++;
    }
    return;
  }

  const seg = findContainingSegment(editableSegments, video.currentTime);
  setCutOverlayActive(overlayEl, overlayEnabled && Boolean(seg));
  const upcomingSeg = findContainingSegment(editableSegments, video.currentTime + muteEarlyMs / 1000);
  video.muted = cutMuteEnabled && Boolean(upcomingSeg);
}

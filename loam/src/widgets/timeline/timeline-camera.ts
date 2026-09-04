/**
 * generic virtual pan/zoom "camera" for a time-based timeline — pure state
 * + math, zero pixi/DOM dependency, so it's trivially unit-testable and
 * shareable between `stfu` (video-timeline.ts) and animaniac's own
 * timeline, rather than each widget re-deriving the same view-window math.
 *
 * owns only the time <-> screen-px mapping, zoom level, and view-window
 * (viewStartTime/viewDuration) state — drawing (ruler ticks, scrollbar,
 * playhead, track rows) stays in each widget's own pixi code, which reads
 * this camera's current state via `getView()`/`timeToScreenX()`/
 * `screenXToTime()` after every mutating call.
 */

// zoom levels are "duration ÷ N seconds visible", matching editor.js's model.
export const DEFAULT_ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
export const DEFAULT_NICE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** smallest step in `steps` that is >= `target` — used to pick "nice"
 *  ruler tick spacing (falls back to the largest step if `target` exceeds
 *  every entry). */
export function niceStep(target: number, steps: readonly number[] = DEFAULT_NICE_STEPS): number {
  for (const s of steps) {
    if (s >= target) return s;
  }
  return steps[steps.length - 1];
}

export function formatTimelineTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2);
  return `${m}:${s.padStart(5, "0")}`;
}

export interface TimelineCameraView {
  duration: number;
  viewStartTime: number;
  viewDuration: number;
  pxPerSecond: number;
  zoomIndex: number;
  currentTime: number;
}

export interface TimelineCameraOptions {
  rowWidth: number;
  zoomLevels?: readonly number[];
  /** fires after any mutation that changes the view window (zoom, pan,
   *  resize, duration change) — callers redraw their own chrome/content
   *  here rather than polling. */
  onViewChange?: (view: TimelineCameraView) => void;
}

export interface TimelineCamera {
  getView(): TimelineCameraView;
  timeToScreenX(t: number): number;
  screenXToTime(x: number): number;
  /** current row width (screen px) the camera is mapping time onto. */
  getRowWidth(): number;
  setRowWidth(next: number): void;
  /** sets the total timeline duration. no-ops (does NOT recenter/re-zoom)
   *  if `next` equals the current duration — callers that recompute
   *  duration on every doc change, not just on a real source-length
   *  change, rely on this to avoid yanking the view on unrelated edits. */
  setDuration(next: number): void;
  setZoom(index: number, focusTime?: number): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomFit(): void;
  /** pan the view window directly by a time delta, clamped to
   *  `[0, duration - viewDuration]`. */
  panBy(deltaTime: number): void;
  /** pan the view window to an absolute start time, same clamping as `panBy`. */
  panTo(viewStartTime: number): void;
  /** move the playhead; does not by itself move the view window — pair
   *  with `scrollTimeIntoView()` for "follow the playhead" behavior. */
  setCurrentTime(t: number): void;
  /** recenter the view window on `t` if it's drifted more than `tolerance`
   *  (fraction of `viewDuration`, default 0.15) from the window's center —
   *  a no-op while zoomed out to fit the whole duration. */
  scrollTimeIntoView(t: number, tolerance?: number): void;
}

export function createTimelineCamera(options: TimelineCameraOptions): TimelineCamera {
  const zoomLevels = options.zoomLevels ?? DEFAULT_ZOOM_LEVELS;

  let rowWidth = Math.max(0, options.rowWidth);
  let duration = 0;
  let viewStartTime = 0;
  let viewDuration = 0;
  let pxPerSecond = 0;
  let zoomIndex = 0;
  let currentTime = 0;

  function clampViewStart(t: number): number {
    const maxStart = Math.max(0, duration - viewDuration);
    return Math.max(0, Math.min(maxStart, t));
  }

  function notify(): void {
    options.onViewChange?.(getView());
  }

  function getView(): TimelineCameraView {
    return { duration, viewStartTime, viewDuration, pxPerSecond, zoomIndex, currentTime };
  }

  function timeToScreenX(t: number): number {
    return (t - viewStartTime) * pxPerSecond;
  }

  function screenXToTime(x: number): number {
    return pxPerSecond > 0 ? viewStartTime + x / pxPerSecond : viewStartTime;
  }

  function recomputePxPerSecond(): void {
    pxPerSecond = viewDuration > 0 ? rowWidth / viewDuration : 0;
  }

  function setZoom(index: number, focusTime?: number): void {
    zoomIndex = Math.max(0, Math.min(zoomLevels.length - 1, index));
    viewDuration = duration > 0 ? duration / zoomLevels[zoomIndex] : 0;
    const focus = focusTime ?? currentTime;
    viewStartTime = clampViewStart(focus - viewDuration / 2);
    recomputePxPerSecond();
    notify();
  }

  return {
    getView,
    timeToScreenX,
    screenXToTime,
    getRowWidth() {
      return rowWidth;
    },
    setRowWidth(next: number) {
      rowWidth = Math.max(0, next);
      recomputePxPerSecond();
      notify();
    },
    setDuration(next: number) {
      const clamped = Math.max(0, next);
      if (clamped === duration) return;
      duration = clamped;
      setZoom(zoomIndex, currentTime);
    },
    setZoom,
    zoomIn() {
      setZoom(zoomIndex + 1);
    },
    zoomOut() {
      setZoom(zoomIndex - 1);
    },
    zoomFit() {
      setZoom(0);
    },
    panBy(deltaTime: number) {
      viewStartTime = clampViewStart(viewStartTime + deltaTime);
      notify();
    },
    panTo(nextViewStartTime: number) {
      viewStartTime = clampViewStart(nextViewStartTime);
      notify();
    },
    setCurrentTime(t: number) {
      currentTime = t;
    },
    scrollTimeIntoView(t: number, tolerance = 0.15) {
      if (duration <= 0 || viewDuration >= duration) return;
      const center = viewStartTime + viewDuration / 2;
      if (Math.abs(t - center) > viewDuration * tolerance) {
        viewStartTime = clampViewStart(t - viewDuration / 2);
        notify();
      }
    },
  };
}

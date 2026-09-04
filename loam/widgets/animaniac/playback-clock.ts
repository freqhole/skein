/**
 * animaniac's own play/pause/seek clock — unlike `stfu` (which piggybacks
 * on a host `<video>` element's own `timeupdate` event), animaniac has no
 * single host media element driving time (it may have zero, one, or many
 * simultaneous video/audio clips playing across multiple tracks), so it
 * needs its own clock. `requestAnimationFrame`-driven; the raf function is
 * injectable so this is unit-testable without a real browser frame loop.
 */

export interface PlaybackClockOptions {
  getDurationSec: () => number;
  /** fires on every tick while playing (and once immediately after `seek()`/
   *  `pause()`/`play()`) with the current time — this is what
   *  `compositor.ts`/`mouth-sync.ts` subscribe to. `seeked` is true only for
   *  a discrete jump (an explicit `seek()` call, or the very first tick
   *  after a fresh `play()`) as opposed to normal incremental frame-to-
   *  frame advancement — consumers driving a real `<audio>`/`<video>`
   *  element should only force a `currentTime` write when `seeked` is true
   *  (see audio-playback.ts's/compositor.ts's own comments on why: writing
   *  `currentTime` on every regular tick glitches audibly, especially on
   *  tauri's wkwebview). */
  onTick: (t: number, seeked: boolean) => void;
  /** fires whenever `isPlaying()` actually changes — both for an explicit
   *  `play()`/`pause()`/`togglePlay()` call AND for the clock stopping
   *  itself at the end of the timeline (see `tick()`'s own end-of-duration
   *  branch) — `onTick` alone doesn't cover that last case, so a play/pause
   *  button driven only by the click handler's own optimistic toggle goes
   *  stale once playback runs off the end on its own. */
  onPlayingChange?: (playing: boolean) => void;
  /** injectable for testing — defaults to the real `requestAnimationFrame`. */
  raf?: (cb: (now: number) => void) => number;
  cancelRaf?: (handle: number) => void;
  /** injectable clock, defaults to `performance.now`. */
  now?: () => number;
}

export interface PlaybackClock {
  play(): void;
  pause(): void;
  togglePlay(): void;
  isPlaying(): boolean;
  seek(t: number): void;
  getCurrentTime(): number;
  destroy(): void;
}

const defaultRaf = (cb: (now: number) => void): number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : (setTimeout(() => cb(Date.now()), 16) as unknown as number);
const defaultCancelRaf = (handle: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
};
const defaultNow = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function createPlaybackClock(options: PlaybackClockOptions): PlaybackClock {
  const { getDurationSec, onTick, onPlayingChange, raf = defaultRaf, cancelRaf = defaultCancelRaf, now = defaultNow } = options;

  let playing = false;
  let currentTime = 0;
  let lastFrameAt: number | null = null;
  let rafHandle: number | null = null;

  function clampToDuration(t: number): number {
    const duration = getDurationSec();
    return duration > 0 ? Math.max(0, Math.min(duration, t)) : Math.max(0, t);
  }

  function tick(): void {
    if (!playing) return;
    const nowMs = now();
    // no previous frame recorded means this is the first tick since a fresh
    // `play()` — treat it as a discrete jump too (the element may need an
    // initial sync to wherever the clock was left/seeked to).
    const isResume = lastFrameAt === null;
    const deltaSec = lastFrameAt === null ? 0 : (nowMs - lastFrameAt) / 1000;
    lastFrameAt = nowMs;
    const next = currentTime + deltaSec;
    const duration = getDurationSec();
    if (duration > 0 && next >= duration) {
      currentTime = duration;
      playing = false;
      onTick(currentTime, isResume);
      onPlayingChange?.(false);
      return; // stop at the end rather than looping — matches every other
      // media-driven timeline in this codebase (no auto-loop behavior)
    }
    currentTime = next;
    onTick(currentTime, isResume);
    rafHandle = raf(tick);
  }

  return {
    play() {
      if (playing) return;
      playing = true;
      lastFrameAt = null;
      rafHandle = raf(tick);
      onPlayingChange?.(true);
    },
    pause() {
      if (!playing) return;
      playing = false;
      if (rafHandle !== null) cancelRaf(rafHandle);
      rafHandle = null;
      onTick(currentTime, false);
      onPlayingChange?.(false);
    },
    togglePlay() {
      if (playing) this.pause();
      else this.play();
    },
    isPlaying() {
      return playing;
    },
    seek(t: number) {
      currentTime = clampToDuration(t);
      lastFrameAt = null;
      onTick(currentTime, true);
    },
    getCurrentTime() {
      return currentTime;
    },
    destroy() {
      playing = false;
      if (rafHandle !== null) cancelRaf(rafHandle);
      rafHandle = null;
    },
  };
}

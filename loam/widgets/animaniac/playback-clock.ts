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
   *  `compositor.ts`/`mouth-sync.ts` subscribe to. */
  onTick: (t: number) => void;
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
  const { getDurationSec, onTick, raf = defaultRaf, cancelRaf = defaultCancelRaf, now = defaultNow } = options;

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
    const deltaSec = lastFrameAt === null ? 0 : (nowMs - lastFrameAt) / 1000;
    lastFrameAt = nowMs;
    const next = currentTime + deltaSec;
    const duration = getDurationSec();
    if (duration > 0 && next >= duration) {
      currentTime = duration;
      playing = false;
      onTick(currentTime);
      return; // stop at the end rather than looping — matches every other
      // media-driven timeline in this codebase (no auto-loop behavior)
    }
    currentTime = next;
    onTick(currentTime);
    rafHandle = raf(tick);
  }

  return {
    play() {
      if (playing) return;
      playing = true;
      lastFrameAt = null;
      rafHandle = raf(tick);
    },
    pause() {
      if (!playing) return;
      playing = false;
      if (rafHandle !== null) cancelRaf(rafHandle);
      rafHandle = null;
      onTick(currentTime);
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
      onTick(currentTime);
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

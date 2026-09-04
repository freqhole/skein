import { describe, expect, it, vi } from "vitest";
import { createPlaybackClock } from "./playback-clock";

/** a controllable fake raf: `step(ms)` advances the fake clock and invokes
 *  whatever callback is currently pending, exactly once. */
function makeFakeScheduler(startMs = 0) {
  let nowMs = startMs;
  let pending: ((now: number) => void) | null = null;
  return {
    raf: (cb: (now: number) => void): number => {
      pending = cb;
      return 1;
    },
    cancelRaf: (): void => {
      pending = null;
    },
    now: (): number => nowMs,
    step(deltaMs: number): void {
      nowMs += deltaMs;
      const cb = pending;
      pending = null;
      cb?.(nowMs);
    },
    hasPending(): boolean {
      return pending !== null;
    },
  };
}

describe("createPlaybackClock", () => {
  it("starts paused at t=0", () => {
    const ticks: number[] = [];
    const clock = createPlaybackClock({ getDurationSec: () => 10, onTick: (t) => ticks.push(t) });
    expect(clock.isPlaying()).toBe(false);
    expect(clock.getCurrentTime()).toBe(0);
  });

  it("play() advances time on each simulated frame", () => {
    const sched = makeFakeScheduler();
    const ticks: number[] = [];
    const clock = createPlaybackClock({
      getDurationSec: () => 10,
      onTick: (t) => ticks.push(t),
      raf: sched.raf,
      cancelRaf: sched.cancelRaf,
      now: sched.now,
    });
    clock.play();
    expect(clock.isPlaying()).toBe(true);
    sched.step(100); // first frame establishes lastFrameAt, no elapsed delta yet... second frame advances
    sched.step(500); // 0.5s elapsed
    expect(clock.getCurrentTime()).toBeCloseTo(0.5, 5);
  });

  it("pause() stops advancing and cancels the pending frame", () => {
    const sched = makeFakeScheduler();
    const clock = createPlaybackClock({
      getDurationSec: () => 10,
      onTick: () => {},
      raf: sched.raf,
      cancelRaf: sched.cancelRaf,
      now: sched.now,
    });
    clock.play();
    sched.step(100);
    sched.step(500);
    const t = clock.getCurrentTime();
    clock.pause();
    expect(clock.isPlaying()).toBe(false);
    expect(sched.hasPending()).toBe(false);
    expect(clock.getCurrentTime()).toBe(t);
  });

  it("seek() clamps to [0, duration] and updates immediately without needing a frame", () => {
    const ticks: number[] = [];
    const clock = createPlaybackClock({ getDurationSec: () => 10, onTick: (t) => ticks.push(t) });
    clock.seek(5);
    expect(clock.getCurrentTime()).toBe(5);
    clock.seek(-3);
    expect(clock.getCurrentTime()).toBe(0);
    clock.seek(999);
    expect(clock.getCurrentTime()).toBe(10);
    expect(ticks).toEqual([5, 0, 10]);
  });

  it("stops (does not loop) once it reaches the duration", () => {
    const sched = makeFakeScheduler();
    const playingChanges: boolean[] = [];
    const clock = createPlaybackClock({
      getDurationSec: () => 1,
      onTick: () => {},
      onPlayingChange: (p) => playingChanges.push(p),
      raf: sched.raf,
      cancelRaf: sched.cancelRaf,
      now: sched.now,
    });
    clock.play();
    sched.step(0);
    sched.step(2000); // way past the 1s duration
    expect(clock.getCurrentTime()).toBe(1);
    expect(clock.isPlaying()).toBe(false);
    expect(sched.hasPending()).toBe(false);
    // onPlayingChange must fire (true) on play() and (false) once the
    // clock auto-stops itself at the end — not just on an explicit
    // pause()/togglePlay() call, so a UI button relying only on the click
    // handler's own optimistic toggle doesn't go stale.
    expect(playingChanges).toEqual([true, false]);
  });

  it("onPlayingChange fires on explicit play()/pause() too", () => {
    const sched = makeFakeScheduler();
    const playingChanges: boolean[] = [];
    const clock = createPlaybackClock({
      getDurationSec: () => 10,
      onTick: () => {},
      onPlayingChange: (p) => playingChanges.push(p),
      raf: sched.raf,
      cancelRaf: sched.cancelRaf,
      now: sched.now,
    });
    clock.play();
    clock.play(); // already playing — no duplicate notification
    clock.pause();
    clock.pause(); // already paused — no duplicate notification
    expect(playingChanges).toEqual([true, false]);
  });

  it("togglePlay() flips between play and pause", () => {
    const sched = makeFakeScheduler();
    const clock = createPlaybackClock({
      getDurationSec: () => 10,
      onTick: () => {},
      raf: sched.raf,
      cancelRaf: sched.cancelRaf,
      now: sched.now,
    });
    clock.togglePlay();
    expect(clock.isPlaying()).toBe(true);
    clock.togglePlay();
    expect(clock.isPlaying()).toBe(false);
  });

  it("destroy() cancels any pending frame", () => {
    const sched = makeFakeScheduler();
    const clock = createPlaybackClock({
      getDurationSec: () => 10,
      onTick: () => {},
      raf: sched.raf,
      cancelRaf: sched.cancelRaf,
      now: sched.now,
    });
    clock.play();
    clock.destroy();
    expect(sched.hasPending()).toBe(false);
    expect(clock.isPlaying()).toBe(false);
  });

  it("falls back to real requestAnimationFrame/performance.now when not injected", () => {
    let calls = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: (n: number) => void) => {
      calls++;
      if (calls === 1) cb(0); // simulate exactly one real frame firing, not an infinite synchronous loop
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const clock = createPlaybackClock({ getDurationSec: () => 10, onTick: () => {} });
    expect(() => clock.play()).not.toThrow();
    clock.destroy();
    vi.unstubAllGlobals();
  });
});

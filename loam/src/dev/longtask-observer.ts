// ---------------------------------------------------------------------------
// global main-thread stall diagnostic — logs every task the browser's own
// PerformanceObserver reports as blocking the main thread for >50ms,
// regardless of which code caused it (including vendored/automerge-repo
// internals, pixi rendering, or anything else our own named timing logs in
// widget-doc.ts/doc-history-stats.ts don't cover). this can't say WHICH
// function ran, only WHEN and for how long — enough to correlate against
// other log lines' own timestamps to explain a gap nothing else does (see
// the animaniac canvas-freeze investigation this was added for).
//
// opt-in only — gated by the caller (`boot.ts`) behind
// `localStorage.skein.debugLongTask`, since this webview target is already
// confirmed to support neither `longtask` nor `long-animation-frame` (see
// the no-op warning below), so installing it unconditionally would just be
// extra code running for no benefit here — other targets (non-WKWebView
// tauri builds, plain browser) may still support one of these.
// ---------------------------------------------------------------------------

/** safe to call more than once — a second call is a no-op (browsers don't
 *  let two PerformanceObservers double-report the same entries, but this
 *  guards against wiring it into more than one boot path anyway). */
let installed = false;

export function installLongTaskObserver(): void {
  if (installed) return;
  installed = true;
  if (typeof PerformanceObserver === "undefined") return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];

  // chromium (including tauri's webview on most platforms) — a "longtask"
  // entry per task that blocked the main thread for 50ms+.
  if (supported.includes("longtask")) {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          console.warn(`[longtask] main thread blocked ${entry.duration.toFixed(1)}ms, started at ${entry.startTime.toFixed(1)}ms (name: ${entry.name})`);
        }
      }).observe({ type: "longtask", buffered: true });
    } catch (err) {
      console.warn("[longtask] failed to install longtask observer:", err);
    }
  }

  // safari/webkit doesn't support "longtask" but recent versions support
  // the newer "long animation frame" API instead — register whichever is
  // available rather than assuming one or the other.
  if (supported.includes("long-animation-frame")) {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          console.warn(`[longtask] long animation frame: ${entry.duration.toFixed(1)}ms, started at ${entry.startTime.toFixed(1)}ms`);
        }
      }).observe({ type: "long-animation-frame", buffered: true });
    } catch (err) {
      console.warn("[longtask] failed to install long-animation-frame observer:", err);
    }
  }

  if (!supported.includes("longtask") && !supported.includes("long-animation-frame")) {
    console.warn("[longtask] neither 'longtask' nor 'long-animation-frame' entry types are supported in this environment — no-op");
  }
}

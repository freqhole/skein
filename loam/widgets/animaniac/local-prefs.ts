/**
 * animaniac's small localStorage-only prefs — never part of the automerge
 * doc (don't affect exported/rendered output, only how this browser
 * instance previews the widget locally) — mirrors `stfu/local-prefs.ts`.
 */

export interface LocalAnimaniacPrefs {
  /** show the "?" keyboard-shortcuts panel affordance state, snap-to-edges
   *  toggle, etc. — starts minimal, grows as the timeline UI lands. */
  snapEnabled: boolean;
  autoScrollEnabled: boolean;
  /** compositor preview area height, in px — user-resizable via the
   *  splitter handle between the preview and the timeline (mirrors
   *  stfu's `segmentsPanelHeight`). */
  previewHeightPx: number;
}

const DEFAULT_PREFS: LocalAnimaniacPrefs = { snapEnabled: true, autoScrollEnabled: false, previewHeightPx: 160 };

function prefsKey(widgetId: string): string {
  return `skein.animaniac.${widgetId}.prefs`;
}

export function loadLocalAnimaniacPrefs(widgetId: string): LocalAnimaniacPrefs {
  try {
    const raw = localStorage.getItem(prefsKey(widgetId));
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      snapEnabled: parsed.snapEnabled === undefined ? DEFAULT_PREFS.snapEnabled : Boolean(parsed.snapEnabled),
      autoScrollEnabled:
        parsed.autoScrollEnabled === undefined ? DEFAULT_PREFS.autoScrollEnabled : Boolean(parsed.autoScrollEnabled),
      previewHeightPx:
        typeof parsed.previewHeightPx === "number" && Number.isFinite(parsed.previewHeightPx)
          ? parsed.previewHeightPx
          : DEFAULT_PREFS.previewHeightPx,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveLocalAnimaniacPrefs(widgetId: string, prefs: LocalAnimaniacPrefs): void {
  try {
    localStorage.setItem(prefsKey(widgetId), JSON.stringify(prefs));
  } catch {
    // private browsing / storage disabled / quota exceeded — not fatal, prefs just don't persist
  }
}

// -- "snatch" auto-sync opt-in — separate key from the JSON blob above so
// it can be set/read independently of the rest of prefs (mirrors
// stfu/local-prefs.ts's own identical mechanism: once a peer has done one
// successful manual/automatic snatch for this widget, every later blob it
// needs is fetched silently from then on, no repeat manual action). ------

function autoSnatchEnabledKey(widgetId: string): string {
  return `skein.animaniac.${widgetId}.autoSnatchEnabled`;
}

export function loadAutoSnatchEnabled(widgetId: string): boolean {
  try {
    return localStorage.getItem(autoSnatchEnabledKey(widgetId)) === "1";
  } catch {
    return false;
  }
}

export function saveAutoSnatchEnabled(widgetId: string): void {
  try {
    localStorage.setItem(autoSnatchEnabledKey(widgetId), "1");
  } catch {
    // not fatal — just means this peer re-asks (auto-retries anyway) next session
  }
}

// -- DOM video overlay feature flag — global (not per-widget), since it's
// an internal/dev-facing switch rather than a real user preference. when
// on (the default), video-segment clips render as real HTML `<video>`
// elements positioned over the preview area (see `dom-video-overlay.ts`)
// instead of pixi's own `VideoSource`/`Texture.from(video)` GPU path,
// which hits a still-open upstream pixi.js bug ("WebGL: INVALID_VALUE:
// Offset overflows texture dimensions") and generally poor decode quality
// on some platforms. flip to "0" (e.g. via devtools:
// `localStorage.setItem("skein.animaniac.domVideoOverlay", "0")`) to fall
// back to the old in-canvas pixi rendering without a rebuild — kept
// around deliberately so that work can be picked back up later rather
// than ripped out. ---------------------------------------------------------

const DOM_VIDEO_OVERLAY_KEY = "skein.animaniac.domVideoOverlay";

export function isDomVideoOverlayEnabled(): boolean {
  try {
    return localStorage.getItem(DOM_VIDEO_OVERLAY_KEY) !== "0";
  } catch {
    return true;
  }
}

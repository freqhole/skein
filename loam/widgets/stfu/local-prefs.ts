/**
 * stfu's small localStorage-only prefs — never part of the automerge doc
 * (these don't affect the exported/rendered output, only how this browser
 * instance previews/lays out the widget locally — mirrors trek-minus-paris's
 * localStorage-vs-manifest split, see docs/stfu-widget-plan.md).
 */

export interface LocalCutPrefs {
  /** show the red "cut" overlay while the playhead is inside a cut segment */
  overlayEnabled: boolean;
  /** mute this many ms before entering a cut segment, to hide pre-roll audio bleed */
  muteEarlyMs: number;
}

function cutPlaybackPrefsKey(widgetId: string): string {
  return `skein.stfu.${widgetId}.cutPlaybackPrefs`;
}

export function loadLocalCutPrefs(widgetId: string): LocalCutPrefs {
  try {
    const raw = localStorage.getItem(cutPlaybackPrefsKey(widgetId));
    if (!raw) return { overlayEnabled: true, muteEarlyMs: 150 };
    const parsed = JSON.parse(raw);
    return {
      overlayEnabled: parsed.overlayEnabled === undefined ? true : Boolean(parsed.overlayEnabled),
      muteEarlyMs: typeof parsed.muteEarlyMs === "number" ? parsed.muteEarlyMs : 150,
    };
  } catch {
    return { overlayEnabled: true, muteEarlyMs: 150 };
  }
}

export function saveLocalCutPrefs(widgetId: string, prefs: LocalCutPrefs): void {
  try {
    localStorage.setItem(cutPlaybackPrefsKey(widgetId), JSON.stringify(prefs));
  } catch {
    // private browsing / storage disabled / quota exceeded — not fatal, prefs just don't persist
  }
}

export const SEGMENTS_PANEL_MIN_HEIGHT = 80;
export const SEGMENTS_PANEL_MAX_HEIGHT = 480;

export function clampSegmentsPanelHeight(h: number): number {
  return Math.max(SEGMENTS_PANEL_MIN_HEIGHT, Math.min(SEGMENTS_PANEL_MAX_HEIGHT, Math.round(h)));
}

function segmentsPanelHeightKey(widgetId: string): string {
  return `skein.stfu.${widgetId}.segmentsPanelHeight`;
}

export function loadSegmentsPanelHeight(widgetId: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(segmentsPanelHeightKey(widgetId));
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return clampSegmentsPanelHeight(n);
  } catch {
    // private browsing / storage disabled — fall back to the default below
  }
  return fallback;
}

export function saveSegmentsPanelHeight(widgetId: string, height: number): void {
  try {
    localStorage.setItem(segmentsPanelHeightKey(widgetId), String(height));
  } catch {
    // not fatal, just doesn't persist
  }
}

/** persisted per-widget opt-in flag — set once a peer has explicitly done a
 *  full manual "snatch all" (see snatch-controller.ts). */
function autoSnatchEnabledKey(widgetId: string): string {
  return `skein.stfu.${widgetId}.autoSnatchEnabled`;
}

export function loadAutoSnatchEnabled(widgetId: string): boolean {
  return localStorage.getItem(autoSnatchEnabledKey(widgetId)) === "1";
}

export function saveAutoSnatchEnabled(widgetId: string): void {
  localStorage.setItem(autoSnatchEnabledKey(widgetId), "1");
}

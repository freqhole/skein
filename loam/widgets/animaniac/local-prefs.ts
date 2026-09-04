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

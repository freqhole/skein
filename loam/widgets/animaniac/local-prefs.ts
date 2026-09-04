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

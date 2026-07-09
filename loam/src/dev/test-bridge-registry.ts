// test bridge registry — the single place that knows the shape of
// `window.__skeinTest` and owns the DEV guard.
//
// see docs/skein-runtime-plan.md § "test hooks in production code — the
// problem and the plan" (the "interim approach" section) for the full
// background. short version: production modules (boot.ts, profile-tab.ts)
// used to poke `window.__skeinTest` directly, which meant:
//   - the full shape of the test bridge was scattered across files
//   - a widget implementation (profile-tab.ts) had test-only code in it
//   - renaming/restructuring the bridge meant hunting down every assignment
//
// this file doesn't fully solve that (there are still two call sites —
// boot.ts and profile-tab.ts — because `SkeinHarness` doesn't own the
// social doc / identity yet, so `socialStore` is deliberately out of scope
// for the harness). once boot.ts is migrated to construct its social bridge
// from a harness, this can collapse to a single `registerTestBridge(harness)`
// call.
//
// for now: this is the *only* file that reads/writes `window.__skeinTest`.
// every other module calls `registerSocialBridge()` instead.

import type { SkeinTestBridgeSocial } from "./test-bridge";

/**
 * merge partial fields into `window.__skeinTest.social`, creating the
 * object if it doesn't exist yet. no-ops outside DEV builds — completely
 * absent from production bundles via dead-code elimination on
 * `import.meta.env.DEV`.
 *
 * safe to call multiple times from different modules (boot.ts creates the
 * bulk of the shape; profile-tab.ts adds `pickAvatar` once it mounts) —
 * each call only ever adds to the existing object, never replaces it.
 */
export function registerSocialBridge(partial: Partial<SkeinTestBridgeSocial>): void {
  if (!import.meta.env.DEV) return;

  const bridge: Record<string, unknown> = ((window as any).__skeinTest ??= {});
  const social = (bridge.social as Record<string, unknown>) ?? {};
  // use defineProperties (not Object.assign) so accessor properties (e.g. a
  // live `get doc()`) are copied as live getters, not snapshotted to a
  // one-time value. force `configurable: true` regardless of what the
  // caller passed in — this registry is re-invoked every time a canvas is
  // (re-)mounted (e.g. navigating back to the narthex), reusing the same
  // `social` object each time, so every property must stay redefinable.
  // without this, a non-configurable descriptor (the default when a caller
  // uses `Object.defineProperty` without specifying `configurable`) throws
  // "Cannot redefine property" on the second registration.
  const descriptors = Object.getOwnPropertyDescriptors(partial);
  for (const key of Object.keys(descriptors)) {
    descriptors[key].configurable = true;
  }
  Object.defineProperties(social, descriptors);
  bridge.social = social;
}

/**
 * register test hooks for one instance of a real, palette-placeable
 * `WidgetFactory` widget, keyed by its widget id — for widgets that don't
 * go through the social overlay's single hand-mounted-tab pattern (which
 * uses `registerSocialBridge()` above) and where more than one instance can
 * exist at once (e.g. several `friend-canvas-bin` widgets pinned to
 * different friends on the same narthex).
 *
 * no-op outside DEV builds, same guard as `registerSocialBridge()`.
 */
export function registerWidgetBridge(widgetId: string, hooks: unknown): void {
  if (!import.meta.env.DEV) return;
  const bridge: Record<string, unknown> = ((window as any).__skeinTest ??= {});
  const widgets = (bridge.widgets as Record<string, unknown>) ?? {};
  widgets[widgetId] = hooks;
  bridge.widgets = widgets;
}

/** remove a widget's test hooks (call on widget destroy) so stale hooks
 *  pointing at a torn-down widget instance can't be mistaken for a live one. */
export function unregisterWidgetBridge(widgetId: string): void {
  if (!import.meta.env.DEV) return;
  const bridge = (window as any).__skeinTest as Record<string, unknown> | undefined;
  const widgets = bridge?.widgets as Record<string, unknown> | undefined;
  if (widgets) delete widgets[widgetId];
}

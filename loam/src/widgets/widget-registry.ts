// `WidgetRegistry` now lives in `widget-types.ts` (needs `WidgetFactory`,
// defined there — keeping them in separate files created a two-file
// circular import once anything else needed `WidgetRegistry`'s type from
// `widget-types.ts` itself). re-exported here so existing imports of
// `./widget-registry` across the codebase don't need to change.
export { WidgetRegistry } from "./widget-types";


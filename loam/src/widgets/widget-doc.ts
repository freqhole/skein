import type { DocHandle } from "@automerge/automerge-repo";
import { z } from "zod";
import { next as A } from "@automerge/automerge/slim";
import { deepUnwrapAmStrings } from "../canvas/automerge-values";
import type { WidgetDoc } from "./widget-types";

/** `parseDoc()` calls slower than this get an unconditional `console.warn`
 *  (not gated behind `localStorage.logLevel`) — a slow parse triggered by
 *  a "change" event is a live, main-thread-blocking cost paid by every
 *  peer subscribed to this doc on every change (local OR remote),
 *  independent of the doc's own automerge op-log/history size, and it's
 *  exactly the kind of thing that needs to be visible the moment it
 *  happens rather than requiring a dev to know to enable debug logging
 *  first. temporary diagnostic, added while investigating the animaniac
 *  canvas-freeze bug (see repo memory notes) — safe to leave in
 *  permanently as a low-noise tripwire once that's resolved. */
const SLOW_PARSE_THRESHOLD_MS = 10;

/**
 * create a zod-validated facade over an automerge DocHandle.
 * this is the internal function used by the canvas to create
 * per-widget document wrappers. widgets never call this directly.
 *
 * the facade:
 * - validates all reads through the zod schema (security boundary)
 * - falls back to schema defaults if validation fails (graceful degradation)
 * - exposes change() for mutations and on("change") for subscriptions
 * - never exposes the underlying DocHandle to widget code
 *
 * `migrate`, if given, is a one-time repair pass for known-legacy document
 * shapes (e.g. a field renamed since the document was created) — it's only
 * invoked when the initial parse fails, and writes directly into the raw
 * automerge doc via `handle.change()` so the fix is permanent and syncs to
 * every peer, rather than being re-applied on every read.
 */
export function createWidgetDoc<S extends z.ZodType>(
  schema: S,
  handle: DocHandle<any>,
  migrate?: (raw: any) => void
): WidgetDoc<S> {
  type State = z.infer<S>;

  let cachedState: State | null = null;

  /** `reason` identifies WHICH call site triggered this parse — logged
   *  alongside a slow-parse warning so two back-to-back log lines (one
   *  "change-listener", one immediately followed by "lazy-getter") make
   *  visible a real, separate inefficiency: `on("change", ...)`'s own
   *  wrapper computes a full parseDoc() whose result it discards for any
   *  caller (like animaniac's) that ignores the handler argument, and the
   *  very next `.current` read inside that handler triggers a SECOND,
   *  independent full parse because the wrapper never repopulates
   *  `cachedState`. */
  function parseDoc(reason: "lazy-getter" | "change-listener" = "lazy-getter"): State {
    const rawDoc = handle.doc();
    const unwrapStart = performance.now();
    // a widget doc a rust peer (tumulus's hub) has ever written into
    // directly comes back with any string-typed field as an
    // `ImmutableString` instance rather than a plain js string (see
    // automerge-values.ts's `deepUnwrapAmStrings` doc comment) — coerce the
    // whole doc up front so zod's `z.string()`/`z.array(z.string())`
    // checks see plain strings regardless of who wrote them.
    const raw = rawDoc ? deepUnwrapAmStrings(rawDoc) : rawDoc;
    const unwrapMs = performance.now() - unwrapStart;

    const parseStart = performance.now();
    let result: State;
    try {
      result = schema.parse(raw ?? {});
    } catch (err) {
      if (migrate) {
        try {
          handle.change(migrate);
          const migrated = handle.doc();
          result = schema.parse(migrated ? deepUnwrapAmStrings(migrated) : {});
          logSlowParse(reason, unwrapMs, performance.now() - parseStart);
          return result;
        } catch {
          // migration didn't fix it — fall through to the default fallback below.
        }
      }
      // graceful degradation: if peer data is corrupt, use defaults.
      // log the error so schema mismatches are visible during development.
      console.warn(
        "[widget-doc] schema parse failed — falling back to defaults. error:",
        err instanceof z.ZodError ? err.issues : err,
        "raw keys:",
        raw ? Object.keys(raw) : "null"
      );

      return schema.parse({});
    }
    logSlowParse(reason, unwrapMs, performance.now() - parseStart);
    return result;
  }

  function logSlowParse(reason: "lazy-getter" | "change-listener", unwrapMs: number, zodParseMs: number): void {
    const totalMs = unwrapMs + zodParseMs;
    if (totalMs <= SLOW_PARSE_THRESHOLD_MS) return;
    // cheap (no full doc serialize) — only computed on the already-rare
    // slow path, to correlate a slow parse against this doc's overall
    // op-log size without adding per-event cost to the common fast case.
    let statsSuffix = "";
    try {
      const doc = handle.doc();
      if (doc) {
        const stats = A.stats(doc);
        statsSuffix = `, docNumChanges=${stats.numChanges}, docNumOps=${stats.numOps}`;
      }
    } catch {
      // best-effort — never let the diagnostic itself throw
    }
    console.warn(
      `[widget-doc] slow parseDoc (${reason}) for ${handle.documentId}: ` +
        `deepUnwrapAmStrings=${unwrapMs.toFixed(1)}ms, zodParse=${zodParseMs.toFixed(1)}ms, total=${totalMs.toFixed(1)}ms${statsSuffix}`
    );
  }

  return {
    get current(): State {
      if (cachedState === null) {
        cachedState = parseDoc("lazy-getter");
      }
      return cachedState;
    },

    change(fn: (draft: State) => void): void {
      handle.change(fn);
      cachedState = null; // invalidate cache
    },

    on(_event: "change", handler: (state: State) => void): () => void {
      const listener = () => {
        cachedState = null; // invalidate cache
        const state = parseDoc("change-listener");
        handler(state);
      };
      handle.on("change", listener);
      return () => {
        handle.off("change", listener);
      };
    },
  };
}


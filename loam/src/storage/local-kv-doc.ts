// ---------------------------------------------------------------------------
// generic single-device, JSON-blob-backed "doc" — same { current, change(),
// on() } shape widget code already expects from an automerge WidgetDoc/
// SocialDoc, but persisted as one JSON value in the shared skein-meta
// IndexedDB store (meta-db.ts) instead of an automerge CRDT.
//
// intended for state that is genuinely never synced to any peer (see
// canvas-scoped-share-policy.ts's rule 3: no `.acl`, no `ownerCanvasId` —
// social/messagez/canvas-bin all qualify). automerge's CRDT machinery
// (conflict-free merge across writers) buys nothing for data only one
// device ever reads or writes, and its op-log grows forever even when the
// current state stays tiny — see docs/lingering-fixes-2026-08-plan.md's
// boot-stall investigation for the concrete case that motivated this.
// ---------------------------------------------------------------------------

import { getMetaValue, setMetaValue } from "./meta-db";
import { log } from "@freqhole/reliquary/utils";

const TAG = "local-kv-doc";

/**
 * the minimal surface messagez doc call sites actually use (boot.ts,
 * friendz-wiring.ts) — satisfied structurally by both an automerge
 * `DocHandle<any>` (pre-migration fallback) and a `LocalKvDoc<MessagezState>`
 * (post-migration fast path), so callers don't need to know which backend
 * is live. `on`/`off` return types are deliberately loose (`void`, not an
 * unsub closure) since `DocHandle.on()` returns `this` for chaining, not an
 * unsubscribe function — every real call site uses `on()` + a separate
 * `off()` call, never `on()`'s return value.
 */
export interface MessagezDocLike {
  doc(): any;
  isReady(): boolean;
  change(fn: (draft: any) => void): void;
  on(event: "change", handler: (...args: any[]) => void): void;
  off(event: "change", handler: (...args: any[]) => void): void;
}

export interface LocalKvDoc<T> {
  readonly current: T;
  /** alias for `current` — matches automerge `DocHandle.doc()` call sites. */
  doc(): T;
  /** always true — a LocalKvDoc is fully loaded before it's ever handed out. */
  isReady(): boolean;
  change(fn: (draft: T) => void): void;
  on(event: "change", handler: (state: T) => void): () => void;
  off(event: "change", handler: (state: T) => void): void;
}

/**
 * load (or initialize) a `LocalKvDoc<T>` persisted under `key` in the
 * skein-meta IndexedDB store.
 */
export async function createLocalKvDoc<T>(key: string, makeEmpty: () => T): Promise<LocalKvDoc<T>> {
  const raw = await getMetaValue(key);
  let state: T = raw ? (JSON.parse(raw) as T) : makeEmpty();
  const listeners = new Set<(state: T) => void>();

  function notify(): void {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (err) {
        log.warn(TAG, "listener error:", err);
      }
    }
  }

  return {
    get current(): T {
      return state;
    },
    doc(): T {
      return state;
    },
    isReady(): boolean {
      return true;
    },
    change(fn: (draft: T) => void): void {
      const draft = structuredClone(state);
      fn(draft);
      state = draft;
      notify();
      setMetaValue(key, JSON.stringify(state)).catch((err) => {
        log.warn(TAG, `persist failed for key ${key}:`, err);
      });
    },
    on(_event: "change", handler: (state: T) => void): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    off(_event: "change", handler: (state: T) => void): void {
      listeners.delete(handler);
    },
  };
}

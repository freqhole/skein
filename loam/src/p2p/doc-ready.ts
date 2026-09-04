// ---------------------------------------------------------------------------
// event-driven document resolution — replaces repeatedly calling
// automerge-repo's own `DocHandle.whenReady()` (a bounded, timeout-then-
// throw promise) with a persistent listener that reacts whenever a handle
// actually becomes ready, however long that takes.
//
// a `repo.find(docId)` for an already-known doc id returns the *same*
// cached `DocHandle` every time — it doesn't re-issue a network request.
// that handle stays alive for the life of the `Repo`, and its own sync
// machinery keeps listening for peers independent of whether anything is
// currently awaiting it, so a doc that's "unavailable" right now can still
// flip to "ready" in the background at any point later. the old pattern of
// repeatedly calling `whenReady()` (each call spinning up its own ~60-120s
// timeout, logging to the console on every failure) treated that as a
// one-off bounded wait to retry from scratch on every reconciliation pass.
// this module treats it as what it actually is: a durable subscription to
// a long-lived handle.
//
// two entry points:
// - `watchDocReady()` — the core primitive. calls back whenever the doc
//   becomes ready, no timeout by default, and never throws or logs on
//   failure to become ready — appropriate for long-lived background
//   watchers that should just keep waiting.
// - `resolveDocReady()` — a promise-based convenience wrapper for one-shot
//   callers that need a bounded wait (an explicit `timeoutMs` and/or
//   `signal`) around a single action, matching the shape of the code
//   `whenReady()` used to sit in.
// ---------------------------------------------------------------------------

import type { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";

const DEFAULT_ALLOWABLE_STATES = ["ready", "unavailable", "requesting", "loading"] as const;

/**
 * calls `onReady(handle)` once the document is ready — immediately (on a
 * microtask) if it already is, or the first time it becomes so. returns an
 * unsubscribe function that can be called at any time (before or after
 * `onReady` has fired) to stop listening; safe to call more than once.
 *
 * with no `opts.signal`, this waits indefinitely — appropriate for a
 * long-lived background watcher. pass `opts.signal` (e.g. from an
 * `AbortController` tied to a timeout, or to widget/component teardown) to
 * give up after some condition; `onReady` is simply never called in that
 * case, with no error reported.
 *
 * never throws and never logs — a doc id that turns out to be invalid, or
 * a `repo.find()` that rejects for any reason, is treated the same as
 * "not ready yet, still waiting" (i.e. it just never calls back), since
 * callers of this function have no timeout to react to in the first place.
 */
export function watchDocReady<T>(
  repo: Repo,
  docId: DocumentId,
  onReady: (handle: DocHandle<T>) => void,
  opts?: { signal?: AbortSignal }
): () => void {
  let cancelled = false;
  let handle: DocHandle<T> | undefined;
  let changeListener: (() => void) | undefined;
  let onAbort: (() => void) | undefined;

  const cleanup = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (handle && changeListener) {
      handle.off("change", changeListener);
    }
    if (opts?.signal && onAbort) {
      opts.signal.removeEventListener("abort", onAbort);
    }
  };

  if (opts?.signal?.aborted) {
    cancelled = true;
    return cleanup;
  }
  if (opts?.signal) {
    onAbort = cleanup;
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  void (async () => {
    let found: DocHandle<T>;
    try {
      found = await repo.find<T>(docId, { allowableStates: [...DEFAULT_ALLOWABLE_STATES] });
    } catch {
      return;
    }
    if (cancelled) return;
    handle = found;

    if (handle.isReady()) {
      onReady(handle);
      return;
    }

    changeListener = () => {
      if (cancelled || !handle) return;
      // DocHandle emits "change" synchronously just before it internally
      // marks itself ready (automerge-repo's #checkForChanges sends its
      // DOC_READY transition immediately after the "change" emit
      // returns) — deferring to a microtask lets that transition finish
      // first, so isReady() reflects it by the time we check.
      queueMicrotask(() => {
        if (cancelled || !handle) return;
        if (handle.isReady()) {
          cleanup();
          onReady(handle);
        }
      });
    };
    handle.on("change", changeListener);
  })();

  return cleanup;
}

/**
 * promise-based convenience wrapper around `watchDocReady()` for one-shot
 * callers — resolves with the ready handle, or `null` if `opts.signal`
 * fires (directly, or via `opts.timeoutMs`'s internal timer) before that
 * happens. never throws.
 */
export function resolveDocReady<T>(
  repo: Repo,
  docId: DocumentId,
  opts?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<DocHandle<T> | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const finish = (result: DocHandle<T> | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    if (opts?.signal?.aborted) {
      finish(null);
      return;
    }
    if (opts?.timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    }
    opts?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    controller.signal.addEventListener("abort", () => finish(null), { once: true });

    watchDocReady<T>(repo, docId, (handle) => finish(handle), { signal: controller.signal });
  });
}

// ---------------------------------------------------------------------------
// negative-result cache — for background reconciliation passes that resolve
// the same handful of docs repeatedly (e.g. on every narthex load). a doc
// that's genuinely unreachable (its owning peer is offline, or a
// sync-eligibility rule permanently denies it — see
// canvas-scoped-share-policy.ts) never becomes ready, so without this,
// every pass would pay `opts.timeoutMs`'s full bounded wait again, one doc
// at a time. once a doc id fails to resolve, `resolveDocReadyCached()`
// skips it entirely for a cooldown window instead of re-attempting the
// wait on every subsequent pass.
//
// this cache only applies to the bounded, promise-based `resolveDocReady()`
// path — long-lived `watchDocReady()` subscriptions don't need it, since
// they only ever attach one listener per doc for as long as they're
// mounted, and react instantly whenever the doc actually becomes ready.
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN_MS = 2 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const recentFailures = new Map<string, number>();

/** true if `docId` failed to resolve within the last `cooldownMs`. */
export function isRecentlyUnavailable(docId: string, cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
  const failedAt = recentFailures.get(docId);
  return failedAt !== undefined && Date.now() - failedAt < cooldownMs;
}

/** clears a cached failure — call once a doc id is confirmed resolvable again. */
export function markResolved(docId: string): void {
  recentFailures.delete(docId);
}

/** records that `docId` just failed to resolve, starting a fresh cooldown. */
export function markUnavailable(docId: string): void {
  recentFailures.set(docId, Date.now());
}

/**
 * `resolveDocReady()`, short-circuited to `null` entirely (no wait at all)
 * if this doc id failed to resolve within the last `opts.cooldownMs`
 * (default 2 minutes), and bounded to `opts.timeoutMs` (default 15s, not
 * automerge-repo's own ~60-120s default) otherwise. records a fresh
 * success/failure against the cache on every real attempt.
 *
 * unlike `watchDocReady()` (deliberately silent — see its own doc comment,
 * it powers many long-lived background watchers where per-call logging
 * would spam the console), this bounded one-shot wrapper DOES log —
 * timeouts here are rarer, caller-initiated, and exactly the kind of thing
 * worth being able to trace (e.g. "why did my profile doc never load").
 *
 * pass `opts.context` (a short human-readable label for THIS call site,
 * e.g. "ProfileStore.open" or "friendz-wiring: narthex metadata sync") so
 * the log line identifies which caller a given docId belongs to — this
 * module has ~10 call sites across the app, all resolving different docs
 * for different reasons, and the docId alone doesn't say which is which.
 */
export async function resolveDocReadyCached<T>(
  repo: Repo,
  docId: DocumentId,
  opts?: { timeoutMs?: number; cooldownMs?: number; signal?: AbortSignal; context?: string }
): Promise<DocHandle<T> | null> {
  const label = opts?.context ? `resolveDocReadyCached(${docId}) [${opts.context}]` : `resolveDocReadyCached(${docId})`;
  if (isRecentlyUnavailable(docId, opts?.cooldownMs)) {
    log.debug("doc-ready", `${label}: skipped, still in failure cooldown`);
    return null;
  }

  const startedAt = Date.now();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const handle = await resolveDocReady<T>(repo, docId, {
    timeoutMs,
    signal: opts?.signal,
  });
  const elapsedMs = Date.now() - startedAt;
  if (handle) {
    markResolved(docId);
    log.debug("doc-ready", `${label}: ready after ${elapsedMs}ms, state=${handle.state}`);
  } else {
    markUnavailable(docId);
    // NOTE: automerge-repo's NetworkSubsystem has no synchronous "current
    // peer count" getter (only `"peer"`/`"peer-disconnected"` events) — a
    // previous version of this log guessed at a `networkSubsystem.peers`
    // property that doesn't exist, always printing "unknown". this module
    // has no access to the app's own peer-tracking (`IrohNetworkAdapter`'s
    // `getConnectionSummary()`, wired up in boot.ts) — callers that have
    // it (boot.ts does) should log their own connection summary alongside
    // a failure here instead of this module guessing.
    log.warn(
      "doc-ready",
      `${label}: did NOT become ready after ${elapsedMs}ms (timeoutMs=${timeoutMs}) — either no reachable peer currently holds this doc, or none have connected yet`
    );
  }
  return handle;
}

/** test-only: clears all cached failures so tests don't leak state into each other. */
export function _clearDocReadyCacheForTests(): void {
  recentFailures.clear();
}

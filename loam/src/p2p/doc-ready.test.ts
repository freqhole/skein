import { describe, it, expect, vi, beforeEach } from "vitest";
import { next as A } from "@automerge/automerge/slim";
import { createTestRepo, waitFor } from "../test-helpers/automerge-helpers";
import {
  watchDocReady,
  resolveDocReady,
  resolveDocReadyCached,
  isRecentlyUnavailable,
  markResolved,
  markUnavailable,
  _clearDocReadyCacheForTests,
} from "./doc-ready";

// automerge-repo's DocHandle.update() assigns whatever the callback returns
// directly as the new doc state — it does not run automerge's own diffing
// for you. to genuinely simulate "a peer delivered real content" (and make
// DocHandle.#checkForChanges detect a real change, emit "change", and drive
// the handle's own not-ready -> ready transition), the callback must return
// a proper new automerge doc produced via A.change(), not a plain mutation
// of the existing (frozen) doc.
function simulatePeerDelivering<T extends Record<string, unknown>>(
  handle: { update: (cb: (doc: T) => T) => void },
  mutate: (doc: T) => void
): void {
  handle.update((doc) => A.change(doc, mutate));
}

describe("watchDocReady", () => {
  it("calls onReady immediately (async) for an already-ready doc", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ title: string }>({ title: "hello" });
    await handle.whenReady();

    const received: unknown[] = [];
    const unsub = watchDocReady<{ title: string }>(repo, handle.documentId, (h) => {
      received.push(h.doc());
    });

    await waitFor(() => received.length > 0);
    expect(received).toEqual([{ title: "hello" }]);
    unsub();
  });

  it("recovers once a doc that started unreachable later receives real content", async () => {
    // mint a structurally valid document id from an unrelated repo, then
    // resolve it against a completely disconnected repo — settles into a
    // non-ready state (typically "unavailable") almost immediately, same
    // as a genuinely offline peer's doc would in production.
    const otherRepo = createTestRepo();
    const otherHandle = otherRepo.create<{ title: string }>({ title: "seed" });
    await otherHandle.whenReady();

    const repo = createTestRepo();
    const handle = await repo.find<{ title: string }>(otherHandle.documentId, {
      allowableStates: ["ready", "unavailable", "requesting", "loading"],
    });
    expect(handle.isReady()).toBe(false);

    // automerge-repo itself already keeps a "change" listener on the
    // handle before any of this module's code runs, so a bare `> 0` check
    // isn't a reliable signal that watchDocReady's OWN listener has
    // attached — track the baseline and wait for a listener beyond it.
    const baseline = handle.listenerCount("change");

    const received: unknown[] = [];
    const unsub = watchDocReady<{ title: string }>(repo, otherHandle.documentId, (h) => {
      received.push(h.doc());
    });

    // watchDocReady's own repo.find() resolves to this same cached handle
    // and attaches its "change" listener asynchronously — wait for that
    // before simulating a peer delivering real content.
    await waitFor(() => handle.listenerCount("change") > baseline);
    expect(received).toHaveLength(0);

    // simulate a peer delivering the document's real content — the same
    // mechanism automerge-repo's own sync layer uses internally when sync
    // data actually arrives. DocHandle.update() is handled regardless of
    // the handle's current state, so this genuinely drives the handle's
    // "unavailable"/"requesting" -> "ready" transition, exactly like a
    // reconnecting peer would.
    simulatePeerDelivering(handle, (doc) => {
      doc.title = "now available";
    });

    // watchDocReady defers its own readiness check by a microtask (see
    // module comment) — flush the microtask queue before asserting.
    await Promise.resolve();

    expect(handle.isReady()).toBe(true);
    expect(received).toEqual([{ title: "now available" }]);
    unsub();
  });

  it("never logs to the console while waiting for a doc that never arrives", async () => {
    // this is the regression case for the original bug: automerge-repo's
    // own whenReady() unconditionally console.logs on every timeout.
    // watchDocReady must never call whenReady() at all.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const otherRepo = createTestRepo();
      const otherHandle = otherRepo.create<{ title: string }>({ title: "seed" });
      await otherHandle.whenReady();

      const repo = createTestRepo();
      const received: unknown[] = [];
      const unsub = watchDocReady<{ title: string }>(repo, otherHandle.documentId, (h) => {
        received.push(h.doc());
      });

      // give it a real chance to settle and (not) log
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(0);
      expect(logSpy).not.toHaveBeenCalled();
      unsub();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("stops listening once unsubscribed, even if the doc becomes ready afterward", async () => {
    const otherRepo = createTestRepo();
    const otherHandle = otherRepo.create<{ title: string }>({ title: "seed" });
    await otherHandle.whenReady();

    const repo = createTestRepo();
    const handle = await repo.find<{ title: string }>(otherHandle.documentId, {
      allowableStates: ["ready", "unavailable", "requesting", "loading"],
    });
    const baseline = handle.listenerCount("change");

    const received: unknown[] = [];
    const unsub = watchDocReady<{ title: string }>(repo, otherHandle.documentId, (h) => {
      received.push(h.doc());
    });

    await waitFor(() => handle.listenerCount("change") > baseline);
    unsub();
    expect(handle.listenerCount("change")).toBe(baseline);

    simulatePeerDelivering(handle, (doc) => {
      doc.title = "arrived after unsub";
    });

    // give any (incorrect) async callback a chance to fire before asserting
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(0);
  });

  it("respects an already-aborted signal — never calls onReady, never calls repo.find()", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ title: string }>({ title: "hello" });
    await handle.whenReady();

    const findSpy = vi.spyOn(repo, "find");
    const controller = new AbortController();
    controller.abort();

    const received: unknown[] = [];
    watchDocReady<{ title: string }>(repo, handle.documentId, (h) => received.push(h.doc()), {
      signal: controller.signal,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(0);
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("respects a signal aborted mid-wait — detaches and never calls onReady", async () => {
    const otherRepo = createTestRepo();
    const otherHandle = otherRepo.create<{ title: string }>({ title: "seed" });
    await otherHandle.whenReady();

    const repo = createTestRepo();
    const handle = await repo.find<{ title: string }>(otherHandle.documentId, {
      allowableStates: ["ready", "unavailable", "requesting", "loading"],
    });
    const baseline = handle.listenerCount("change");

    const controller = new AbortController();
    const received: unknown[] = [];
    watchDocReady<{ title: string }>(repo, otherHandle.documentId, (h) => received.push(h.doc()), {
      signal: controller.signal,
    });

    await waitFor(() => handle.listenerCount("change") > baseline);
    controller.abort();
    expect(handle.listenerCount("change")).toBe(baseline);

    simulatePeerDelivering(handle, (doc) => {
      doc.title = "arrived after abort";
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(0);
  });

  it("calling the returned unsubscribe twice is a no-op (no error, no double-removal)", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ title: string }>({ title: "hello" });
    await handle.whenReady();

    const unsub = watchDocReady<{ title: string }>(repo, handle.documentId, () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it("silently gives up (never calls onReady) if repo.find() rejects", async () => {
    const repo = createTestRepo();
    vi.spyOn(repo, "find").mockRejectedValueOnce(new Error("boom"));

    const received: unknown[] = [];
    const unsub = watchDocReady<{ title: string }>(repo, "bogus-doc-id" as any, (h) =>
      received.push(h.doc())
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(0);
    unsub();
  });
});

describe("resolveDocReady", () => {
  it("resolves with the handle for an already-ready doc", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ title: string }>({ title: "hello" });
    await handle.whenReady();

    const resolved = await resolveDocReady<{ title: string }>(repo, handle.documentId);
    expect(resolved?.doc()).toEqual({ title: "hello" });
  });

  it("resolves null once opts.timeoutMs elapses for a doc that never arrives", async () => {
    const otherRepo = createTestRepo();
    const otherHandle = otherRepo.create<{ title: string }>({ title: "seed" });
    await otherHandle.whenReady();

    const repo = createTestRepo();
    const result = await resolveDocReady<{ title: string }>(repo, otherHandle.documentId, {
      timeoutMs: 50,
    });
    expect(result).toBeNull();
  });

  it("resolves null immediately for an already-aborted signal", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ title: string }>({ title: "hello" });
    await handle.whenReady();

    const controller = new AbortController();
    controller.abort();

    const result = await resolveDocReady<{ title: string }>(repo, handle.documentId, {
      signal: controller.signal,
    });
    expect(result).toBeNull();
  });

  it("resolves null when an external signal aborts before the doc becomes ready", async () => {
    const otherRepo = createTestRepo();
    const otherHandle = otherRepo.create<{ title: string }>({ title: "seed" });
    await otherHandle.whenReady();

    const repo = createTestRepo();
    const controller = new AbortController();
    const promise = resolveDocReady<{ title: string }>(repo, otherHandle.documentId, {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 20);
    const result = await promise;
    expect(result).toBeNull();
  });

  it("resolves with the handle if the doc becomes ready before the timeout", async () => {
    const otherRepo = createTestRepo();
    const otherHandle = otherRepo.create<{ title: string }>({ title: "seed" });
    await otherHandle.whenReady();

    const repo = createTestRepo();
    const handle = await repo.find<{ title: string }>(otherHandle.documentId, {
      allowableStates: ["ready", "unavailable", "requesting", "loading"],
    });
    const baseline = handle.listenerCount("change");

    const promise = resolveDocReady<{ title: string }>(repo, otherHandle.documentId, {
      timeoutMs: 5000,
    });

    await waitFor(() => handle.listenerCount("change") > baseline);
    simulatePeerDelivering(handle, (doc) => {
      doc.title = "arrived in time";
    });

    const result = await promise;
    expect(result?.doc()).toEqual({ title: "arrived in time" });
  });

  it("never logs to the console on timeout (regression check)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const otherRepo = createTestRepo();
      const otherHandle = otherRepo.create<{ title: string }>({ title: "seed" });
      await otherHandle.whenReady();

      const repo = createTestRepo();
      const result = await resolveDocReady<{ title: string }>(repo, otherHandle.documentId, {
        timeoutMs: 50,
      });
      expect(result).toBeNull();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("doc-ready negative cache", () => {
  beforeEach(() => {
    _clearDocReadyCacheForTests();
  });

  it("markUnavailable/isRecentlyUnavailable/markResolved track a cooldown per doc id", () => {
    expect(isRecentlyUnavailable("doc-1")).toBe(false);

    markUnavailable("doc-1");
    expect(isRecentlyUnavailable("doc-1")).toBe(true);
    // a different doc id is unaffected
    expect(isRecentlyUnavailable("doc-2")).toBe(false);

    markResolved("doc-1");
    expect(isRecentlyUnavailable("doc-1")).toBe(false);
  });

  it("isRecentlyUnavailable respects a custom cooldown window", () => {
    markUnavailable("doc-1");
    // already outside a 0ms cooldown
    expect(isRecentlyUnavailable("doc-1", 0)).toBe(false);
    // still within a very long cooldown
    expect(isRecentlyUnavailable("doc-1", 60_000)).toBe(true);
  });

  it("resolveDocReadyCached resolves a ready doc and clears any prior failure", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ title: string }>({ title: "hello" });
    await handle.whenReady();

    markUnavailable(handle.documentId);
    expect(isRecentlyUnavailable(handle.documentId)).toBe(true);

    // cooldownMs: 0 bypasses the just-set cache entry so this attempt
    // actually runs — proving a real, now-ready doc clears the failure.
    const resolved = await resolveDocReadyCached(repo, handle.documentId, { cooldownMs: 0 });
    expect(resolved).not.toBeNull();
    expect(resolved?.doc()).toEqual({ title: "hello" });
    expect(isRecentlyUnavailable(handle.documentId)).toBe(false);
  });

  it("resolveDocReadyCached returns null (and caches the failure) for a doc that never becomes ready", async () => {
    // structurally valid doc id from a completely disconnected repo — this
    // repo has no network adapter, so it can never actually fetch content
    // for it, matching the real "permanently unreachable" scenario this
    // cache exists to protect against.
    const otherRepo = createTestRepo();
    const otherHandle = otherRepo.create<{ title: string }>({ title: "unreachable" });
    await otherHandle.whenReady();

    const repo = createTestRepo();
    const result = await resolveDocReadyCached(repo, otherHandle.documentId, { timeoutMs: 50 });
    expect(result).toBeNull();
    expect(isRecentlyUnavailable(otherHandle.documentId)).toBe(true);
  });

  it("resolveDocReadyCached short-circuits (skips resolving entirely) once a doc id is cached as unavailable", async () => {
    const repo = createTestRepo();
    markUnavailable("some-doc-id" as any);

    const start = Date.now();
    const result = await resolveDocReadyCached(repo, "some-doc-id" as any, { timeoutMs: 15_000 });
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // proves the full 15s timeout was never attempted — the cooldown check
    // short-circuited before any repo.find()/watchDocReady() call happened.
    expect(elapsed).toBeLessThan(1000);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { compactDoc, deepEqual, waitForQuietPeriod } from "./compact-doc";

describe("deepEqual", () => {
  it("treats two objects with the same data in a different key order as equal", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("still requires the same array order", () => {
    expect(deepEqual({ items: [1, 2] }, { items: [2, 1] })).toBe(false);
  });

  it("still catches a genuine data mismatch regardless of key order", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 99 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("recurses into nested objects/arrays with scrambled key order at every level", () => {
    const a = { outer: { x: 1, y: [{ p: 1, q: 2 }] } };
    const b = { outer: { y: [{ q: 2, p: 1 }], x: 1 } };
    expect(deepEqual(a, b)).toBe(true);
  });
});

describe("compactDoc", () => {
  it("creates a new doc with the same content and zero history", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ clips: { id: string; x: number }[] }>({ clips: [] });
    for (let i = 0; i < 5; i++) {
      handle.change((d) => {
        d.clips.push({ id: `c${i}`, x: i });
      });
    }

    const result = await compactDoc(repo, handle);
    expect(result).not.toBeNull();
    expect(result!.oldDocId).toBe(handle.documentId);
    expect(result!.newHandle.documentId).not.toBe(handle.documentId);
    expect(result!.newHandle.doc()).toEqual(handle.doc());
  });

  it("does not treat a heavily-edited doc's own reconstructed key order as a verification failure", async () => {
    // regression test for a real, live bug: a doc with many historical
    // field additions/removals (simulated here by writing fields in a
    // scrambled, non-alphabetical, repeatedly-changing order) can come
    // back from automerge with its OWN internal key order differing from
    // a freshly-built plain snapshot object's insertion order — the old
    // `JSON.stringify(a) !== JSON.stringify(b)` verification treated that
    // as "compaction corrupted the data" and aborted, even though the
    // data was identical.
    const repo = createTestRepo();
    const handle = repo.create<Record<string, number>>({});
    handle.change((d) => {
      d.zebra = 1;
      d.apple = 2;
      d.mango = 3;
    });
    handle.change((d) => {
      delete d.apple;
      d.apple = 4; // re-added — moves to the end of automerge's own key order
    });
    handle.change((d) => {
      d.banana = 5;
    });

    const result = await compactDoc(repo, handle);
    expect(result).not.toBeNull();
    expect(result!.newHandle.doc()).toEqual(handle.doc());
  });

  it("returns null for a handle with no content", async () => {
    const repo = createTestRepo();
    const handle = repo.create<Record<string, unknown>>();
    // never call handle.change() — doc() should still return an (empty) object
    // for a freshly-created handle, so this exercises the !doc() branch only
    // if that ever changes; otherwise this just documents the never-ready case.
    const unready = { isReady: () => false, doc: () => undefined } as any;
    expect(await compactDoc(repo, unready)).toBeNull();
    // sanity: a real, ready handle with actual content still compacts fine
    handle.change((d) => {
      d.foo = "bar";
    });
    expect(await compactDoc(repo, handle)).not.toBeNull();
  });
});

describe("waitForQuietPeriod", () => {
  it("resolves after quietMs with no changes", async () => {
    vi.useFakeTimers();
    try {
      const repo = createTestRepo();
      const handle = repo.create<{ x: number }>({ x: 0 });
      const done = vi.fn();
      void waitForQuietPeriod(handle, { quietMs: 1_000, maxWaitMs: 10_000 }).then(done);

      await vi.advanceTimersByTimeAsync(999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the quiet timer on each incoming change, up to maxWaitMs", async () => {
    vi.useFakeTimers();
    try {
      const repo = createTestRepo();
      const handle = repo.create<{ x: number }>({ x: 0 });
      const done = vi.fn();
      void waitForQuietPeriod(handle, { quietMs: 1_000, maxWaitMs: 3_000 }).then(done);

      // a change every 800ms keeps resetting the quiet timer...
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(800);
        handle.change((d) => {
          d.x++;
        });
      }
      expect(done).not.toHaveBeenCalled();

      // ...but maxWaitMs (3000ms total) still forces a resolution regardless.
      await vi.advanceTimersByTimeAsync(600);
      expect(done).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

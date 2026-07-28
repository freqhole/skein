import { describe, it, expect, vi } from "vitest";
import { next as A } from "@automerge/automerge/slim";
import { createTestRepo, waitFor } from "../test-helpers/automerge-helpers";
import { CanvasStore } from "../canvas/canvas-store";
import { _clearDocReadyCacheForTests } from "../p2p/doc-ready";
import { syncCanvasMetadataToCards, watchCanvasDocsForUpdates } from "./canvas-watchers";

const OWNER = "owner".padEnd(64, "0");
const OTHER = "other".padEnd(64, "0");

/** add a "canvas-card" widget (pointing at `cardHandle`) to `narthexStore`,
 *  matching the shape widget-manager.ts's mount flow produces. */
function addCanvasCardWidget(
  narthexStore: CanvasStore,
  id: string,
  cardDocumentId: string
): void {
  narthexStore.addWidget({
    id,
    type: "canvas-card",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 0,
    props: {},
    collapsed: false,
    docId: cardDocumentId as any,
    parentId: null,
  });
}

describe("syncCanvasMetadataToCards", () => {
  it("copies fresh title/lastModified/lastModifiedBy from a reachable linked canvas into the card doc", async () => {
    const repo = createTestRepo();
    const targetCanvas = CanvasStore.create(repo);
    targetCanvas.setLocalNodeId(OTHER);
    targetCanvas.setTitle("shared canvas");
    targetCanvas.handle.change((d) => {
      d.lastModifiedBy = OTHER;
    });

    const cardHandle = repo.create<Record<string, unknown>>({
      canvasDocId: targetCanvas.handle.documentId,
      lastVisitedAt: new Date(0).toISOString(),
    });

    const narthexStore = CanvasStore.create(repo);
    addCanvasCardWidget(narthexStore, "card-1", cardHandle.documentId);

    await syncCanvasMetadataToCards(repo, narthexStore, OWNER);

    expect(cardHandle.doc().title).toBe("shared canvas");
    expect(cardHandle.doc().hasUpdates).toBe(true); // lastModifiedBy differs from OWNER
  });

  it(
    "skips silently (no throw) when the card's own per-widget doc is unreachable",
    async () => {
      _clearDocReadyCacheForTests();
      // mint a structurally valid document id from an unrelated, disconnected
      // repo — genuinely unreachable from the repo under test, same as a
      // real offline peer's doc. syncCanvasMetadataToCards' card-doc lookup
      // is bounded to a hardcoded ~15s (see resolveDocReadyCached's default
      // timeoutMs) — this test's own timeout is extended below to give that
      // real wait room to finish, so no dangling background timer leaks
      // into later tests in this file.
      const otherRepo = createTestRepo();
      const unreachableCardHandle = otherRepo.create<Record<string, unknown>>({
        canvasDocId: "whatever",
      });
      await unreachableCardHandle.whenReady();

      const repo = createTestRepo();
      const narthexStore = CanvasStore.create(repo);
      addCanvasCardWidget(narthexStore, "card-1", unreachableCardHandle.documentId);

      await expect(syncCanvasMetadataToCards(repo, narthexStore, OWNER)).resolves.toBeUndefined();
    },
    20_000
  );

  it(
    "skips silently (no throw) when the card resolves but the linked canvas doc is unreachable",
    async () => {
      _clearDocReadyCacheForTests();
      // CanvasStore.open() here is also bounded to a hardcoded ~15s — see
      // comment on the previous test for why this test's timeout is extended.
      const otherRepo = createTestRepo();
      const unreachableCanvas = CanvasStore.create(otherRepo);
      await unreachableCanvas.handle.whenReady();

      const repo = createTestRepo();
      const cardHandle = repo.create<Record<string, unknown>>({
        canvasDocId: unreachableCanvas.handle.documentId,
      });
      const narthexStore = CanvasStore.create(repo);
      addCanvasCardWidget(narthexStore, "card-1", cardHandle.documentId);

      await expect(syncCanvasMetadataToCards(repo, narthexStore, OWNER)).resolves.toBeUndefined();

      // card is untouched — the canvas was never actually opened
      expect(cardHandle.doc().title).toBeUndefined();
    },
    20_000
  );
});

describe("watchCanvasDocsForUpdates", () => {
  it("sets hasUpdates when the linked canvas doc changes via a remote peer", async () => {
    const repo = createTestRepo();
    const targetCanvas = CanvasStore.create(repo);
    targetCanvas.setLocalNodeId(OTHER);

    const cardHandle = repo.create<Record<string, unknown>>({
      canvasDocId: targetCanvas.handle.documentId,
      modifiedAt: "",
    });

    const narthexStore = CanvasStore.create(repo);
    addCanvasCardWidget(narthexStore, "card-1", cardHandle.documentId);

    vi.stubGlobal("window", { location: { hash: "" } });
    try {
      // watchCanvasDocsForUpdates attaches its "change" listener
      // asynchronously (the canvas doc is already ready, but resolving it
      // still goes through a promise) — wait for the listener to actually
      // land before mutating, otherwise the change event fires before
      // anything is listening for it.
      const baseline = targetCanvas.handle.listenerCount("change");
      const unsubs = await watchCanvasDocsForUpdates(repo, narthexStore, OWNER);
      try {
        await waitFor(() => targetCanvas.handle.listenerCount("change") > baseline);

        // stamp title + lastModifiedBy together in one change — setTitle()
        // alone doesn't stamp lastModifiedBy, and a separate change() call
        // for it would fire a second "change" event with lastModified
        // unchanged, which onChange's own already-seen-this-lastModified
        // guard would then (correctly) ignore.
        targetCanvas.handle.change((d) => {
          d.title = "updated by someone else";
          d.lastModified = new Date().toISOString();
          d.lastModifiedBy = OTHER;
        });

        await waitFor(() => cardHandle.doc().hasUpdates === true);
        expect(cardHandle.doc().lastModifiedBy).toBe(OTHER);
      } finally {
        unsubs.forEach((unsub) => unsub());
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not set hasUpdates for the local peer's own edits", async () => {
    const repo = createTestRepo();
    const targetCanvas = CanvasStore.create(repo);
    targetCanvas.setLocalNodeId(OWNER);

    const cardHandle = repo.create<Record<string, unknown>>({
      canvasDocId: targetCanvas.handle.documentId,
      modifiedAt: "",
    });

    const narthexStore = CanvasStore.create(repo);
    addCanvasCardWidget(narthexStore, "card-1", cardHandle.documentId);

    vi.stubGlobal("window", { location: { hash: "" } });
    try {
      const baseline = targetCanvas.handle.listenerCount("change");
      const unsubs = await watchCanvasDocsForUpdates(repo, narthexStore, OWNER);
      try {
        await waitFor(() => targetCanvas.handle.listenerCount("change") > baseline);

        targetCanvas.handle.change((d) => {
          d.title = "my own edit";
          d.lastModified = new Date().toISOString();
          d.lastModifiedBy = OWNER;
        });

        // give the watcher a real chance to (incorrectly) fire before asserting
        await new Promise((r) => setTimeout(r, 50));
        expect(cardHandle.doc().hasUpdates).toBeFalsy();
      } finally {
        unsubs.forEach((unsub) => unsub());
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recovers once a canvas doc that started unreachable later receives real content — proves event-driven recovery end to end", async () => {
    // mint a structurally valid canvas document id from an unrelated repo,
    // then reference it from a card in a completely disconnected repo — the
    // card doc itself is real/local so it resolves immediately, but the
    // linked canvas genuinely cannot be fetched until we simulate a peer
    // delivering it below.
    const otherRepo = createTestRepo();
    const otherCanvas = otherRepo.create<any>({
      widgets: {},
      title: "",
      lastModified: "",
      lastModifiedBy: "",
    });
    await otherCanvas.whenReady();

    const repo = createTestRepo();
    const cardHandle = repo.create<Record<string, unknown>>({
      canvasDocId: otherCanvas.documentId,
      modifiedAt: "",
    });
    const narthexStore = CanvasStore.create(repo);
    addCanvasCardWidget(narthexStore, "card-1", cardHandle.documentId);

    // resolve the (not-yet-ready) canvas handle directly first, so we can
    // capture a baseline "change" listener count before watchCanvasDocsForUpdates
    // attaches its own internal watchDocReady listener — repo.find() returns
    // the same cached handle instance for a given docId within one repo.
    const canvasHandle = await repo.find<any>(otherCanvas.documentId, {
      allowableStates: ["ready", "unavailable", "requesting", "loading"],
    });
    expect(canvasHandle.isReady()).toBe(false);
    const baseline = canvasHandle.listenerCount("change");

    vi.stubGlobal("window", { location: { hash: "" } });
    try {
      const unsubs = await watchCanvasDocsForUpdates(repo, narthexStore, OWNER);
      try {
        // watchDocReady attaches its own internal listener asynchronously —
        // wait for that before simulating delivery, otherwise the "change"
        // event fires before anything is listening for it.
        await waitFor(() => canvasHandle.listenerCount("change") > baseline);
        expect(cardHandle.doc().hasUpdates).toBeFalsy();

        // step 1: simulate a peer delivering the doc for the first time —
        // this is the "change" event watchDocReady's own internal listener
        // reacts to in order to detect readiness and hand off to our
        // onChange listener; onChange itself only starts observing changes
        // from the point it's attached onward, so it can't react to this
        // very same event.
        canvasHandle.update((doc: any) => A.change(doc, (d: any) => (d.title = "placeholder")));
        await waitFor(() => canvasHandle.isReady());
        // let watchDocReady's deferred (queueMicrotask) onReady callback
        // finish attaching onChange before the next real change arrives.
        await new Promise((r) => setTimeout(r, 0));

        // step 2: a genuinely new change, now observed by onChange — the
        // same mechanism automerge-repo's own sync layer uses internally
        // when further sync data streams in after the doc first arrives.
        canvasHandle.update((doc: any) =>
          A.change(doc, (d: any) => {
            d.title = "arrived later";
            d.lastModified = new Date().toISOString();
            d.lastModifiedBy = OTHER;
          })
        );

        await waitFor(() => cardHandle.doc().hasUpdates === true);
        expect(cardHandle.doc().lastModifiedBy).toBe(OTHER);
      } finally {
        unsubs.forEach((unsub) => unsub());
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

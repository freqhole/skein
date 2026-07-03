/**
 * real, multi-canvas e2e coverage for a genuine bug in `blob-acl-sync.ts`:
 * `restrict_blob_to_peers` (`midden/src/lib.rs`) REPLACES a hash's
 * allow-list rather than adding to it, and only one canvas is ever open/
 * mounted at a time in this app (`standalone/boot.ts`'s `SkeinRouter` —
 * exactly one `CanvasBlobAclSync` alive, created in `initCanvas()` and
 * destroyed in `destroyCurrent()` on every navigation).
 *
 * before the fix: if the SAME blob (same blake3 hash) is referenced by
 * widgets on two different canvases owned by the same device, with
 * DIFFERENT peer sets in each canvas's `.acl`, opening canvas B after
 * canvas A would silently revoke access for peers A legitimately still
 * shares the blob with — whichever canvas synced last would win.
 *
 * the fix (`blob-acl-registry.ts`): every `CanvasBlobAclSync` reports its
 * own canvas's hash->peers contribution into a shared, session-scoped
 * registry and pushes the UNION across every canvas contribution
 * currently known — not just the currently-open canvas's own.
 *
 * this test deliberately uses the REAL production app (`page.goto("/")`,
 * real `SkeinRouter`/`boot.ts`, real hash-based navigation between two
 * real canvases created via the actual `skein:create-canvas` flow) for the
 * "owner" device, rather than the lighter-weight `p2pPage` fixture other
 * blob-acl specs use — that fixture only ever mounts a single canvas, so
 * it can't exercise "close canvas A, open canvas B" at all. the peers
 * being granted/denied access (X, Y, Z, and a stranger) use the simpler
 * `p2pPage` fixture, since they only need a real iroh identity + the
 * `fetchBlob` test hook, not the full app.
 *
 * the owner's page needs `window.__skeinTest.p2p` (import/fetch/restrict
 * blob helpers) — production `boot.ts` now wires this in DEV builds
 * (`buildP2PBridge(this.irohAdapter)`, mirroring the existing
 * `social`/`share`/`messagez` DEV-only test bridges already wired there).
 *
 * tag: @p2p
 * run with: npx playwright test tests/blob-acl-cross-canvas.spec.ts --workers=1
 */

import { test, expect } from "./fixtures/p2p-page";
import type { Page } from "@playwright/test";
import { fromEvaluateArray, randomBlobBytes, toEvaluateArray } from "./helpers/blob-fixtures";
import { ensureIdentityBridge } from "./helpers/skein-bridge";

/** wait for the production app's narthex to finish its first render. */
async function waitForNarthex(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__skein != null, { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const skein = (window as any).__skein;
      return skein?.widgetManager?.getLiveWidgets()?.size > 0;
    },
    { timeout: 30_000 }
  );
}

/** dispatch skein:create-canvas and wait for hash navigation to the new
 *  canvas — same helper other production-app e2e files in this repo each
 *  define locally (canvas-share-hub.spec.ts, profile-canvases.test.ts, etc). */
async function createCanvasAndWaitForNavigation(
  page: Page,
  detail: { title: string; color: number }
): Promise<string> {
  const hashBefore = await page.evaluate(() => window.location.hash);
  await page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent("skein:create-canvas", { detail: d }));
  }, detail);
  await page.waitForFunction(
    (prevHash) => window.location.hash !== prevHash && window.location.hash.length > 1,
    hashBefore,
    { timeout: 10_000 }
  );
  return page.evaluate(() => window.location.hash.slice(1));
}

/** navigate the production app's real router back to the narthex, exactly
 *  like clicking the toolbar's home button (`onNavigateHome`, boot.ts). */
async function navigateHome(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = "";
  });
  await page.waitForFunction(() => window.location.hash === "", { timeout: 10_000 });
  await waitForNarthex(page);
}

/** import bytes into the owner's real iroh-blobs store via the production
 *  app's DEV-only p2p test bridge, returning the blake3 hex hash. */
async function importBlob(page: Page, bytes: Uint8Array): Promise<string> {
  return page.evaluate(async (byteArray: number[]) => {
    const bridge = (window as any).__skeinTest;
    const raw = Uint8Array.from(byteArray);
    return bridge.p2p.importBlob(raw) as Promise<string>;
  }, toEvaluateArray(bytes));
}

/** add a real "file" widget to the owner's currently-open production
 *  canvas referencing `blake3Hash` — same field shape blob-acl.spec.ts's
 *  `importBlobAndCreateFileWidget` helper uses, reading straight off the
 *  real `window.__skein.repo`/`window.__skein.store` (production's
 *  equivalent of the p2p harness's `bridge.canvas.repo`/`.store`). */
async function addFileWidgetWithBlob(page: Page, blake3Hash: string): Promise<void> {
  await page.evaluate(async (hash: string) => {
    const skein = (window as any).__skein;
    const repo = skein.repo;
    const store = skein.store;

    const widgetHandle = repo.create();
    widgetHandle.change((d: any) => {
      d.blake3 = hash;
      d.blobId = hash;
      d.domain = "file";
      d.filename = "cross-canvas-test.bin";
      d.mime = "application/octet-stream";
      d.size = 0;
      d.thumbnailDataUrl = "";
    });

    store.addWidget({
      id: crypto.randomUUID(),
      type: "file",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: widgetHandle.documentId,
      parentId: null,
    });
  }, blake3Hash);
}

/** grant a real role on the owner's currently-open production canvas —
 *  same `CanvasStore.setRole()` call the real share dialog/invite flow
 *  makes. */
async function setRole(page: Page, nodeId: string, role: "member" | "viewer"): Promise<void> {
  await page.evaluate(
    ([id, r]) => {
      (window as any).__skein.store.setRole(id, r);
    },
    [nodeId, role] as const
  );
}

/** fetch a blob directly from `ownerNodeId`, from a p2p-harness peer page. */
async function tryFetchBlob(page: Page, ownerNodeId: string, blake3Hash: string): Promise<number[]> {
  return page.evaluate(
    async ([peerId, hash]) => {
      const bridge = (window as any).__skeinTest;
      const bytes: Uint8Array = await bridge.p2p.fetchBlob(peerId, hash);
      return Array.from(bytes);
    },
    [ownerNodeId, blake3Hash] as const
  );
}

/** retry until a fetch succeeds — legitimate propagation wait (the
 *  production app's CanvasBlobAclSync runs a few async steps after a doc
 *  mutation), not a flakiness mask, same reasoning as
 *  blob-acl-live-sync.spec.ts's identically-named helper. a generous
 *  attempts*delay budget vs that file's, since real full-app navigation
 *  (pixi init, widget mounting) adds latency the lighter p2p harness
 *  doesn't have. */
async function expectEventuallyAllowed(
  page: Page,
  ownerNodeId: string,
  blake3Hash: string,
  expectedBytes: Uint8Array,
  attempts = 12,
  delayMs = 1000
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const bytes = await tryFetchBlob(page, ownerNodeId, blake3Hash);
      expect(fromEvaluateArray(bytes)).toEqual(expectedBytes);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

/** retry until a fetch is rejected — the mirror image of the helper above. */
async function expectEventuallyDenied(
  page: Page,
  ownerNodeId: string,
  blake3Hash: string,
  attempts = 12,
  delayMs = 1000
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await tryFetchBlob(page, ownerNodeId, blake3Hash);
      // fetch succeeded — not denied yet (or still in the transient
      // unrestricted-by-default window before the first sync completes),
      // give the sync more time.
    } catch {
      return;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `expected fetch of ${blake3Hash.slice(0, 16)}... by ${ownerNodeId.slice(0, 16)}... to eventually be denied, but it kept succeeding after ${attempts} attempts`
  );
}

test("a peer authorized via a closed canvas can still fetch a shared blob while a different, currently-open canvas has an unrelated peer set @p2p", async ({
  page,
  p2pPage,
}) => {
  test.setTimeout(180_000);

  await page.goto("/");
  await waitForNarthex(page);
  const ownerNodeId = await ensureIdentityBridge(page);

  const peerX = await p2pPage();
  const peerY = await p2pPage();
  const peerZ = await p2pPage();
  const stranger = await p2pPage();

  const marker = randomBlobBytes();
  const blake3 = await importBlob(page, marker);

  // --- canvas A: owner (auto-admin) + peerX + peerY ------------------------
  const canvasA = await createCanvasAndWaitForNavigation(page, {
    title: "cross-canvas blob test — A",
    color: 0x10b981,
  });
  await addFileWidgetWithBlob(page, blake3);
  await setRole(page, peerX.nodeId, "member");
  await setRole(page, peerY.nodeId, "member");

  await expectEventuallyAllowed(peerX.page, ownerNodeId, blake3, marker);
  await expectEventuallyAllowed(peerY.page, ownerNodeId, blake3, marker);
  // sanity: canvas A's ACL genuinely gates this blob — it isn't wide open.
  await expectEventuallyDenied(stranger.page, ownerNodeId, blake3);

  // --- navigate away (real router navigation — destroys canvas A's
  // CanvasBlobAclSync via destroyCurrent()) then create canvas B ----------
  await navigateHome(page);
  const canvasB = await createCanvasAndWaitForNavigation(page, {
    title: "cross-canvas blob test — B",
    color: 0x6366f1,
  });
  expect(canvasB).not.toBe(canvasA);

  // same blake3 hash, referenced by a brand new widget on the new canvas,
  // shared with a completely different peer.
  await addFileWidgetWithBlob(page, blake3);
  await setRole(page, peerZ.nodeId, "member");

  // positive control: canvas B's own peer must get access.
  await expectEventuallyAllowed(peerZ.page, ownerNodeId, blake3, marker);

  // the actual proof this test exists for: X and Y (authorized only via
  // now-closed canvas A) must STILL be able to fetch the blob, even though
  // canvas B — the currently open canvas — never granted them anything and
  // has now synced its own (different) allow-list for the same hash.
  await expectEventuallyAllowed(peerX.page, ownerNodeId, blake3, marker);
  await expectEventuallyAllowed(peerY.page, ownerNodeId, blake3, marker);

  // a stranger authorized on neither canvas must still be denied — proves
  // the fix doesn't overshoot into "just allow everyone".
  await expectEventuallyDenied(stranger.page, ownerNodeId, blake3);
});

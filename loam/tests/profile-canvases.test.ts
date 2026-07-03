// E2E tests for profile-tab.ts's "my canvases" section — see
// docs/hub-and-profile-plan.md section 6 / section 8 step 7 (second half).
//
// like image-and-profile.test.ts, this runs against the production app
// (page.goto("/"), not a test harness page) since profile-tab.ts only mounts
// inside the real social overlay, which boot.ts wires with a live
// CanvasStore + ProfileStore. all bridge access goes through the typed
// helpers in tests/helpers/skein-bridge.ts.

import { expect, test } from "@playwright/test";
import {
  addCurrentCanvasToProfile,
  canAddCurrentCanvasToProfile,
  collectPixiWarnings,
  ensureIdentityBridge,
  getLoadedPreviewCanvasIds,
  getProfileCanvasEntries,
  getRenderedProfileCanvasTitles,
  removeCanvasFromProfile,
  toggleSocialOverlay,
} from "./helpers/skein-bridge";

// ---------------------------------------------------------------------------
// helpers (mirrors image-and-profile.test.ts's own copies almost verbatim)
// ---------------------------------------------------------------------------

async function waitForNarthex(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__skein != null, { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const skein = (window as any).__skein;
      return skein?.widgetManager?.getLiveWidgets()?.size > 0;
    },
    { timeout: 30_000 }
  );
}

/** dispatch skein:create-canvas and wait for hash navigation */
async function createCanvasAndWaitForNavigation(
  page: import("@playwright/test").Page,
  detail: { title: string; color: number; description?: string }
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

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test.describe("profile tab — my canvases", () => {
  // run serially to avoid resource contention (midden wasm + iroh startup is heavy).
  // each test gets a fresh browser context with empty IDB from playwright.
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  const pixiWarningsByPage = new WeakMap<import("@playwright/test").Page, string[]>();

  test.beforeEach(async ({ page }) => {
    pixiWarningsByPage.set(page, collectPixiWarnings(page));
    await page.goto("/");
    await waitForNarthex(page);
  });

  // a masked/scrollable container's `.height` (or `.getBounds()`) must
  // never be read directly in this app — pixi logs "PixiJS Warning: Mask
  // bounds, renderable is not inside the root container" when it is, and
  // (per a real bug found live, 2026-07-02, in profile-tab.ts's "my
  // canvases" scroll wrapper) rendering can silently break at the same
  // time, with no thrown exception for a `pageerror` listener to catch.
  // collecting here (rather than per-test) covers every test in this file
  // automatically.
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "passed") return;
    expect(pixiWarningsByPage.get(page) ?? []).toEqual([]);
  });

  test("add-current-canvas is hidden while on the narthex meta-canvas, shown on a real canvas", async ({
    page,
  }) => {
    // the narthex is a private per-user index of canvas-card references —
    // it must never be offered for "add to profile" (see
    // docs/hub-and-profile-plan.md section 10.2's follow-up fix).
    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    const canAddOnNarthex = await canAddCurrentCanvasToProfile(page);
    expect(canAddOnNarthex).toBe(false);

    await toggleSocialOverlay(page); // close before navigating
    await createCanvasAndWaitForNavigation(page, {
      title: "a real canvas",
      color: 0x6366f1,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    const canAddOnRealCanvas = await canAddCurrentCanvasToProfile(page);
    expect(canAddOnRealCanvas).toBe(true);
  });

  test("adding the currently-open canvas writes a matching entry to the profile doc", async ({
    page,
  }) => {
    const docId = await createCanvasAndWaitForNavigation(page, {
      title: "my shared canvas",
      description: "a canvas worth sharing",
      color: 0xd946ef,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    await addCurrentCanvasToProfile(page);

    // verify directly against ProfileStore.canvases(), not just UI state
    const entries = await getProfileCanvasEntries(page);
    expect(entries).toHaveLength(1);
    expect(entries[0].canvasDocId).toBe(docId);
    expect(entries[0].title).toBe("my shared canvas");
    expect(entries[0].description).toBe("a canvas worth sharing");
    expect(entries[0].color).toBe(0xd946ef);
  });

  test("the profile's canvas list renders every entry from the profile doc", async ({ page }) => {
    await createCanvasAndWaitForNavigation(page, {
      title: "rendered canvas one",
      color: 0x6366f1,
    });

    // profile-tab.ts's "my canvases" section (and everything below it) is
    // gated behind an identity existing (section 10 follow-up: this section
    // shouldn't render at all before the user has generated one) — unlike
    // sibling tests here that only assert against raw ProfileStore data
    // (unaffected by that gate), this one needs the real rendered list, so
    // it needs a real identity first.
    await ensureIdentityBridge(page);
    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);
    await addCurrentCanvasToProfile(page);

    await expect
      .poll(async () => getRenderedProfileCanvasTitles(page))
      .toContain("rendered canvas one");

    const entries = await getProfileCanvasEntries(page);
    expect(entries.map((e) => e.title)).toContain("rendered canvas one");
  });

  test("adding the same canvas twice updates the entry instead of duplicating it", async ({
    page,
  }) => {
    await createCanvasAndWaitForNavigation(page, {
      title: "idempotent canvas",
      color: 0x10b981,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    await addCurrentCanvasToProfile(page);
    await addCurrentCanvasToProfile(page);

    const entries = await getProfileCanvasEntries(page);
    expect(entries).toHaveLength(1);
  });

  test("add-current-canvas is hidden once the current canvas is already on the profile", async ({
    page,
  }) => {
    await createCanvasAndWaitForNavigation(page, {
      title: "already-added canvas",
      color: 0x8b5cf6,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    expect(await canAddCurrentCanvasToProfile(page)).toBe(true);

    await addCurrentCanvasToProfile(page);

    expect(await canAddCurrentCanvasToProfile(page)).toBe(false);
  });

  test("removing a canvas deletes it from the profile doc and the rendered list", async ({
    page,
  }) => {
    const docId = await createCanvasAndWaitForNavigation(page, {
      title: "removable canvas",
      color: 0xef4444,
    });

    // needed so the "rendered list" assertions below are meaningful (see
    // the "renders every entry" test's comment) — without an identity, the
    // list never renders anything, which would make the final "not
    // contain" check trivially true either way.
    await ensureIdentityBridge(page);
    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    await addCurrentCanvasToProfile(page);
    let entries = await getProfileCanvasEntries(page);
    expect(entries.map((e) => e.canvasDocId)).toContain(docId);

    // prove the row genuinely rendered before removal, so the later "not
    // contain" assertion is proof of removal, not just an empty list that
    // was never populated in the first place.
    await expect
      .poll(async () => getRenderedProfileCanvasTitles(page))
      .toContain("removable canvas");

    await removeCanvasFromProfile(page, docId);

    entries = await getProfileCanvasEntries(page);
    expect(entries.map((e) => e.canvasDocId)).not.toContain(docId);

    await expect
      .poll(async () => getRenderedProfileCanvasTitles(page))
      .not.toContain("removable canvas");
  });

  test("the profile's canvas list persists across page reload", async ({ page }) => {
    const docId = await createCanvasAndWaitForNavigation(page, {
      title: "persisted canvas",
      color: 0xf97316,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);
    await addCurrentCanvasToProfile(page);

    let entries = await getProfileCanvasEntries(page);
    expect(entries.map((e) => e.canvasDocId)).toContain(docId);

    // give automerge time to flush doc changes to IDB before reloading
    await page.waitForTimeout(800);
    await page.reload();
    await waitForNarthex(page);

    entries = await getProfileCanvasEntries(page);
    expect(entries.map((e) => e.canvasDocId)).toContain(docId);
    const persisted = entries.find((e) => e.canvasDocId === docId);
    expect(persisted?.title).toBe("persisted canvas");
  });

  test("a canvas entry with a previewUrl actually loads and attaches its preview image in the flat list", async ({
    page,
  }) => {
    // 1x1 transparent PNG — same fixture used elsewhere in this repo for
    // "does a data: URL preview actually render" coverage.
    const previewUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const docId = await createCanvasAndWaitForNavigation(page, {
      title: "img canvas",
      color: 0x10b981,
    });

    // set the previewUrl directly on the canvas doc (mirrors canvas-info.ts's
    // manual "pick image" flow / the create-wizard's own previewUrl seeding —
    // this test only cares about the profile list actually rendering it).
    await page.evaluate(() => {
      const skein = (window as any).__skein;
      skein.store.setPreviewUrl(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      );
    });

    // the "my canvases" section (and everything rendered by
    // rebuildCanvasList(), including image loading) is gated behind an
    // identity existing — see the "renders every entry" test's comment.
    await ensureIdentityBridge(page);
    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);
    await addCurrentCanvasToProfile(page);

    const entries = await getProfileCanvasEntries(page);
    const entry = entries.find((e) => e.canvasDocId === docId) as { previewUrl?: string } | undefined;
    expect(entry?.previewUrl).toBe(previewUrl);

    await expect
      .poll(async () => getLoadedPreviewCanvasIds(page), { timeout: 10_000 })
      .toContain(docId);
  });
});

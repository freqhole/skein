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

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForNarthex(page);
  });

  test("add-current-canvas action is available once the social overlay is mounted", async ({
    page,
  }) => {
    // even while still on the narthex canvas, the overlay's mount context
    // carries a real canvasStore (the narthex canvas itself) and a real
    // profileStore, so the action is available — this proves the mount
    // context wiring (boot.ts -> WidgetMountContext -> TabContext) reached
    // profile-tab.ts at all.
    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    const canAdd = await canAddCurrentCanvasToProfile(page);
    expect(canAdd).toBe(true);
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

  test("removing a canvas deletes it from the profile doc and the rendered list", async ({
    page,
  }) => {
    const docId = await createCanvasAndWaitForNavigation(page, {
      title: "removable canvas",
      color: 0xef4444,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    await addCurrentCanvasToProfile(page);
    let entries = await getProfileCanvasEntries(page);
    expect(entries.map((e) => e.canvasDocId)).toContain(docId);

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
});

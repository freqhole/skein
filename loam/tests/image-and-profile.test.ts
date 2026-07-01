// E2E tests for social widget features, canvas author auto-population,
// and image upload flows.
//
// the social widget lives in a toolbar overlay panel, not the narthex
// widgetManager. all social state access goes through the typed helpers in
// tests/helpers/skein-bridge.ts which wrap window.__skeinTest.social.

import { expect, test } from "@playwright/test";
import path from "path";
import {
  ensureIdentityBridge,
  getSocialProfile,
  toggleSocialOverlay,
  triggerAvatarPick,
  waitForNodeId,
} from "./helpers/skein-bridge";

// fixture images live at tests/fixtures/ relative to the playwright cwd
const fixturesDir = path.resolve("tests/fixtures");

// ---------------------------------------------------------------------------
// helpers
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

/** navigate back to the narthex and wait for it to be ready */
async function navigateBackToNarthex(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = "";
  });
  await page.waitForFunction(
    () => {
      const skein = (window as any).__skein;
      return skein?.widgetManager?.getLiveWidgets()?.size > 0;
    },
    { timeout: 10_000 }
  );
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test.describe("profile and image features", () => {
  // run serially to avoid resource contention (midden wasm + iroh startup is heavy).
  // each test gets a fresh browser context with empty IDB from playwright.
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForNarthex(page);
  });

  // -------------------------------------------------------------------------
  // profile node ID
  // -------------------------------------------------------------------------

  test("social widget stores a 64-char hex node ID after the user generates an identity", async ({
    page,
  }) => {
    // node IDs are NOT auto-generated on first boot — user must click
    // "generate identity" in the profile tab. simulate via bridge helper.
    await ensureIdentityBridge(page);
    const nodeId = await waitForNodeId(page);
    expect(nodeId).toMatch(/^[0-9a-f]{64}$/);

    const profile = await getSocialProfile(page);
    expect(profile).not.toBeNull();
    expect(profile!.nodeId).toBe(nodeId);
  });

  test("social widget node ID persists across page reload", async ({ page }) => {
    await ensureIdentityBridge(page);
    const nodeIdBefore = await waitForNodeId(page);
    expect(nodeIdBefore).toBeTruthy();

    // give automerge time to flush doc changes to IDB before reloading
    await page.waitForTimeout(800);

    // reload — same browser context keeps IDB alive
    await page.reload();
    await waitForNarthex(page);

    // profile-tab.ts calls getStoredIdentity() on mount and writes nodeId
    // back into the doc, restoring it from IDB
    const nodeIdAfter = await waitForNodeId(page);
    expect(nodeIdAfter).toBe(nodeIdBefore);
  });

  // -------------------------------------------------------------------------
  // canvas author auto-population
  // -------------------------------------------------------------------------

  test("canvas author is auto-populated from social widget username", async ({ page }) => {
    // set username directly on the standalone social doc
    await page.evaluate(() => {
      (window as any).__skeinTest?.social?.doc?.change?.((d: any) => {
        if (!d.profile) d.profile = {};
        d.profile.username = "alice";
      });
    });
    await page.waitForTimeout(200);

    await createCanvasAndWaitForNavigation(page, {
      title: "author test canvas",
      color: 0xd946ef,
    });
    await navigateBackToNarthex(page);

    // authorName is stored in the canvas-card's per-widget doc
    const authorName = await page.evaluate(() => {
      const skein = (window as any).__skein;
      const live = skein.widgetManager.getLiveWidgets();
      for (const [_id, widget] of live.entries()) {
        const entry = (widget as any).entry;
        if (entry?.type === "canvas-card") {
          const doc = (widget as any).widgetDoc;
          if (doc?.current?.authorName !== undefined) return doc.current.authorName;
        }
      }
      return "__no_card__";
    });

    expect(authorName).toBe("alice");
  });

  test("canvas author falls back to empty when social widget has no username", async ({ page }) => {
    // username is blank on a fresh boot — no setup needed
    await createCanvasAndWaitForNavigation(page, {
      title: "no-author test canvas",
      color: 0x3b82f6,
    });
    await navigateBackToNarthex(page);

    const authorName = await page.evaluate(() => {
      const skein = (window as any).__skein;
      const live = skein.widgetManager.getLiveWidgets();
      for (const [_id, widget] of live.entries()) {
        const entry = (widget as any).entry;
        if (entry?.type === "canvas-card") {
          const doc = (widget as any).widgetDoc;
          return doc?.current?.authorName ?? "__missing__";
        }
      }
      return "__no_card__";
    });

    expect(authorName).toBe("");
  });

  // -------------------------------------------------------------------------
  // profile avatar upload via file chooser
  // -------------------------------------------------------------------------

  test("social widget avatar upload via file chooser stores a WebP data URL", async ({ page }) => {
    // open the social overlay so the profile tab mounts and registers pickAvatar
    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 });
    await triggerAvatarPick(page);
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(fixturesDir, "freqhole.png"));

    // wait for image processing: resize → WebP encode → doc write
    await page.waitForFunction(
      () => {
        const url = (window as any).__skeinTest?.social?.doc?.current?.profile?.avatarDataUrl ?? "";
        return url.startsWith("data:image/");
      },
      { timeout: 10_000 }
    );

    const profile = await getSocialProfile(page);
    expect(profile!.avatarDataUrl).toMatch(/^data:image\/webp;base64,/);
  });

  test("social widget avatar persists across page reload", async ({ page }) => {
    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);

    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 });
    await triggerAvatarPick(page);
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(fixturesDir, "freqhole.png"));

    await page.waitForFunction(
      () => {
        const url = (window as any).__skeinTest?.social?.doc?.current?.profile?.avatarDataUrl ?? "";
        return url.startsWith("data:image/");
      },
      { timeout: 15_000 }
    );

    const avatarBefore = await page.evaluate(
      () => (window as any).__skeinTest?.social?.doc?.current?.profile?.avatarDataUrl ?? ""
    );
    expect(avatarBefore).toMatch(/^data:image\/webp;base64,/);

    await page.waitForTimeout(800);
    await page.reload();
    await waitForNarthex(page);
    await page.waitForTimeout(500);

    const avatarAfter = await page.evaluate(
      () => (window as any).__skeinTest?.social?.doc?.current?.profile?.avatarDataUrl ?? ""
    );
    expect(avatarAfter).toBe(avatarBefore);
  });

  // -------------------------------------------------------------------------
  // overlay singleton
  // -------------------------------------------------------------------------

  test("social overlay survives canvas navigate-back", async ({ page }) => {
    await createCanvasAndWaitForNavigation(page, {
      title: "singleton test canvas",
      color: 0xd946ef,
    });
    await navigateBackToNarthex(page);

    // after navigate-back the social test bridge should be re-populated
    const result = await page.evaluate(() => ({
      hasSocialDoc: !!(window as any).__skeinTest?.social?.doc?.current,
      hasToggle: typeof (window as any).__skeinTest?.social?.toggleOverlay === "function",
    }));

    expect(result.hasSocialDoc).toBe(true);
    expect(result.hasToggle).toBe(true);
  });

  // -------------------------------------------------------------------------
  // canvas-card preview image
  // -------------------------------------------------------------------------

  test("canvas-card previewUrl can be set and read back", async ({ page }) => {
    await createCanvasAndWaitForNavigation(page, {
      title: "preview test canvas",
      color: 0xef4444,
    });
    await navigateBackToNarthex(page);

    const fs = await import("fs");
    const imgBuffer = fs.readFileSync(path.join(fixturesDir, "freqhole.png"));
    const fakeDataUrl = `data:image/png;base64,${imgBuffer.toString("base64")}`;

    await page.evaluate((dataUrl) => {
      const skein = (window as any).__skein;
      const live = skein.widgetManager.getLiveWidgets();
      for (const [_id, widget] of live.entries()) {
        const entry = (widget as any).entry;
        if (entry?.type === "canvas-card") {
          const doc = (widget as any).widgetDoc;
          if (doc) {
            doc.change((d: any) => {
              d.previewUrl = dataUrl;
            });
          }
          break;
        }
      }
    }, fakeDataUrl);

    await page.waitForTimeout(500);

    const storedUrl = await page.evaluate(() => {
      const skein = (window as any).__skein;
      const live = skein.widgetManager.getLiveWidgets();
      for (const [_id, widget] of live.entries()) {
        const entry = (widget as any).entry;
        if (entry?.type === "canvas-card") {
          return (widget as any).widgetDoc?.current?.previewUrl ?? "";
        }
      }
      return "";
    });

    expect(storedUrl).toBe(fakeDataUrl);
  });
});

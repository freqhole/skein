// E2E tests for social widget features, canvas author auto-population,
// and image upload flows.
//
// the social widget lives in a toolbar overlay panel (not in the narthex
// widgetManager). its state doc is the standalone social doc exposed via
// window.__skeinSocialDoc. all tests access social state through that.

import { expect, test } from "@playwright/test";
import path from "path";

// resolve fixture paths relative to the project root (cwd when playwright runs)
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

/** read the social widget's profile sub-object from the standalone social doc */
async function getProfileState(
  page: import("@playwright/test").Page
): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const socialDoc = (window as any).__skeinSocialDoc;
    if (!socialDoc) return null;
    return (socialDoc.current?.profile as Record<string, unknown>) ?? null;
  });
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
  // each test gets a fresh browser context with empty IDB from playwright —
  // no manual IDB clearing needed.
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
    // node IDs are NOT auto-generated on first boot. the user must explicitly
    // click "generate identity" in the social widget profile tab.
    // here we simulate that via window.__skeinEnsureIdentity.
    await page.evaluate(async () => {
      await (window as any).__skeinEnsureIdentity();
    });

    // profile-tab.ts registers an onIdentityChange listener that calls
    // syncNodeIdToDoc, writing the nodeId into the standalone social doc
    await page.waitForFunction(
      () => {
        const socialDoc = (window as any).__skeinSocialDoc;
        const nodeId = socialDoc?.current?.profile?.nodeId;
        return typeof nodeId === "string" && nodeId.length === 64;
      },
      { timeout: 30_000 }
    );

    const state = await getProfileState(page);
    expect(state).not.toBeNull();
    expect(state!.nodeId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("social widget node ID persists across page reload", async ({ page }) => {
    // generate identity first
    await page.evaluate(async () => {
      await (window as any).__skeinEnsureIdentity();
    });

    // wait for nodeId to appear in the social doc
    await page.waitForFunction(
      () => {
        const socialDoc = (window as any).__skeinSocialDoc;
        const nodeId = socialDoc?.current?.profile?.nodeId;
        return typeof nodeId === "string" && nodeId.length === 64;
      },
      { timeout: 30_000 }
    );

    const nodeIdBefore = await page.evaluate(() => {
      return (window as any).__skeinSocialDoc?.current?.profile?.nodeId ?? "";
    });
    expect(nodeIdBefore).toBeTruthy();

    // give automerge a moment to flush the doc change to IDB
    await page.waitForTimeout(800);

    // reload — same browser context keeps IDB alive
    await page.reload();
    await waitForNarthex(page);

    // profile-tab.ts calls getStoredIdentity() on mount and writes nodeId
    // into the doc, so it should be restored from IDB
    await page.waitForFunction(
      () => {
        const socialDoc = (window as any).__skeinSocialDoc;
        const nodeId = socialDoc?.current?.profile?.nodeId;
        return typeof nodeId === "string" && nodeId.length === 64;
      },
      { timeout: 30_000 }
    );

    const nodeIdAfter = await page.evaluate(() => {
      return (window as any).__skeinSocialDoc?.current?.profile?.nodeId ?? "";
    });

    expect(nodeIdAfter).toBe(nodeIdBefore);
  });

  // -------------------------------------------------------------------------
  // canvas author auto-population
  // -------------------------------------------------------------------------

  test("canvas author is auto-populated from social widget username", async ({ page }) => {
    // set a username on the standalone social doc
    // createCanvasFromNarthex reads authorName from this doc directly
    await page.evaluate(() => {
      const socialDoc = (window as any).__skeinSocialDoc;
      if (socialDoc) {
        socialDoc.change((d: any) => {
          if (!d.profile) d.profile = {};
          d.profile.username = "alice";
        });
      }
    });
    await page.waitForTimeout(200);

    // create a canvas
    await createCanvasAndWaitForNavigation(page, {
      title: "author test canvas",
      color: 0xd946ef,
    });

    // navigate back to the narthex
    await navigateBackToNarthex(page);

    // find the canvas-card and check its authorName (stored in the per-widget doc)
    const authorName = await page.evaluate(() => {
      const skein = (window as any).__skein;
      const live = skein.widgetManager.getLiveWidgets();
      for (const [_id, widget] of live.entries()) {
        const entry = (widget as any).entry;
        if (entry?.type === "canvas-card") {
          const doc = (widget as any).widgetDoc;
          if (doc?.current?.authorName !== undefined) {
            return doc.current.authorName;
          }
        }
      }
      return "__no_card__";
    });

    expect(authorName).toBe("alice");
  });

  test("canvas author falls back to empty when social widget has no username", async ({ page }) => {
    // username is already blank on a fresh boot

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
    // open the social overlay so the profile tab mounts and registers __skeinPickAvatar
    await page.evaluate(() => (window as any).__skeinToggleSocial?.());
    await page.waitForTimeout(300);

    // set up file chooser listener BEFORE triggering the pick
    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 });

    // fire pickAvatarFile without awaiting — input.click() happens synchronously
    // so the filechooser event fires before page.evaluate returns
    await page.evaluate(() => {
      (window as any).__skeinPickAvatar?.();
    });

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(__dirname, "fixtures", "freqhole.png"));

    // wait for the image to be processed (resize + WebP encode + doc write)
    await page.waitForFunction(
      () => {
        const url = (window as any).__skeinSocialDoc?.current?.profile?.avatarDataUrl ?? "";
        return url.startsWith("data:image/");
      },
      { timeout: 15_000 }
    );

    const avatarDataUrl = await page.evaluate(
      () => (window as any).__skeinSocialDoc?.current?.profile?.avatarDataUrl ?? ""
    );

    expect(avatarDataUrl).toBeTruthy();
    expect(avatarDataUrl).toMatch(/^data:image\/webp;base64,/);
  });

  test("social widget avatar persists across page reload", async ({ page }) => {
    // open the social overlay and upload an avatar
    await page.evaluate(() => (window as any).__skeinToggleSocial?.());
    await page.waitForTimeout(300);

    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 });
    await page.evaluate(() => {
      (window as any).__skeinPickAvatar?.();
    });
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(__dirname, "fixtures", "freqhole.png"));

    // wait until stored
    await page.waitForFunction(
      () => {
        const url = (window as any).__skeinSocialDoc?.current?.profile?.avatarDataUrl ?? "";
        return url.startsWith("data:image/");
      },
      { timeout: 15_000 }
    );

    const avatarBefore = await page.evaluate(
      () => (window as any).__skeinSocialDoc?.current?.profile?.avatarDataUrl ?? ""
    );
    expect(avatarBefore).toMatch(/^data:image\/webp;base64,/);

    // flush IDB then reload
    await page.waitForTimeout(800);
    await page.reload();
    await waitForNarthex(page);
    await page.waitForTimeout(500);

    const avatarAfter = await page.evaluate(
      () => (window as any).__skeinSocialDoc?.current?.profile?.avatarDataUrl ?? ""
    );

    expect(avatarAfter).toBe(avatarBefore);
  });

  // -------------------------------------------------------------------------
  // profile singleton behavior
  // -------------------------------------------------------------------------

  test("social overlay survives canvas navigate-back", async ({ page }) => {
    // create a canvas and navigate there
    await createCanvasAndWaitForNavigation(page, {
      title: "singleton test canvas",
      color: 0xd946ef,
    });

    // navigate back to the narthex
    await navigateBackToNarthex(page);

    // verify the social doc and toggle are still accessible after re-mount
    const result = await page.evaluate(() => {
      const hasSocialDoc = !!(window as any).__skeinSocialDoc?.current;
      const hasToggle = typeof (window as any).__skeinToggleSocial === "function";
      return { hasSocialDoc, hasToggle };
    });

    expect(result.hasSocialDoc).toBe(true);
    expect(result.hasToggle).toBe(true);
  });

  // -------------------------------------------------------------------------
  // canvas-card preview image
  // -------------------------------------------------------------------------

  test("canvas-card previewUrl can be set and read back", async ({ page }) => {
    // create a canvas so we get a canvas-card
    await createCanvasAndWaitForNavigation(page, {
      title: "preview test canvas",
      color: 0xef4444,
    });
    await navigateBackToNarthex(page);

    // directly set a previewUrl on the canvas-card via its widgetDoc
    const fs = await import("fs");
    const imgBuffer = fs.readFileSync(path.join(__dirname, "fixtures", "freqhole.png"));
    const base64 = imgBuffer.toString("base64");
    const fakeDataUrl = `data:image/png;base64,${base64}`;

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

    // verify it was stored
    const storedUrl = await page.evaluate(() => {
      const skein = (window as any).__skein;
      const live = skein.widgetManager.getLiveWidgets();
      for (const [_id, widget] of live.entries()) {
        const entry = (widget as any).entry;
        if (entry?.type === "canvas-card") {
          const doc = (widget as any).widgetDoc;
          return doc?.current?.previewUrl ?? "";
        }
      }
      return "";
    });

    expect(storedUrl).toBe(fakeDataUrl);
  });
});

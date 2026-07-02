// E2E tests for the profile canvas-bin widget — see
// docs/hub-and-profile-plan.md section 10.2, widgets/narthex/social/canvas-bin.ts.
//
// like profile-canvases.test.ts, this runs against the production app
// (page.goto("/"), not a test harness page) since the widget only mounts
// inside the real social overlay's profile tab, which boot.ts wires with a
// live ProfileStore. all bridge access goes through the typed helpers in
// tests/helpers/skein-bridge.ts.

import { expect, test } from "@playwright/test";
import {
  activateCanvasBinNode,
  addCanvasBinFolder,
  addCurrentCanvasToProfile,
  canvasBinGoBack,
  getCanvasBinCurrentFolderId,
  getCanvasBinVisibleNodes,
  moveCanvasBinNode,
  toggleSocialOverlay,
} from "./helpers/skein-bridge";

// ---------------------------------------------------------------------------
// helpers (mirrors profile-canvases.test.ts's own copies almost verbatim)
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

/** wait until the canvas-bin widget's test hooks are registered (its
 *  CanvasBinStore doc resolves asynchronously after the tab mounts). */
async function waitForCanvasBinReady(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__skeinTest?.social?.canvasBin != null,
    { timeout: 15_000 }
  );
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test.describe("profile view — canvas bin widget", () => {
  // run serially to avoid resource contention (midden wasm + iroh startup is heavy).
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForNarthex(page);
    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);
  });

  test("renders at the bottom of the profile view once mounted", async ({ page }) => {
    await waitForCanvasBinReady(page);
    const nodes = await getCanvasBinVisibleNodes(page);
    // no canvases curated yet — an empty root is still a real, mounted widget
    expect(nodes).toEqual([]);
    expect(await getCanvasBinCurrentFolderId(page)).toBeNull();
  });

  test("shows a curated profile canvas at root and clicking it navigates there", async ({
    page,
  }) => {
    const docId = await createCanvasAndWaitForNavigation(page, {
      title: "bin test canvas",
      color: 0x10b981,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);
    await addCurrentCanvasToProfile(page);

    await waitForCanvasBinReady(page);

    await expect
      .poll(async () => (await getCanvasBinVisibleNodes(page)).length)
      .toBe(1);
    const nodes = await getCanvasBinVisibleNodes(page);
    expect(nodes).toEqual([{ kind: "canvas", id: expect.any(String), canvasDocId: docId }]);
    const nodeId = nodes[0].id;

    // navigate away first so we can prove the click takes us back
    await page.evaluate(() => {
      window.location.hash = "";
    });
    await page.waitForFunction(() => window.location.hash === "" || window.location.hash === "#");

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);
    await waitForCanvasBinReady(page);

    await activateCanvasBinNode(page, nodeId);

    await page.waitForFunction(
      (expected) => window.location.hash.slice(1) === expected,
      docId,
      { timeout: 10_000 }
    );
    expect(await page.evaluate(() => window.location.hash.slice(1))).toBe(docId);
  });

  test("creating a folder and moving a canvas into it — recursive nesting", async ({ page }) => {
    await createCanvasAndWaitForNavigation(page, {
      title: "folder test canvas",
      color: 0x6366f1,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);
    await addCurrentCanvasToProfile(page);

    await waitForCanvasBinReady(page);

    await expect.poll(async () => (await getCanvasBinVisibleNodes(page)).length).toBe(1);

    const folderId = await addCanvasBinFolder(page, "my folder");
    expect(folderId).not.toBe("");

    const rootNodes = await getCanvasBinVisibleNodes(page);
    expect(rootNodes.map((n) => n.kind).sort()).toEqual(["canvas", "folder"]);

    const canvasNode = rootNodes.find((n) => n.kind === "canvas")!;
    const moved = await moveCanvasBinNode(page, canvasNode.id, folderId);
    expect(moved).toBe(true);

    // no longer at root
    const rootAfterMove = await getCanvasBinVisibleNodes(page);
    expect(rootAfterMove).toEqual([
      {
        kind: "folder",
        id: folderId,
        title: "my folder",
        children: [{ kind: "canvas", id: canvasNode.id, canvasDocId: canvasNode.canvasDocId }],
      },
    ]);

    // enter the folder — the canvas is now nested inside it
    await activateCanvasBinNode(page, folderId);
    expect(await getCanvasBinCurrentFolderId(page)).toBe(folderId);
    const childNodes = await getCanvasBinVisibleNodes(page);
    expect(childNodes).toHaveLength(1);
    expect(childNodes[0].id).toBe(canvasNode.id);

    // supports going back up
    await canvasBinGoBack(page);
    expect(await getCanvasBinCurrentFolderId(page)).toBeNull();
  });

  test("removing a canvas from the profile removes it from the bin, wherever filed", async ({
    page,
  }) => {
    const docId = await createCanvasAndWaitForNavigation(page, {
      title: "removable canvas",
      color: 0xef4444,
    });

    await toggleSocialOverlay(page);
    await page.waitForTimeout(300);
    await addCurrentCanvasToProfile(page);

    await waitForCanvasBinReady(page);
    await expect.poll(async () => (await getCanvasBinVisibleNodes(page)).length).toBe(1);

    const folderId = await addCanvasBinFolder(page, "keep");
    const nodeId = (await getCanvasBinVisibleNodes(page)).find((n) => n.kind === "canvas")!.id;
    await moveCanvasBinNode(page, nodeId, folderId);

    await page.evaluate((id) => {
      (window as any).__skeinTest?.social?.profileTab?.removeCanvas?.(id);
    }, docId);

    await activateCanvasBinNode(page, folderId);
    await expect.poll(async () => getCanvasBinVisibleNodes(page)).toEqual([]);

    // the folder itself survives, now empty
    await canvasBinGoBack(page);
    const rootNodes = await getCanvasBinVisibleNodes(page);
    expect(rootNodes).toEqual([{ kind: "folder", id: folderId, title: "keep", children: [] }]);
  });
});

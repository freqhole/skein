/**
 * e2e coverage for docs/narthex-widgets-and-file-transfer-plan.md section 4:
 * "canvas-links: canvas cards + create-new-canvas on any canvas."
 *
 * drives the real production app's `boot.ts` event handlers directly
 * (`skein:create-canvas` / `skein:link-canvas`) rather than simulating pixi
 * pointer clicks on the new `canvas-wizard`/`canvas-link-picker` widgets —
 * this repo has no precedent for simulated pixi pointer-click e2e testing
 * (see skein-testing-notes.md), and both widgets are thin UI shells around
 * these two events (their own "cancel"/"select" handlers just dispatch the
 * same events a real click would).
 */

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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

/** widget count of whichever canvas is currently open (real production app). */
async function getCurrentWidgetCount(page: Page): Promise<number> {
  return page.evaluate(() => Object.keys((window as any).__skein.store.doc().widgets).length);
}

/** all canvas-card widget entries currently on doc `docId`, read directly
 *  off the shared repo — works regardless of which canvas is on-screen. */
async function getCanvasCardsOn(page: Page, docId: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async (id) => {
    const handle = await (window as any).__skein.repo.find(id);
    await handle.whenReady();
    const widgets = Object.values(handle.doc().widgets) as any[];
    return widgets.filter((w) => w.type === "canvas-card").map((w) => w.props);
  }, docId);
}

test.describe("canvas-link and create-canvas work from any canvas", () => {
  test("creating a new canvas from a non-narthex canvas adds its card to that canvas, not the narthex", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForNarthex(page);
    const narthexCountBefore = await getCurrentWidgetCount(page);

    // create canvas A from the narthex (existing, unchanged behavior)
    const docA = await createCanvasAndWaitForNavigation(page, { title: "canvas A", color: 0x111111 });

    // now ON canvas A (non-narthex) — create canvas B from here
    const docB = await createCanvasAndWaitForNavigation(page, { title: "canvas B", color: 0x222222 });
    expect(docB).not.toBe(docA);

    // canvas A must have gained exactly one canvas-card widget, pointing at B
    const cardsOnA = await getCanvasCardsOn(page, docA);
    expect(cardsOnA.length).toBe(1);
    expect(cardsOnA[0].canvasDocId).toBe(docB);

    // the narthex itself must NOT have gained a second card from the B
    // creation — only the earlier, expected A creation.
    await page.evaluate(() => {
      window.location.hash = "";
    });
    await waitForNarthex(page);
    const narthexCountAfter = await getCurrentWidgetCount(page);
    expect(narthexCountAfter).toBe(narthexCountBefore + 1);
  });

  test("linking to an existing canvas adds a card to the currently open canvas, and never to itself", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForNarthex(page);

    const docA = await createCanvasAndWaitForNavigation(page, { title: "canvas A", color: 0x111111 });
    const docB = await createCanvasAndWaitForNavigation(page, { title: "canvas B", color: 0x222222 });
    // currently on canvas B

    const countBeforeLink = await getCurrentWidgetCount(page);

    // link B -> A
    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent("skein:link-canvas", { detail }));
    }, { canvasDocId: docA, title: "canvas A", description: "", previewUrl: "", color: 0x111111 });

    const cardsOnB = await page.evaluate(() =>
      Object.values((window as any).__skein.store.doc().widgets).filter(
        (w: any) => w.type === "canvas-card"
      )
    );
    expect(cardsOnB.length).toBe(1);
    expect((cardsOnB[0] as any).props.canvasDocId).toBe(docA);
    expect(await getCurrentWidgetCount(page)).toBe(countBeforeLink + 1);

    // self-link guard: linking B to itself must be a silent no-op — the
    // handler is fully synchronous (no network/await), so the widget count
    // check right after the evaluate call is deterministic, no polling needed.
    const countBeforeSelfLink = await getCurrentWidgetCount(page);
    await page.evaluate((detail) => {
      window.dispatchEvent(new CustomEvent("skein:link-canvas", { detail }));
    }, { canvasDocId: docB, title: "canvas B", description: "", previewUrl: "", color: 0x222222 });
    expect(await getCurrentWidgetCount(page)).toBe(countBeforeSelfLink);
  });
});

// real end-to-end regression coverage for a user-reported production crash
// (2026-07-03): opening a canvas newly shared with you could throw an
// uncaught "Document ... is unavailable" error, blacking out the whole app.
//
// root cause (see canvas-scoped-share-policy.ts's module doc comment and
// canvas-store.ts's CanvasStore.open() doc comment for the full story): a
// peer receiving a canvas for the very first time can never have a ready
// doc handle for it yet — checking its `.acl` at that moment is a genuine
// circular dependency, not just a race — and automerge-repo's default
// `repo.find()` treats a resulting "unavailable" verdict as terminal,
// rejecting immediately with no automatic retry. the fix spans three
// files: canvas-scoped-share-policy.ts (a not-yet-ready doc gets an
// immediate friend-gate answer instead of a deny), canvas-store.ts
// (CanvasStore.open() waits out a transient unavailable via automerge-
// repo's own event-driven whenReady(), not a hand-rolled timeout loop),
// and boot.ts (navigateToCanvas() catches a genuine final failure and
// falls back to the narthex instead of leaving nothing mounted).
//
// deliberately uses two real production-app pages (page.goto("/"), real
// standalone/boot.ts wiring, real friendz protocol, real hash-based
// navigation via SkeinRouter) rather than the p2p-test-bootstrap.ts /
// joinCanvasForTest() fixture other specs use — that fixture never
// exercised navigateToCanvas() at all (it calls initCanvas() directly),
// and its own retry loop (now removed) was silently masking this exact
// failure, which is why no existing e2e test ever caught it.
//
// run with: npx playwright test tests/canvas-first-open-crash.spec.ts --workers=1

import { test, expect, type Page } from "@playwright/test";
import {
  acceptCanvasInviteViaEvent,
  ensureIdentityBridge,
  getMessagezInvites,
  getSharePendingInvites,
  inviteFriendViaShareDialog,
  openShareDialog,
  waitForShareHooks,
} from "./helpers/skein-bridge";

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

/** dispatch skein:create-canvas and wait for hash navigation to the new canvas. */
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

test.describe("opening a canvas newly shared with you (crash regression) @hub", () => {
  test.setTimeout(120_000);

  test("peer B opens a brand-new shared canvas via real hash navigation without crashing", async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const pageErrorsA: string[] = [];
    const pageErrorsB: string[] = [];
    pageA.on("pageerror", (err) => pageErrorsA.push(String(err)));
    pageB.on("pageerror", (err) => pageErrorsB.push(String(err)));

    await pageA.goto("/");
    await pageB.goto("/");
    await waitForNarthex(pageA);
    await waitForNarthex(pageB);

    const nodeIdA = await ensureIdentityBridge(pageA);
    const nodeIdB = await ensureIdentityBridge(pageB);

    // establish mutual friendship — both sides send a request so each
    // side's onFriendRequest handler sees a reciprocal pending outbound
    // and auto-accepts (mirrors two real users each clicking "add friend"
    // on the other), and (per the profile-doc sync fix) each side grants
    // the other viewer access to its own profile doc as a side effect.
    await pageA.evaluate(
      (id) => (window as any).__skeinTest.social.sendFriendRequestTo(id),
      nodeIdB
    );
    await pageB.evaluate(
      (id) => (window as any).__skeinTest.social.sendFriendRequestTo(id),
      nodeIdA
    );

    await expect
      .poll(
        () =>
          pageA.evaluate(
            (id) =>
              ((window as any).__skeinTest?.social?.doc?.current?.friends ?? []).some((f: any) =>
                f.nodeIds?.some((n: any) => n.nodeId === id)
              ),
            nodeIdB
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          pageB.evaluate(
            (id) =>
              ((window as any).__skeinTest?.social?.doc?.current?.friends ?? []).some((f: any) =>
                f.nodeIds?.some((n: any) => n.nodeId === id)
              ),
            nodeIdA
          ),
        { timeout: 30_000 }
      )
      .toBe(true);

    // A creates a brand-new canvas — B has never seen this document id
    // before, so opening it is B's very first sync of this doc, exactly
    // the scenario the crash happened in.
    const docId = await createCanvasAndWaitForNavigation(pageA, {
      title: "first-open crash regression canvas",
      color: 0xef4444,
    });

    await openShareDialog(pageA);
    await waitForShareHooks(pageA);
    await inviteFriendViaShareDialog(pageA, nodeIdB, "member");
    await expect
      .poll(async () => (await getSharePendingInvites(pageA)).some((p) => p.targetNodeId === nodeIdB))
      .toBe(true);

    // wait for the real, network-delivered canvas-invite message to land
    // in B's inbox (not a synthetic seed) before accepting it.
    await expect
      .poll(async () => (await getMessagezInvites(pageB)).some((i) => i.canvasDocId === docId))
      .toBe(true);
    const invite = (await getMessagezInvites(pageB)).find((i) => i.canvasDocId === docId)!;

    // B accepts — this only creates the narthex canvas-card, it does not
    // navigate yet (mirrors real production behavior: the user still has
    // to actually open the card).
    await acceptCanvasInviteViaEvent(pageB, {
      canvasDocId: invite.canvasDocId as string,
      fromNodeId: invite.fromNodeId as string,
      canvasTitle: (invite as any).canvasTitle ?? "",
      canvasDescription: (invite as any).canvasDescription ?? "",
      canvasColor: (invite as any).canvasColor ?? 0,
      canvasPreviewUrl: (invite as any).canvasPreviewUrl ?? "",
      fromUsername: (invite as any).fromUsername ?? "",
      relayedBy: (invite as any).relayedBy ?? "",
      role: (invite as any).role ?? "member",
    });

    // B navigates to the shared canvas via a real hash change — exactly
    // what clicking the narthex canvas-card does — exercising the real
    // SkeinRouter.onHashChange() -> navigateToCanvas() ->
    // CanvasStore.open() -> canvas-scoped-share-policy.ts chain end to end.
    await pageB.evaluate((id) => {
      window.location.hash = id;
    }, docId);

    // the real regression: before the fix, this either hung forever behind
    // an uncaught rejection or (once automerge-repo's own retry gave up)
    // threw, tearing down the previous canvas and leaving nothing mounted
    // — a real, user-reported "everything turns black" crash.
    await expect
      .poll(() => pageB.evaluate(() => (window as any).__skein?.store?.handle?.documentId ?? null), {
        timeout: 30_000,
      })
      .toBe(docId);

    // the app must still be a real, rendering canvas — not the top-level
    // boot-error fallback state (boot.ts's `boot().catch()` sets this class
    // when literally nothing else could recover).
    expect(
      await pageB.evaluate(() => document.getElementById("canvas-root")?.className ?? "")
    ).not.toContain("boot-error");

    // real widgets are actually mounted (proves the doc synced real
    // content, not just an empty/unavailable placeholder).
    await expect
      .poll(() => pageB.evaluate(() => (window as any).__skein?.widgetManager?.getLiveWidgets()?.size ?? -1))
      .toBeGreaterThanOrEqual(0);

    expect(pageErrorsA).toEqual([]);
    expect(pageErrorsB).toEqual([]);

    await contextA.close();
    await contextB.close();
  });
});

/**
 * real end-to-end coverage of "invite a real reliquary hub to a canvas via
 * the share dialog, hub auto-accepts, hub shows up as a shared peer" — a
 * real user-reported bug, 2026-07-02: "the hub node peer disappears from
 * the list once it accepts the share invite" (and, per follow-up, it never
 * comes back even after closing/reopening the share dialog — ruling out a
 * stale-snapshot/refresh theory).
 *
 * this combines two previously-separate test patterns for the first time:
 * - the production app (`page.goto("/")`, real `standalone/boot.ts` wiring,
 *   real social doc / share dialog) that `profile-canvases.test.ts`,
 *   `friend-canvas-bin.test.ts` etc. use
 * - a real `reliquary serve` process (`startReliquaryHub()`) that
 *   `blob-sync.spec.ts`/`friendz-hub.spec.ts` use, but only against the
 *   stripped-down `test-harness-p2p.html` page (no real social doc/share
 *   dialog there at all)
 *
 * establishing real friendship between the production app and the hub
 * needed a new bridge (`window.__skeinTest.social.sendFriendRequestTo`,
 * see `standalone/boot.ts`) — the existing `window.__skeinTest.friendz`
 * bridge only exists on the p2p harness, with its own throwaway
 * `FriendzProtocol` instance untied to any social doc.
 *
 * tag: @hub
 * run with: npx playwright test tests/canvas-share-hub.spec.ts --workers=1
 */

import { test, expect, type Page } from "@playwright/test";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";
import {
  ensureIdentityBridge,
  sendFriendRequestToBridge,
  openShareDialog,
  waitForShareHooks,
  getFriendsForInvite,
  getSharePendingInvites,
  inviteFriendViaShareDialog,
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

/** dispatch skein:create-canvas and wait for hash navigation, mirrors the
 *  same helper other e2e files in this repo each define locally. */
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

/** poll `window.__skein.store.peers()` (the canvas doc's real `.peers`
 *  map, not a share-dialog snapshot) until it contains `nodeId`. */
async function waitForCanvasPeer(page: Page, nodeId: string, timeoutMs = 45_000): Promise<void> {
  await page.waitForFunction(
    (id) => Object.keys((window as any).__skein.store.peers()).includes(id),
    nodeId,
    { timeout: timeoutMs }
  );
}

test.describe("share a canvas with a real reliquary hub @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("a hub friend invited to a canvas ends up in the 'shared with' peer list, not stuck or vanished", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    hub = await startReliquaryHub();

    await page.goto("/");
    await waitForNarthex(page);
    const myNodeId = await ensureIdentityBridge(page);

    // pre-approve so the hub auto-accepts the browser's friend request.
    await hub.friendAllow(myNodeId);
    await sendFriendRequestToBridge(page, hub.nodeId);

    // wait for the real friend-accept round trip to land in the social doc
    // (written by wireFriendHandlers' onFriendAccept, not a synthetic seed).
    await expect
      .poll(
        async () =>
          page.evaluate(
            (hubId) =>
              ((window as any).__skeinTest?.social?.doc?.current?.friends ?? []).some((f: any) =>
                f.nodeIds?.some((n: any) => n.nodeId === hubId)
              ),
            hub.nodeId
          ),
        { timeout: 30_000 }
      )
      .toBe(true);

    const docId = await createCanvasAndWaitForNavigation(page, {
      title: "share with hub test",
      color: 0x10b981,
    });

    await openShareDialog(page);
    await waitForShareHooks(page);

    // the hub must show up as an invitable hub friend before we can invite it.
    await expect
      .poll(async () => (await getFriendsForInvite(page)).some((f) => f.nodeId === hub.nodeId))
      .toBe(true);
    const hubFriend = (await getFriendsForInvite(page)).find((f) => f.nodeId === hub.nodeId);
    expect(hubFriend?.isHub).toBe(true);

    await inviteFriendViaShareDialog(page, hub.nodeId, "member");

    // the invite should be recorded as pending immediately.
    await expect
      .poll(async () => (await getSharePendingInvites(page)).some((p) => p.targetNodeId === hub.nodeId))
      .toBe(true);

    // the hub should auto-accept (it's a friend) and write itself into the
    // canvas doc's real .peers map — this is the crux of the reported bug:
    // does the hub actually show up as a shared peer, or does it vanish?
    await waitForCanvasPeer(page, hub.nodeId);

    // once it's a peer, the pending invite for it must be gone (it moved
    // from "pending" to "shared with", not lingering in both or neither).
    await expect
      .poll(async () => (await getSharePendingInvites(page)).some((p) => p.targetNodeId === hub.nodeId))
      .toBe(false);

    // re-open the dialog fresh (mirrors the user's own "close/reopen"
    // check) — the hub must still show up as a peer, not have vanished.
    await page.evaluate(() => (window as any).__skeinTest?.share?.closeShareDialog?.());
    await openShareDialog(page);
    await waitForShareHooks(page);
    const peersAfterReopen = await page.evaluate(() =>
      Object.keys((window as any).__skein.store.peers())
    );
    expect(peersAfterReopen).toContain(hub.nodeId);

    // sanity: it's genuinely the hub's own canvas doc that got shared, not
    // some other artifact — confirm the hub's own logs show it processing
    // this exact canvas id.
    expect(hub.getLog()).toContain(docId);
  });

  test("a hub restarted mid-flight (before it finishes writing itself into a canvas's peers) resumes and completes on the next run", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    hub = await startReliquaryHub();
    const dataDir = hub.dataDir;

    await page.goto("/");
    await waitForNarthex(page);
    const myNodeId = await ensureIdentityBridge(page);

    await hub.friendAllow(myNodeId);
    await sendFriendRequestToBridge(page, hub.nodeId);
    await expect
      .poll(
        async () =>
          page.evaluate(
            (hubId) =>
              ((window as any).__skeinTest?.social?.doc?.current?.friends ?? []).some((f: any) =>
                f.nodeIds?.some((n: any) => n.nodeId === hubId)
              ),
            hub.nodeId
          ),
        { timeout: 30_000 }
      )
      .toBe(true);

    await createCanvasAndWaitForNavigation(page, {
      title: "restart mid-flight test",
      color: 0x6366f1,
    });

    await openShareDialog(page);
    await waitForShareHooks(page);
    await expect
      .poll(async () => (await getFriendsForInvite(page)).some((f) => f.nodeId === hub.nodeId))
      .toBe(true);

    await inviteFriendViaShareDialog(page, hub.nodeId, "member");

    // kill the hub almost immediately — well before its background
    // peer-write retry loop (schedule_write_self_to_canvas, up to ~30s of
    // retries) has any real chance to finish, simulating a restart
    // interrupting it mid-flight. preserve its data dir so the restarted
    // process resumes with the same identity/tracked-canvases state.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await hub.stop({ preserveDataDir: true });

    // the peer-write definitely didn't complete before the kill — proves
    // the restart below is actually exercising the resume path, not just
    // re-confirming an already-finished write.
    expect(
      await page.evaluate(() => Object.keys((window as any).__skein.store.peers()))
    ).not.toContain(hub.nodeId);

    hub = await startReliquaryHub({ dataDir });

    await waitForCanvasPeer(page, hub.nodeId);
  });
});

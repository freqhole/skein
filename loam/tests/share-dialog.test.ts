// e2e tests for the canvas share dialog's invite/cancel wiring and hub
// grouping — src/canvas/share-dialog.ts had zero test coverage anywhere in
// the repo before this file (confirmed via search).
//
// runs against the full production app (index.html / boot.ts), since the
// invite/cancel logic under test lives entirely in boot.ts's `onShare`
// handler (the closures passed to showShareDialog()) — the lighter
// test-harness.html bootstrap never wires a toolbar/social/messagez doc set
// at all, so it can't drive this flow.
//
// the share dialog is built fresh every time the toolbar's share button is
// pressed (not a persistently-mounted widget like messagez/friends-tab), so
// there's no single "on mount" test-hook registration point to reuse — see
// src/dev/test-bridge.ts's ShareTestHooks doc comment. these tests drive the
// dialog's real `onInviteFriend`/`onCancelInvite` closures directly through
// that bridge (not simulated pixi pointer clicks — this repo has no
// precedent for that), and read invite state straight from the canvas doc /
// messagez outbox rather than inspecting rendered rows.
//
// the "which section does a friend render in" question (regular "invite
// friends" vs "hub nodes") is decided by a small pure function,
// `splitFriendsForInvite()`, exhaustively unit-tested in the co-located
// src/canvas/share-dialog.test.ts. this file's hub-grouping test proves the
// other half: that boot.ts's real friendsForInvite pipeline (reading the
// live social doc) correctly carries each friend's `isHub` flag through to
// what the dialog receives — the two together prove the full "hub friend
// ends up in the hub section" behavior without needing to import pixi/DOM
// code into a node-side test file.
//
// run with: npx playwright test tests/share-dialog.test.ts --workers=1

import { expect, test, type Page } from "@playwright/test";
import {
  cancelInviteViaShareDialog,
  ensureIdentityBridge,
  getFriendsForInvite,
  getSharePendingInvites,
  getShareMessagezShares,
  inviteFriendViaShareDialog,
  openShareDialog,
  waitForShareHooks,
} from "./helpers/skein-bridge";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** wait for the app (narthex or a real canvas) to be booted and rendering. */
async function waitForAppReady(page: Page): Promise<void> {
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

/** wait until the current canvas's toolbar has a real share button mounted
 *  (the creator is the canvas admin, and identity is resolved). */
async function waitForShareButton(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__skein?.toolbar?.shareBtn != null, {
    timeout: 15_000,
  });
}

/** seed a friend directly on the standalone social doc, returning its id —
 *  same shape/pattern as friends-tab-hub-profile.spec.ts's seedFriend(). */
async function seedFriend(
  page: Page,
  opts: { nodeId: string; alias: string; isHub: boolean }
): Promise<string> {
  return page.evaluate((o) => {
    const id = crypto.randomUUID();
    (window as any).__skeinTest.social.doc.change((d: any) => {
      d.friends.push({
        id,
        alias: o.alias,
        username: "",
        group: "",
        nodeIds: [
          {
            nodeId: o.nodeId,
            addedAt: new Date().toISOString(),
            lastSeenAt: "",
            username: "",
            bio: "",
            avatarDataUrl: "",
          },
        ],
        createdAt: new Date().toISOString(),
        isHub: o.isHub,
      });
    });
    return id;
  }, opts);
}

/** boot the app, generate an identity, create a fresh canvas (the identity
 *  becomes its admin), and wait for the share button. returns the new
 *  canvas's doc id. */
async function setup(page: Page, title: string): Promise<string> {
  await page.goto("/");
  await waitForAppReady(page);
  await ensureIdentityBridge(page);
  const canvasDocId = await createCanvasAndWaitForNavigation(page, {
    title,
    color: 0x6366f1,
  });
  await waitForShareButton(page);
  return canvasDocId;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test.describe("share dialog", () => {
  // run serially to avoid resource contention (midden wasm + iroh startup is
  // heavy) — same reasoning image-and-profile.test.ts/knock-ui.test.ts document.
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("cancelling a pending invite makes the friend eligible for a fresh invite (bug fix)", async ({
    page,
  }) => {
    await setup(page, "invite cancel test canvas");

    const friendNodeId = "c".repeat(64);
    await seedFriend(page, { nodeId: friendNodeId, alias: "invitee", isHub: false });

    // open the dialog for the first time — populates window.__skeinTest.share
    await openShareDialog(page);
    await waitForShareHooks(page);

    // sanity: the friend starts out eligible for invite
    await expect
      .poll(async () => (await getFriendsForInvite(page)).map((f) => f.nodeId))
      .toContain(friendNodeId);

    // invite them — calls the dialog's real onInviteFriend closure
    await inviteFriendViaShareDialog(page, friendNodeId, "member");

    // canvas doc gets a pending invite entry
    await expect
      .poll(async () => (await getSharePendingInvites(page)).map((e) => e.targetNodeId))
      .toContain(friendNodeId);

    // messagez outbox gets a non-cancelled, non-declined share entry
    await expect.poll(async () => {
      const shares = await getShareMessagezShares(page);
      return shares.find((s) => s.toNodeId === friendNodeId) ?? null;
    }).not.toBeNull();
    const shareAfterInvite = (await getShareMessagezShares(page)).find(
      (s) => s.toNodeId === friendNodeId
    );
    expect(shareAfterInvite?.cancelled).toBeFalsy();
    expect(shareAfterInvite?.declined).toBeFalsy();

    // re-opening the dialog now excludes the already-invited friend
    await openShareDialog(page);
    await expect
      .poll(async () => (await getFriendsForInvite(page)).some((f) => f.nodeId === friendNodeId))
      .toBe(false);

    // cancel the pending invite — calls the dialog's real onCancelInvite closure
    await cancelInviteViaShareDialog(page, friendNodeId);

    // canvas doc's pending invite is gone
    await expect
      .poll(async () => (await getSharePendingInvites(page)).map((e) => e.targetNodeId))
      .not.toContain(friendNodeId);

    // messagez outbox entry is marked cancelled, not deleted
    await expect.poll(async () => {
      const shares = await getShareMessagezShares(page);
      return shares.find((s) => s.toNodeId === friendNodeId)?.cancelled ?? null;
    }).toBe(true);

    // the actual bug fix: re-opening the dialog shows the friend as
    // eligible for invite again, instead of being permanently excluded.
    await openShareDialog(page);
    await expect
      .poll(async () => (await getFriendsForInvite(page)).map((f) => f.nodeId))
      .toContain(friendNodeId);
  });

  test("a hub friend and a non-hub friend carry the correct isHub flag into the invite list", async ({
    page,
  }) => {
    await setup(page, "hub grouping test canvas");

    const hubNodeId = "d".repeat(64);
    const regularNodeId = "e".repeat(64);
    await seedFriend(page, { nodeId: hubNodeId, alias: "hub node friend", isHub: true });
    await seedFriend(page, { nodeId: regularNodeId, alias: "regular friend", isHub: false });

    await openShareDialog(page);
    await waitForShareHooks(page);

    await expect
      .poll(async () => (await getFriendsForInvite(page)).map((f) => f.nodeId))
      .toEqual(expect.arrayContaining([hubNodeId, regularNodeId]));

    const friends = await getFriendsForInvite(page);
    const hubEntry = friends.find((f) => f.nodeId === hubNodeId);
    const regularEntry = friends.find((f) => f.nodeId === regularNodeId);

    // this is the data splitFriendsForInvite() (share-dialog.test.ts) groups
    // into sections — a hub friend must carry isHub: true and a regular
    // friend must not, so each lands in exactly one of the two sections.
    expect(hubEntry?.isHub).toBe(true);
    expect(regularEntry?.isHub).toBeFalsy();
  });
});

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
  getShareFriendRowText,
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

  test("share dialog live-refreshes without needing a manual close/reopen (bug fix)", async ({
    page,
  }) => {
    // real user report this covers: inviting a friend (or any other canvas-
    // doc/messagez change) while the share dialog is already open never
    // showed up until the user closed and reopened the panel \u2014 boot.ts's
    // onShare handler built a one-time snapshot with no live subscription.
    await setup(page, "live refresh test canvas");

    const friendNodeId = "d".repeat(64);
    await seedFriend(page, { nodeId: friendNodeId, alias: "liverefresh", isHub: false });

    // open the dialog once and leave it open for the rest of this test \u2014
    // no second openShareDialog() call, unlike the bug-fix test above which
    // explicitly reopens to prove the *old* (pre-fix) re-open behavior.
    await openShareDialog(page);
    await waitForShareHooks(page);

    // the friend starts out rendered in the "invite friends" list.
    await expect.poll(() => getShareFriendRowText(page, friendNodeId)).toBe("liverefresh");

    // invite them \u2014 mutates the canvas doc (pendingInvites) and the
    // messagez outbox, exactly as a real invite click would. the dialog is
    // NEVER reopened after this.
    await inviteFriendViaShareDialog(page, friendNodeId, "member");

    // the already-open dialog should live-rebuild and drop the now-invited
    // friend from its rendered "invite friends" rows on its own \u2014 before
    // the fix, this row stayed rendered forever until a manual reopen.
    await expect.poll(() => getShareFriendRowText(page, friendNodeId)).toBeNull();

    // cancelling the invite (still without ever reopening the dialog)
    // should live-rebuild it back to showing the friend as invitable again.
    await cancelInviteViaShareDialog(page, friendNodeId);
    await expect.poll(() => getShareFriendRowText(page, friendNodeId)).toBe("liverefresh");
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

  test("a peer with only a pending inbound or outbound friend request never disappears from the invite list (section 10.1)", async ({
    page,
  }) => {
    await setup(page, "pending relationship test canvas");

    const inboundNodeId = "f".repeat(64);
    const outboundNodeId = "1".repeat(64);

    // seed a still-pending inbound request (they friended us, we haven't
    // acted) and a still-pending outbound request (we friended them, no
    // reply yet) — neither is in `friends`, so before this fix neither
    // would ever appear anywhere in the share dialog.
    await page.evaluate(
      ({ inboundNodeId, outboundNodeId }) => {
        (window as any).__skeinTest.social.doc.change((d: any) => {
          if (!d.pendingRequests) d.pendingRequests = [];
          d.pendingRequests.push({
            fromNodeId: inboundNodeId,
            fromUsername: "inbound-requester",
            receivedAt: new Date().toISOString(),
            status: "pending",
          });
          if (!d.outboundRequests) d.outboundRequests = [];
          d.outboundRequests.push({
            toNodeId: outboundNodeId,
            toUsername: "outbound-target",
            sentAt: new Date().toISOString(),
            status: "pending",
          });
        });
      },
      { inboundNodeId, outboundNodeId }
    );

    await openShareDialog(page);
    await waitForShareHooks(page);

    await expect
      .poll(async () => (await getFriendsForInvite(page)).map((f) => f.nodeId))
      .toEqual(expect.arrayContaining([inboundNodeId, outboundNodeId]));

    const friends = await getFriendsForInvite(page);
    const inboundEntry = friends.find((f) => f.nodeId === inboundNodeId);
    const outboundEntry = friends.find((f) => f.nodeId === outboundNodeId);

    // both must be marked pending (not a confirmed friend yet) — the UI
    // shows this honestly rather than pretending they're a real friend.
    expect(inboundEntry?.isPending).toBe(true);
    expect(outboundEntry?.isPending).toBe(true);
    // isHub is unknowable for an unconfirmed relationship — must default
    // false, never guessed true.
    expect(inboundEntry?.isHub).toBeFalsy();
    expect(outboundEntry?.isHub).toBeFalsy();
  });

  test("the hub-nodes section renders the actual node-id-derived row for a hub friend, not just correct isHub data", async ({
    page,
  }) => {
    await setup(page, "hub node id rendering test canvas");

    // no alias/username set, so buildFriendInviteRow() falls back to a
    // node-id-derived label (friend.nodeId.slice(0, 12) + "...") — a
    // distinguishable prefix (not a uniform-character id) proves the
    // rendered row text is really derived from *this* friend's node id, not
    // another row's or a placeholder (docs/hub-and-profile-plan.md section
    // 10.3).
    const hubNodeId = "cafef00d" + "3".repeat(56);
    const regularNodeId = "b".repeat(64);
    await seedFriend(page, { nodeId: hubNodeId, alias: "", isHub: true });
    await seedFriend(page, { nodeId: regularNodeId, alias: "", isHub: false });

    await openShareDialog(page);
    await waitForShareHooks(page);

    await expect
      .poll(async () => (await getFriendsForInvite(page)).map((f) => f.nodeId))
      .toEqual(expect.arrayContaining([hubNodeId, regularNodeId]));

    const hubRowText = await getShareFriendRowText(page, hubNodeId);
    expect(hubRowText).not.toBeNull();
    expect(hubRowText).toBe(hubNodeId.slice(0, 12) + "...");
    // not another row's content, and not the full raw node id (proves the
    // renderer's own truncation, not something a test computed itself).
    expect(hubRowText).not.toBe(regularNodeId.slice(0, 12) + "...");
    expect(hubRowText).not.toBe(hubNodeId);

    const regularRowText = await getShareFriendRowText(page, regularNodeId);
    expect(regularRowText).toBe(regularNodeId.slice(0, 12) + "...");

    // a node id that was never rendered (not seeded) has no row at all.
    expect(await getShareFriendRowText(page, "9".repeat(64))).toBeNull();
  });

  test("accepting a canvas invite durably records acceptance even when the original inviter is unreachable (bug fix)", async ({
    page,
  }) => {
    // real user report this covers: a hub-relayed invite's "pending" state
    // in the share dialog never flipped to "accepted", staying pending
    // forever. root cause: acceptCanvasInvite() (boot.ts) only ever sent a
    // live wire "canvas-invite-accept" message straight to the original
    // inviter and never durably wrote acceptance into the shared canvas
    // doc itself \u2014 so if that inviter was offline (exactly the case a
    // hub relay exists to handle), the accept vanished with nothing to
    // show for it, even after the target came back online later.
    const canvasDocId = await setup(page, "accept-durable test canvas");
    const identity = await page.evaluate(async () => {
      const social = (window as any).__skeinTest?.social;
      return (await social.ensureIdentity()).node_id as string;
    });

    // a node id that will never be dialable in this test (no such peer
    // exists) — stands in for "the original inviter is offline".
    const unreachableInviter = "e".repeat(64);

    // seed a pending invite for ourselves, as if an (offline/unreachable)
    // peer had invited us to this very canvas \u2014 lets the test exercise
    // acceptCanvasInvite()'s real logic without needing a second real,
    // connected browser peer just to originate the invite.
    await page.evaluate(
      ({ selfId, inviter }) => {
        (window as any).__skein.store.addPendingInvite(selfId, {
          invitedBy: inviter,
          invitedByUsername: "ghost",
          role: "member",
          invitedAt: new Date().toISOString(),
        });
      },
      { selfId: identity, inviter: unreachableInviter }
    );

    // dispatch the real accept event, exactly as messagez-widget.ts's
    // "accept" button does, with fromNodeId pointing at the unreachable
    // peer and no relaying hub.
    await page.evaluate(
      ({ canvasDocId, inviter }) => {
        window.dispatchEvent(
          new CustomEvent("skein:accept-canvas-invite", {
            detail: {
              canvasDocId,
              fromNodeId: inviter,
              canvasTitle: "accept-durable test canvas",
              canvasDescription: "",
              canvasColor: 0,
              canvasPreviewUrl: "",
              fromUsername: "ghost",
              relayedBy: "",
            },
          })
        );
      },
      { canvasDocId, inviter: unreachableInviter }
    );

    // the fix: acceptance gets durably recorded on the canvas doc itself
    // (via CanvasStore.open + markInviteAccepted), independent of whether
    // the live wire message to the (unreachable) inviter ever landed.
    await expect
      .poll(async () =>
        page.evaluate(
          (selfId) => (window as any).__skein.store.pendingInvites()[selfId]?.accepted ?? null,
          identity
        )
      )
      .toBe(true);
  });
});

// e2e coverage for wiring hub-profile-panel.ts into friends-tab.ts's
// friend-detail view — docs/hub-and-profile-plan.md section 5/8 step 7.
//
// friends-tab.ts renders entirely on a pixi canvas with no existing
// precedent in this repo for driving it via simulated pointer clicks (see
// hub-profile-panel.spec.ts's own coverage note). instead these tests drive
// the tab's real internal handlers directly through
// window.__skeinTest.social.friendsTab (registered by friends-tab.ts itself
// via registerSocialBridge(), same pattern profile-tab.ts already uses for
// pickAvatar) — this proves the real wiring (view-mode transitions, the
// "manage hub" action's visibility, and the panel's own real hub-admin
// fetch), just not literal mouse clicks on canvas pixels.
//
// friends are seeded directly on the standalone social doc via
// window.__skeinTest.social.doc.change(), mirroring
// image-and-profile.test.ts's own seeding pattern.

import { expect, test } from "@playwright/test";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";
import { ensureIdentityBridge, toggleSocialOverlay } from "./helpers/skein-bridge";

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

/** wait until window.__skeinTest.social.friendsTab is registered (friends-tab.ts has mounted). */
async function waitForFriendsTabHooks(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__skeinTest?.social?.friendsTab != null,
    { timeout: 15_000 }
  );
}

/** seed a friend directly on the standalone social doc, returning its id. */
async function seedFriend(
  page: import("@playwright/test").Page,
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

function friendsTabHooks(page: import("@playwright/test").Page) {
  return {
    getViewMode: () => page.evaluate(() => (window as any).__skeinTest.social.friendsTab.getViewMode()),
    openFriendDetail: (friendId: string) =>
      page.evaluate((id) => (window as any).__skeinTest.social.friendsTab.openFriendDetail(id), friendId),
    closeFriendDetail: () =>
      page.evaluate(() => (window as any).__skeinTest.social.friendsTab.closeFriendDetail()),
    hasManageHubAction: () =>
      page.evaluate(() => (window as any).__skeinTest.social.friendsTab.hasManageHubAction()),
    openHubProfilePanel: () =>
      page.evaluate(() => (window as any).__skeinTest.social.friendsTab.openHubProfilePanel()),
    closeHubProfilePanel: () =>
      page.evaluate(() => (window as any).__skeinTest.social.friendsTab.closeHubProfilePanel()),
    isHubProfilePanelOpen: () =>
      page.evaluate(() => (window as any).__skeinTest.social.friendsTab.isHubProfilePanelOpen()),
    getHubProfilePanelState: () =>
      page.evaluate(() => (window as any).__skeinTest.social.friendsTab.getHubProfilePanelState()),
    refreshHubProfilePanel: () =>
      page.evaluate(() => (window as any).__skeinTest.social.friendsTab.refreshHubProfilePanel()),
    getFriendDetailNodeIdText: () =>
      page.evaluate(() => (window as any).__skeinTest.social.friendsTab.getFriendDetailNodeIdText()),
    getHubProfileAllowInputGlobalPos: () =>
      page.evaluate(() =>
        (window as any).__skeinTest.social.friendsTab.getHubProfileAllowInputGlobalPos()
      ),
    getHubProfileAllowButtonGlobalPos: () =>
      page.evaluate(() =>
        (window as any).__skeinTest.social.friendsTab.getHubProfileAllowButtonGlobalPos()
      ),
    getHubProfileRemoveButtonGlobalPos: (nodeId: string) =>
      page.evaluate(
        (id) => (window as any).__skeinTest.social.friendsTab.getHubProfileRemoveButtonGlobalPos(id),
        nodeId
      ),
  };
}

test.describe("friends-tab hub-profile-panel wiring", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForNarthex(page);
    await toggleSocialOverlay(page);
    await waitForFriendsTabHooks(page);
  });

  test("a hub friend's detail view shows the manage-hub action, a non-hub friend's does not", async ({
    page,
  }) => {
    const hooks = friendsTabHooks(page);

    const hubFriendId = await seedFriend(page, {
      nodeId: "a".repeat(64),
      alias: "hub friend",
      isHub: true,
    });
    const normalFriendId = await seedFriend(page, {
      nodeId: "b".repeat(64),
      alias: "normal friend",
      isHub: false,
    });

    await hooks.openFriendDetail(hubFriendId);
    expect(await hooks.getViewMode()).toBe("detail");
    expect(await hooks.hasManageHubAction()).toBe(true);

    await hooks.closeFriendDetail();
    expect(await hooks.getViewMode()).toBe("list");

    await hooks.openFriendDetail(normalFriendId);
    expect(await hooks.getViewMode()).toBe("detail");
    expect(await hooks.hasManageHubAction()).toBe(false);
  });

  test("opening the manage-hub action mounts the panel; closing returns to the detail view", async ({
    page,
  }) => {
    const hooks = friendsTabHooks(page);

    const hubFriendId = await seedFriend(page, {
      nodeId: "c".repeat(64),
      alias: "another hub friend",
      isHub: true,
    });

    await hooks.openFriendDetail(hubFriendId);
    expect(await hooks.isHubProfilePanelOpen()).toBe(false);

    await hooks.openHubProfilePanel();
    expect(await hooks.getViewMode()).toBe("hubProfile");
    expect(await hooks.isHubProfilePanelOpen()).toBe(true);

    // the panel mounted for real and has some render state (even before a
    // real hub responds, it starts as "loading" and settles to "error" for
    // an unreachable made-up node id — either way, proof it's really mounted
    // and driving hub-admin-client.ts, not just a visibility flag).
    await expect
      .poll(async () => (await hooks.getHubProfilePanelState())?.status, { timeout: 10_000 })
      .not.toBeUndefined();

    await hooks.closeHubProfilePanel();
    expect(await hooks.getViewMode()).toBe("detail");
    expect(await hooks.isHubProfilePanelOpen()).toBe(false);
    // still on the same friend's detail view, not bounced back to the list
    expect(await hooks.hasManageHubAction()).toBe(true);
  });

  test("the manage-hub action does not appear for a friend that stops being selected", async ({
    page,
  }) => {
    const hooks = friendsTabHooks(page);

    const normalFriendId = await seedFriend(page, {
      nodeId: "d".repeat(64),
      alias: "yet another normal friend",
      isHub: false,
    });

    expect(await hooks.hasManageHubAction()).toBe(false);

    await hooks.openFriendDetail(normalFriendId);
    expect(await hooks.hasManageHubAction()).toBe(false);

    await hooks.closeFriendDetail();
    expect(await hooks.hasManageHubAction()).toBe(false);
  });

  test("a hub friend's detail view renders their actual node id; a non-hub friend's shows none", async ({
    page,
  }) => {
    const hooks = friendsTabHooks(page);

    // deliberately not a uniform-character node id (e.g. "a".repeat(64)) —
    // a distinguishable prefix proves the rendered text is really derived
    // from this friend's actual nodeId, not a placeholder or another row's.
    const hubNodeId = "deadbeef" + "9".repeat(56);
    const hubFriendId = await seedFriend(page, {
      nodeId: hubNodeId,
      alias: "hub with visible node id",
      isHub: true,
    });
    const normalFriendId = await seedFriend(page, {
      nodeId: "f".repeat(64),
      alias: "normal friend",
      isHub: false,
    });

    await hooks.openFriendDetail(hubFriendId);
    const nodeIdText = await hooks.getFriendDetailNodeIdText();
    expect(nodeIdText).not.toBeNull();
    // not truncated to the point of being wrong/useless — a real, long
    // enough prefix of the actual node id, not just the first few chars.
    expect(nodeIdText!.startsWith(hubNodeId.slice(0, 40))).toBe(true);
    expect(nodeIdText).not.toBe(hubNodeId.slice(0, 4));

    await hooks.closeFriendDetail();

    // a non-hub friend's detail view has no hub node id to show at all.
    await hooks.openFriendDetail(normalFriendId);
    expect(await hooks.getFriendDetailNodeIdText()).toBeNull();
  });
});

test.describe("friends-tab hub-profile-panel wiring @hub", () => {
  test.setTimeout(90_000);

  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("manage-hub panel reaches a real hub over iroh/skein-hub-admin/1 @hub", async ({ page }) => {
    hub = await startReliquaryHub();

    await page.goto("/");
    await waitForNarthex(page);

    // ensureIdentityBridge starts the real midden/iroh endpoint this page
    // uses (getMiddenNode() singleton) — the exact same transport
    // getHubAdminTransport() (friendz-bridge.ts) reuses for the panel.
    // must happen BEFORE toggleSocialOverlay(): without an identity yet,
    // the social widget force-selects the profile tab (social-widget.ts's
    // layout()), which would leave friends-tab's own container invisible.
    const localNodeId = await ensureIdentityBridge(page);
    await hub.adminAllow(localNodeId);

    await toggleSocialOverlay(page);
    await waitForFriendsTabHooks(page);

    const hooks = friendsTabHooks(page);
    const hubFriendId = await seedFriend(page, {
      nodeId: hub.nodeId,
      alias: "real hub",
      isHub: true,
    });

    await hooks.openFriendDetail(hubFriendId);
    expect(await hooks.hasManageHubAction()).toBe(true);

    await hooks.openHubProfilePanel();
    expect(await hooks.isHubProfilePanelOpen()).toBe(true);

    // retry a few times to absorb the documented relay-discovery-lag flake
    // (same pattern hub-profile-panel.spec.ts's mountPanelAndWaitReady uses).
    let state: { status: string } | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      state = await hooks.getHubProfilePanelState();
      if (state && state.status !== "loading" && state.status !== "error") break;
      await hooks.refreshHubProfilePanel();
      await page.waitForTimeout(750);
    }

    expect(state?.status).toBe("ready");

    // -- scroll regression guard (user-reported: panel never scrolled) --
    // a fresh hub renders a SHORT panel (nothing to scroll), so first seed
    // enough friendz rows that the content genuinely overflows the panel
    // viewport, then drive a real mouse wheel over it.
    for (let i = 0; i < 14; i++) {
      await hub.friendAllow(
        `${i.toString(16).padStart(2, "0")}${"ab".repeat(31)}`.slice(0, 64)
      );
    }
    await hooks.refreshHubProfilePanel();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              (window as any).__skeinTest.social.friendsTab.getHubProfileScrollState()
            )
          )?.totalHeight ?? 0,
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    const scrollBefore = await page.evaluate(() =>
      (window as any).__skeinTest.social.friendsTab.getHubProfileScrollState()
    );
    expect(scrollBefore).not.toBeNull();
    // ScrollBox reports -0 at rest — compare numerically, not Object.is
    expect(Math.abs(scrollBefore.scrollY)).toBe(0);
    expect(scrollBefore.totalHeight).toBeGreaterThan(scrollBefore.areaHeight);

    const panelPos = await page.evaluate(() =>
      (window as any).__skeinTest.social.friendsTab.getHubProfilePanelGlobalPos()
    );
    expect(panelPos).not.toBeNull();
    // the canvas viewport must NOT pan while the panel consumes the wheel
    const worldBefore = await page.evaluate(() => {
      const w = (window as any).__skein.world;
      return { x: w.x, y: w.y };
    });
    await page.mouse.move(panelPos.x, panelPos.y);
    await page.mouse.wheel(0, 240);
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              (window as any).__skeinTest.social.friendsTab.getHubProfileScrollState()
            )
          )?.scrollY ?? 0,
        { timeout: 5_000 }
      )
      .toBeGreaterThan(0);
    const worldAfter = await page.evaluate(() => {
      const w = (window as any).__skein.world;
      return { x: w.x, y: w.y };
    });
    expect(worldAfter).toEqual(worldBefore);

    await hooks.closeHubProfilePanel();
    expect(await hooks.isHubProfilePanelOpen()).toBe(false);
    expect(await hooks.getViewMode()).toBe("detail");
  });

  // real root cause found and fixed (2026-07-02, docs/hub-and-profile-plan.md
  // section 10.3): social-widget.ts force-selects the "profile" tab whenever
  // no identity exists yet in the *social doc* (`state.profile.nodeId`) — a
  // separate, asynchronously-synced field from the actual iroh keypair
  // (synced in by profile-tab.ts's own mount-time effect, a `.then()` that
  // doesn't complete synchronously). on a genuinely fresh browser context,
  // `ensureIdentityBridge()` resolving does NOT mean the social doc's
  // `profile.nodeId` is populated yet — so the very first (synchronous)
  // `layout()` call inside `social-widget.ts`'s `create()` sees
  // `hasIdentity === false` and force-sets `activeTab = "profile"`. that bug
  // was real and two-fold: (1) `activeTab` never reset back to "friends"
  // once identity *did* sync in moments later, and (2) each tab tracks its
  // own `currentWidth`/`currentHeight` independently, initialized to 0 —
  // since "friends" was never the active tab during its own first layout()
  // pass, its dimensions stayed stuck at 0 forever (confirmed via a
  // temporary debug hook: `mountOrLayoutHubProfilePanel` was receiving
  // `w:0, h:0`), which is what actually broke every downstream
  // getGlobalPosition()-based click coordinate in this describe block —
  // not a pixi hit-testing or timing bug, a real dimensions-never-
  // initialized bug. fixed directly in `social-widget.ts`: `activeTab`
  // now snaps back to "friends" the moment identity appears, but only if
  // it was auto-forced to "profile" in the first place (a genuine user
  // click to "profile" is never overridden).
  test("clicking the panel's real allow/remove buttons (through friends-tab) round-trips to a real hub and re-renders @hub", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);

    hub = await startReliquaryHub();

    await page.goto("/");
    await waitForNarthex(page);

    const localNodeId = await ensureIdentityBridge(page);
    await hub.adminAllow(localNodeId);

    await toggleSocialOverlay(page);
    await waitForFriendsTabHooks(page);

    // a second real peer, so the "allow" click has a genuine node id to
    // target — mirrors hub-profile-panel.spec.ts's "target" peer pattern.
    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    await targetPage.goto("/");
    await waitForNarthex(targetPage);
    const targetNodeId = await ensureIdentityBridge(targetPage);

    const hooks = friendsTabHooks(page);
    const hubFriendId = await seedFriend(page, {
      nodeId: hub.nodeId,
      alias: "real hub for click-through",
      isHub: true,
    });

    await hooks.openFriendDetail(hubFriendId);
    await hooks.openHubProfilePanel();
    expect(await hooks.isHubProfilePanelOpen()).toBe(true);

    // wait for the panel to settle into "ready" before touching its buttons
    // (retry pattern mirrors hub-profile-panel.spec.ts's mountPanelAndWaitReady()).
    let state: { status: string } | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      state = await hooks.getHubProfilePanelState();
      if (state && state.status !== "loading" && state.status !== "error") break;
      await hooks.refreshHubProfilePanel();
      await page.waitForTimeout(750);
    }
    expect(state?.status).toBe("ready");

    // real click on the panel's "allow" input + real keyboard typing —
    // proves the DOM input overlay is actually positioned/focusable, not
    // just that HubAdminClient works when called directly.
    const inputPos = await hooks.getHubProfileAllowInputGlobalPos();
    expect(inputPos, "expected the allow input to be rendered").not.toBeNull();
    await page.mouse.click(inputPos!.x, inputPos!.y);
    await page.keyboard.type(targetNodeId);

    const allowBtnPos = await hooks.getHubProfileAllowButtonGlobalPos();
    expect(allowBtnPos, "expected the allow button to be rendered").not.toBeNull();
    await page.mouse.click(allowBtnPos!.x, allowBtnPos!.y);

    // the panel's own real handleAllow() -> refresh() path re-renders the
    // friendz list — poll the same rendered-state accessor the panel uses
    // internally (getState()), not a fresh HubAdminClient call of our own.
    await expect
      .poll(
        async () => {
          const s = await hooks.getHubProfilePanelState();
          return s?.status === "ready" ? s.friends.map((f: { nodeId: string }) => f.nodeId) : [];
        },
        { timeout: 20_000 }
      )
      .toContain(targetNodeId);

    // -- real click on that friend row's "remove" button --
    const removeBtnPos = await hooks.getHubProfileRemoveButtonGlobalPos(targetNodeId);
    expect(removeBtnPos, "expected a rendered remove button for the allowed peer").not.toBeNull();
    await page.mouse.click(removeBtnPos!.x, removeBtnPos!.y);

    await expect
      .poll(
        async () => {
          const s = await hooks.getHubProfilePanelState();
          return s?.status === "ready" ? s.friends.map((f: { nodeId: string }) => f.nodeId) : [];
        },
        { timeout: 20_000 }
      )
      .not.toContain(targetNodeId);

    await targetPage.close();
    await targetContext.close();
  });

  test("the panel's real '‹ back' button (through friends-tab) returns to the friend-detail view @hub", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    hub = await startReliquaryHub();

    await page.goto("/");
    await waitForNarthex(page);

    const localNodeId = await ensureIdentityBridge(page);
    await hub.adminAllow(localNodeId);

    await toggleSocialOverlay(page);
    await waitForFriendsTabHooks(page);

    const hooks = friendsTabHooks(page);
    const hubFriendId = await seedFriend(page, {
      nodeId: hub.nodeId,
      alias: "real hub for back-button click",
      isHub: true,
    });

    await hooks.openFriendDetail(hubFriendId);
    await hooks.openHubProfilePanel();
    expect(await hooks.isHubProfilePanelOpen()).toBe(true);

    // wait for the panel to settle into "ready" before computing the back
    // button's position (see the root-cause note on the allow/remove test
    // above — the real bug was friends-tab's own dimensions never being
    // initialized, already fixed in social-widget.ts).
    let state: { status: string } | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      state = await hooks.getHubProfilePanelState();
      if (state && state.status !== "loading" && state.status !== "error") break;
      await hooks.refreshHubProfilePanel();
      await page.waitForTimeout(750);
    }
    expect(state?.status).toBe("ready");

    const backPos = await page.evaluate(() =>
      (window as any).__skeinTest.social.friendsTab.getHubProfileBackButtonGlobalPos()
    );
    expect(backPos, "expected the back button to be rendered").not.toBeNull();
    await page.mouse.click(backPos.x, backPos.y);

    await expect.poll(async () => hooks.isHubProfilePanelOpen()).toBe(false);
    await expect.poll(async () => hooks.getViewMode()).toBe("detail");
  });
});

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
    await toggleSocialOverlay(page);
    await waitForFriendsTabHooks(page);

    // ensureIdentityBridge starts the real midden/iroh endpoint this page
    // uses (getMiddenNode() singleton) — the exact same transport
    // getHubAdminTransport() (friendz-bridge.ts) reuses for the panel.
    const localNodeId = await ensureIdentityBridge(page);
    await hub.adminAllow(localNodeId);

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

    await hooks.closeHubProfilePanel();
    expect(await hooks.isHubProfilePanelOpen()).toBe(false);
    expect(await hooks.getViewMode()).toBe("detail");
  });
});

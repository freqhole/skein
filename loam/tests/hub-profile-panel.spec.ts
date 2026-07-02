/**
 * hub profile panel e2e tests.
 *
 * mounts the real, standalone `mountHubProfilePanel()`
 * (`widgets/narthex/social/hub-profile-panel.ts`) in a real browser page
 * against a real `reliquary serve` hub, using the production
 * `hub-admin-client.ts` client (real `iroh/skein-hub-admin/1` open_bi +
 * CBOR wire calls, no mocking) — same pattern `hub-admin.spec.ts` already
 * uses for the underlying protocol, but exercising the panel built on top
 * of it.
 *
 * this panel isn't wired into the real app's mount tree yet (see
 * docs/hub-and-profile-plan.md section 5's phased order), so there's no
 * production page to load it from — `test-harness-hub-profile.html` /
 * `src/dev/hub-profile-test-bootstrap.ts` give it a small, dedicated
 * mount point instead (a bare pixi `Application` + a real iroh transport,
 * no narthex/canvas doc involved).
 *
 * coverage note: this repo has no existing precedent for driving pixi
 * canvas UI via simulated pointer clicks in playwright (every other spec
 * in tests/ exercises wire protocols directly, not rendered widgets), so
 * these tests don't click the panel's on-canvas "allow"/"remove" buttons.
 * instead they drive the exact same production `HubAdminClient` instance
 * the panel uses internally (exposed via the test bridge as `.client`),
 * then call `refreshPanel()` and assert on `getPanelState()` — this proves
 * real, end-to-end wire behavior (allow/remove/list/pendingKnocks against
 * a real hub process) *and* the panel's response-handling/rendering-state
 * logic (loading -> ready/notAdmin/error merge), just not simulated mouse
 * clicks on canvas pixels. see the final task summary for this
 * acknowledged gap.
 *
 * tag: @hub
 * run with: npx playwright test tests/hub-profile-panel.spec.ts --workers=1
 */

import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";
import type { HubProfilePanelState } from "../widgets/narthex/social/hub-profile-panel";

interface HarnessHandle {
  page: Page;
  nodeId: string;
}

/** navigate a fresh page to the hub-profile test harness and wait for it to come online. */
async function openHarnessPage(page: Page): Promise<HarnessHandle> {
  await page.goto("/test-harness-hub-profile.html");
  await page.waitForFunction(() => typeof (window as any).__initHubProfileTest === "function", {
    timeout: 15_000,
  });
  const { nodeId } = await page.evaluate(async () => {
    return (window as any).__initHubProfileTest();
  });
  await page.evaluate(async () => {
    await (window as any).__hubProfileTest.waitForOnline(15_000);
  });
  return { page, nodeId };
}

/** mount the panel for the given hub node id and wait for its first refresh to settle. */
async function mountPanelAndWaitReady(
  page: Page,
  hubNodeId: string,
  attempts = 4,
  delayMs = 750
): Promise<HubProfilePanelState> {
  await page.evaluate((id) => {
    (window as any).__hubProfileTest.mountPanel(id);
  }, hubNodeId);

  let lastState: HubProfilePanelState | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.evaluate(async () => {
      await (window as any).__hubProfileTest.refreshPanel();
    });
    lastState = await page.evaluate(() => (window as any).__hubProfileTest.getPanelState());
    if (lastState && lastState.status !== "loading" && lastState.status !== "error") {
      return lastState;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return lastState!;
}

async function hubAdminAllow(page: Page, hubNodeId: string, nodeId: string) {
  return page.evaluate(
    ([hub, target]) => (window as any).__hubProfileTest.client.hubAdminAllow(hub, target),
    [hubNodeId, nodeId] as const
  );
}

async function hubAdminRemove(page: Page, hubNodeId: string, nodeId: string) {
  return page.evaluate(
    ([hub, target]) => (window as any).__hubProfileTest.client.hubAdminRemove(hub, target),
    [hubNodeId, nodeId] as const
  );
}

async function hubAdminBlock(page: Page, hubNodeId: string, nodeId: string) {
  return page.evaluate(
    ([hub, target]) => (window as any).__hubProfileTest.client.hubAdminBlock(hub, target),
    [hubNodeId, nodeId] as const
  );
}

async function hubAdminPromoteAdmin(page: Page, hubNodeId: string, nodeId: string) {
  return page.evaluate(
    ([hub, target]) => (window as any).__hubProfileTest.client.hubAdminPromoteAdmin(hub, target),
    [hubNodeId, nodeId] as const
  );
}

async function hubAdminDemoteAdmin(page: Page, hubNodeId: string, nodeId: string) {
  return page.evaluate(
    ([hub, target]) => (window as any).__hubProfileTest.client.hubAdminDemoteAdmin(hub, target),
    [hubNodeId, nodeId] as const
  );
}

test.describe("hub profile panel @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("renders the friendz list and pending-knocks section for a recognized admin @hub", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const admin = await openHarnessPage(page);
    await hub.adminAllow(admin.nodeId);

    const state = await mountPanelAndWaitReady(page, hub.nodeId);

    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(Array.isArray(state.friends)).toBe(true);
      expect(Array.isArray(state.pendingKnocks)).toBe(true);
      // fresh hub, nobody allowed into friendz yet (admin only got adminz rights).
      expect(state.friends).toEqual([]);
      expect(state.pendingKnocks).toEqual([]);
    }
  });

  test("allow adds a friend, visible on the next panel refresh @hub", async ({ page, browser }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const admin = await openHarnessPage(page);
    await hub.adminAllow(admin.nodeId);

    // a second real peer, to have a genuine node id to allow (rather than a
    // made-up hex string) — mirrors hub-admin.spec.ts's "target" peer.
    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    const target = await openHarnessPage(targetPage);

    await mountPanelAndWaitReady(page, hub.nodeId);

    const allowResponse = await hubAdminAllow(page, hub.nodeId, target.nodeId);
    expect(allowResponse).toEqual({ kind: "allowed", nodeId: target.nodeId, status: "allowed" });

    const state = await mountPanelAndWaitReady(page, hub.nodeId);
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.friends.map((f) => f.nodeId)).toContain(target.nodeId);
    }

    await targetPage.close();
    await targetContext.close();
  });

  test("remove removes a friend, no longer visible on the next panel refresh @hub", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const admin = await openHarnessPage(page);
    await hub.adminAllow(admin.nodeId);

    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    const target = await openHarnessPage(targetPage);

    await hubAdminAllow(page, hub.nodeId, target.nodeId);

    let state = await mountPanelAndWaitReady(page, hub.nodeId);
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.friends.map((f) => f.nodeId)).toContain(target.nodeId);
    }

    const removeResponse = await hubAdminRemove(page, hub.nodeId, target.nodeId);
    expect(removeResponse).toEqual({ kind: "removed", nodeId: target.nodeId });

    state = await mountPanelAndWaitReady(page, hub.nodeId);
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.friends.map((f) => f.nodeId)).not.toContain(target.nodeId);
    }

    await targetPage.close();
    await targetContext.close();
  });

  test("a non-admin peer sees the not-admin state, not an empty list or a raw error @hub", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    await openHarnessPage(page);
    // deliberately skip hub.adminAllow() — this page's peer is not in hub_adminz.

    const state = await mountPanelAndWaitReady(page, hub.nodeId);

    expect(state).toEqual({ status: "notAdmin" });
  });

  test("block sets a friend's status to blocked; unblock (allow again) restores it @hub", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const admin = await openHarnessPage(page);
    await hub.adminAllow(admin.nodeId);

    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    const target = await openHarnessPage(targetPage);

    await hubAdminAllow(page, hub.nodeId, target.nodeId);

    const blockResponse = await hubAdminBlock(page, hub.nodeId, target.nodeId);
    expect(blockResponse).toEqual({ kind: "blocked", nodeId: target.nodeId });

    let state = await mountPanelAndWaitReady(page, hub.nodeId);
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      const friend = state.friends.find((f) => f.nodeId === target.nodeId);
      expect(friend?.status).toBe("blocked");
    }

    // "unblock" is just allow again.
    const unblockResponse = await hubAdminAllow(page, hub.nodeId, target.nodeId);
    expect(unblockResponse).toEqual({ kind: "allowed", nodeId: target.nodeId, status: "allowed" });

    state = await mountPanelAndWaitReady(page, hub.nodeId);
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      const friend = state.friends.find((f) => f.nodeId === target.nodeId);
      expect(friend?.status).toBe("allowed");
    }

    await targetPage.close();
    await targetContext.close();
  });

  test("promote grants a friend hub-admin rights; demote revokes them @hub", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);

    hub = await startReliquaryHub();
    const admin = await openHarnessPage(page);
    await hub.adminAllow(admin.nodeId);

    const targetContext = await browser.newContext();
    const targetPage = await targetContext.newPage();
    const target = await openHarnessPage(targetPage);

    await hubAdminAllow(page, hub.nodeId, target.nodeId);

    const promoteResponse = await hubAdminPromoteAdmin(page, hub.nodeId, target.nodeId);
    expect(promoteResponse).toEqual({
      kind: "adminChanged",
      nodeId: target.nodeId,
      isAdmin: true,
    });

    let state = await mountPanelAndWaitReady(page, hub.nodeId);
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      const friend = state.friends.find((f) => f.nodeId === target.nodeId);
      expect(friend?.isAdmin).toBe(true);
    }

    // the newly-promoted admin can now make their own requests.
    const targetState = await mountPanelAndWaitReady(targetPage, hub.nodeId);
    expect(targetState.status).toBe("ready");

    const demoteResponse = await hubAdminDemoteAdmin(page, hub.nodeId, target.nodeId);
    expect(demoteResponse).toEqual({
      kind: "adminChanged",
      nodeId: target.nodeId,
      isAdmin: false,
    });

    state = await mountPanelAndWaitReady(page, hub.nodeId);
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      const friend = state.friends.find((f) => f.nodeId === target.nodeId);
      expect(friend?.isAdmin).toBe(false);
    }

    await targetPage.close();
    await targetContext.close();
  });
});

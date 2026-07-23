// e2e tests for the messagez widget's knock (access-request) inbox UI —
// docs/knock-and-hub-relay-plan.md sections 3.1a, 6, 7.1, 7.2, 7.3.
//
// runs against the full production app (index.html / boot.ts) — the only
// place the messagez widget is mounted with its dev-only test hooks
// (window.__skeinTest.messagez, see messagez-widget.ts's MessagezTestHooks).
// the lighter test-harness.html bootstrap (src/dev/test-bootstrap.ts, used
// by tests/canvas-store.test.ts's `canvasPage` fixture) never mounts a
// toolbar/messagez overlay at all — just a bare canvas + store, no friendz
// wiring — so it can't drive this widget's UI.
//
// knocks are seeded directly via window.__skein.store.recordKnock(), the
// same CanvasStore method the real wire protocol calls (see
// friendz-wiring.ts's wireKnockHandlers()), rather than over a real p2p
// connection — this file is about the widget's rendering/click wiring, not
// the protocol/relay path itself, which is already covered end-to-end by
// tests/knock-flow.spec.ts (real two-peer iroh connections).
//
// run with: npx playwright test tests/knock-ui.test.ts --workers=1

import { expect, test, type Page } from "@playwright/test";
import { ensureIdentityBridge } from "./helpers/skein-bridge";

const KNOCK_MESSAGE = "hi, it's dave from the meetup last week";

type KnockAction = "roleToggle" | "approve" | "reject" | "ignore";

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

/** wait for the messagez widget's dev-only test bridge to be mounted. */
async function waitForMessagezBridge(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__skeinTest?.messagez, { timeout: 10_000 });
}

/** open (or close) the messages overlay via the toolbar's real button — the
 *  same click a user would make, not a bypass. */
async function toggleMessagesOverlay(page: Page): Promise<void> {
  const pos = await page.evaluate(() => {
    const btn = (window as any).__skein.toolbar.messagesBtn;
    const p = btn.getGlobalPosition();
    return { x: p.x + btn.width / 2, y: p.y + btn.height / 2 };
  });
  await page.mouse.click(pos.x, pos.y);
}

/** seed a pending knock directly via CanvasStore.recordKnock() — the same
 *  method the real wire protocol calls (friendz-wiring.ts's
 *  wireKnockHandlers()); bypasses the network since this file tests the
 *  widget, not the protocol/relay path (see tests/knock-flow.spec.ts). */
async function seedKnock(
  page: Page,
  requesterNodeId: string,
  requesterUsername: string,
  message: string
): Promise<void> {
  await page.evaluate(
    ([id, user, msg]) => {
      (window as any).__skein.store.recordKnock(id, user, msg);
    },
    [requesterNodeId, requesterUsername, message] as const
  );
}

async function getVisibleKnockIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__skeinTest.messagez.getVisibleKnockRequesterIds());
}

async function getKnockMeta(
  page: Page,
  requesterNodeId: string
): Promise<{ text: string; isHub: boolean; title: string; message: string } | null> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.messagez.getKnockMetaInfo(id),
    requesterNodeId
  );
}

async function getKnockRole(page: Page, requesterNodeId: string): Promise<string | null> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.messagez.getKnockRole(id),
    requesterNodeId
  );
}

async function getKnockGlobalPos(
  page: Page,
  requesterNodeId: string,
  action: KnockAction
): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate(
    ([id, a]) => (window as any).__skeinTest.messagez.getKnockActionGlobalPos(id, a),
    [requesterNodeId, action] as const
  );
  expect(pos, `expected a rendered "${action}" button for ${requesterNodeId}`).not.toBeNull();
  return pos as { x: number; y: number };
}

async function clickKnockAction(page: Page, requesterNodeId: string, action: KnockAction): Promise<void> {
  const pos = await getKnockGlobalPos(page, requesterNodeId, action);
  await page.mouse.click(pos.x, pos.y);
}

/** raw `.acl[nodeId]` entry — deliberately not CanvasStore.getRole(), which
 *  defaults a *missing* entry to "viewer" (see canvas-store.ts's doc
 *  comment) and would mask "no access was ever granted" as a false pass. */
async function getAclEntry(page: Page, nodeId: string): Promise<{ role: string } | null> {
  return page.evaluate((id) => (window as any).__skein.store.doc().acl?.[id] ?? null, nodeId);
}

async function getPendingKnock(page: Page, requesterNodeId: string): Promise<any> {
  return page.evaluate(
    (id) => (window as any).__skein.store.doc().pendingKnocks?.[id] ?? null,
    requesterNodeId
  );
}

/** boot the app, generate an identity, create a fresh canvas (the identity
 *  becomes its admin), and open the messages overlay. returns the new
 *  canvas's doc id. */
async function setup(page: Page): Promise<string> {
  await page.goto("/");
  await waitForAppReady(page);
  await ensureIdentityBridge(page);
  const canvasDocId = await createCanvasAndWaitForNavigation(page, {
    title: "knock ui test canvas",
    color: 0x8b5cf6,
  });
  await waitForMessagezBridge(page);
  await toggleMessagesOverlay(page);
  return canvasDocId;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test.describe("messagez knock inbox UI", () => {
  // run serially to avoid resource contention (midden wasm + iroh startup is
  // heavy) — same reasoning image-and-profile.test.ts documents.
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("pending knock renders with requester username, message, and a role picker", async ({
    page,
  }) => {
    await setup(page);
    const requesterId = "requester-render-1";
    await seedKnock(page, requesterId, "alice", KNOCK_MESSAGE);

    await expect.poll(() => getVisibleKnockIds(page)).toContain(requesterId);

    const meta = await getKnockMeta(page, requesterId);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe("alice wants access");
    expect(meta!.message).toBe(KNOCK_MESSAGE);
    expect(meta!.text).toContain("from: alice");
    expect(meta!.isHub).toBe(false);

    // role picker defaults to "member" and actually toggles when clicked
    expect(await getKnockRole(page, requesterId)).toBe("member");
    await clickKnockAction(page, requesterId, "roleToggle");
    expect(await getKnockRole(page, requesterId)).toBe("viewer");
  });

  test("approve (with a role selected) grants that role via the real approveKnock() path", async ({
    page,
  }) => {
    await setup(page);
    const requesterId = "requester-approve-1";
    await seedKnock(page, requesterId, "bob", KNOCK_MESSAGE);
    await expect.poll(() => getVisibleKnockIds(page)).toContain(requesterId);

    // select "viewer" before approving, to prove the chosen role (not just
    // the default "member") is what actually gets granted
    await clickKnockAction(page, requesterId, "roleToggle");
    expect(await getKnockRole(page, requesterId)).toBe("viewer");

    await clickKnockAction(page, requesterId, "approve");

    // the real grant: CanvasStore.setRole(), reached through
    // approveKnock() (friendz-wiring.ts), not a UI-only status flag
    await expect.poll(() => getAclEntry(page, requesterId)).toEqual({ role: "viewer" });

    const knock = await getPendingKnock(page, requesterId);
    expect(knock.decisions).toHaveLength(1);
    expect(knock.decisions[0]).toMatchObject({ decision: "approve", role: "viewer" });

    // resolved — no longer in the visible pending list
    await expect.poll(() => getVisibleKnockIds(page)).not.toContain(requesterId);
  });

  test("reject calls declineKnock(); the decision is recorded and the requester never gets ACL access", async ({
    page,
  }) => {
    await setup(page);
    const requesterId = "requester-reject-1";
    await seedKnock(page, requesterId, "carol", KNOCK_MESSAGE);
    await expect.poll(() => getVisibleKnockIds(page)).toContain(requesterId);

    await clickKnockAction(page, requesterId, "reject");

    await expect
      .poll(async () => (await getPendingKnock(page, requesterId))?.decisions?.length ?? 0)
      .toBe(1);

    const knock = await getPendingKnock(page, requesterId);
    expect(knock.decisions[0]).toMatchObject({ decision: "decline" });

    // no ACL entry at all — see getAclEntry()'s doc comment for why this
    // (not getRole()) is the correct assertion here
    expect(await getAclEntry(page, requesterId)).toBeNull();

    await expect.poll(() => getVisibleKnockIds(page)).not.toContain(requesterId);
  });

  test("ignore hides the knock from this admin's own view without writing to the canvas doc, and persists across reload", async ({
    page,
  }) => {
    const canvasDocId = await setup(page);
    const requesterId = "requester-ignore-1";
    await seedKnock(page, requesterId, "dave", KNOCK_MESSAGE);
    await expect.poll(() => getVisibleKnockIds(page)).toContain(requesterId);

    const beforeDoc = await page.evaluate(
      () => JSON.stringify((window as any).__skein.store.doc().pendingKnocks)
    );

    await clickKnockAction(page, requesterId, "ignore");

    await expect.poll(() => getVisibleKnockIds(page)).not.toContain(requesterId);

    // side-effect-free on shared state: the canvas doc's pendingKnocks is
    // byte-for-byte unchanged — "ignore" never called CanvasStore/the
    // protocol at all, only a local dismissed-set write (see
    // messagez-widget.ts's getDismissedKnocks()/addDismissedKnock()).
    const afterDoc = await page.evaluate(
      () => JSON.stringify((window as any).__skein.store.doc().pendingKnocks)
    );
    expect(afterDoc).toBe(beforeDoc);

    // reload — same admin, same canvas (hash is preserved across reload) —
    // the dismissal persists via localStorage.
    await page.reload();
    await waitForAppReady(page);
    expect(await page.evaluate(() => window.location.hash.slice(1))).toBe(canvasDocId);
    await waitForMessagezBridge(page);
    await toggleMessagesOverlay(page);

    await expect.poll(() => getVisibleKnockIds(page)).not.toContain(requesterId);

    // still pending for any OTHER admin — the doc itself was never touched
    const knock = await getPendingKnock(page, requesterId);
    expect(knock).not.toBeNull();
    expect(knock.decisions).toEqual([]);
  });

  test('"via hub" attribution is visually distinct from an ordinary relayed knock', async ({
    page,
  }) => {
    const canvasDocId = await setup(page);
    const hubNodeId = "hub-node-" + "a".repeat(55);
    const relayNodeId = "relay-node-" + "b".repeat(53);
    const hubRequesterId = "requester-hub-1";
    const relayRequesterId = "requester-relay-1";

    await seedKnock(page, hubRequesterId, "erin", KNOCK_MESSAGE);
    await seedKnock(page, relayRequesterId, "frank", KNOCK_MESSAGE);
    await expect.poll(() => getVisibleKnockIds(page)).toContain(hubRequesterId);
    await expect.poll(() => getVisibleKnockIds(page)).toContain(relayRequesterId);

    // register hubNodeId as a known reliquary hub for this canvas
    // (CanvasStore.addHubNodeId() — section 7.3's "hub-ness lives in the
    // automerge doc" design) and simulate both knocks having been relayed —
    // one via the hub, one via an ordinary peer.
    await page.evaluate((id) => (window as any).__skein.store.addHubNodeId(id), hubNodeId);
    await page.evaluate(
      ([docId, reqId, relayer]) =>
        (window as any).__skeinTest.messagez.simulateKnockRelay(docId, reqId, relayer),
      [canvasDocId, hubRequesterId, hubNodeId] as const
    );
    await page.evaluate(
      ([docId, reqId, relayer]) =>
        (window as any).__skeinTest.messagez.simulateKnockRelay(docId, reqId, relayer),
      [canvasDocId, relayRequesterId, relayNodeId] as const
    );

    // both simulateKnockRelay calls fire onKnockRelayed synchronously, which
    // the widget subscribes to (see messagez-widget.ts's unsubKnockRelayed)
    // to re-render live — poll defensively rather than assuming no delay.
    await expect.poll(async () => (await getKnockMeta(page, hubRequesterId))?.isHub).toBe(true);
    await expect
      .poll(async () => (await getKnockMeta(page, relayRequesterId))?.text)
      .toContain("relayed");

    const hubMeta = await getKnockMeta(page, hubRequesterId);
    const relayMeta = await getKnockMeta(page, relayRequesterId);

    expect(hubMeta!.isHub).toBe(true);
    expect(hubMeta!.text).toContain("via hub");

    expect(relayMeta!.isHub).toBe(false);
    expect(relayMeta!.text).toContain("relayed");
    expect(relayMeta!.text).not.toContain("via hub");
  });
});

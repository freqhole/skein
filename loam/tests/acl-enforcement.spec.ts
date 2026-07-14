import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// adversarial e2e test: a peer demoted to "viewer" role must not be able to
// push CRDT changes to other peers, even when it bypasses the UI entirely
// and mutates the canvas store directly (simulating a compromised or
// modified client). enforcement happens at the network boundary
// (`AclFilteringNetworkAdapter`, see src/p2p/acl-filtering-network-adapter.ts)
// rather than in the UI, so this test talks to `window.__skein.store`
// directly instead of clicking through toolbar/property-tray controls.
//
// this spec uses its own dedicated bootstrap (test-harness-acl.html ->
// src/dev/acl-test-bootstrap.ts) instead of the shared
// sync-test-bootstrap.ts used by tests/sync.test.ts and friends — see that
// bootstrap file's header comment for why.
// ---------------------------------------------------------------------------

interface AclPeer {
  page: Page;
  canvasDocId: string;
  peerId: string;
}

async function openAclPeer(context: BrowserContext, canvasDocId?: string | null): Promise<AclPeer> {
  const page = await context.newPage();
  await page.goto("/test-harness-acl.html");

  await page.waitForFunction(() => typeof (window as any).__initSkeinForTest === "function", {
    timeout: 10000,
  });

  const result = await page.evaluate(async (docId) => {
    return (window as any).__initSkeinForTest({ canvasDocId: docId ?? null });
  }, canvasDocId ?? null);

  const peerId = await page.evaluate(() => (window as any).__skein.peerId as string);

  return { page, canvasDocId: result.canvasDocId as string, peerId };
}

function addWidget(page: Page, id: string) {
  return page.evaluate((widgetId) => {
    (window as any).__skein.store.addWidget({
      id: widgetId,
      type: "hello-world",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: null,
      parentId: null,
    });
  }, id);
}

function hasWidget(page: Page, id: string) {
  return page.evaluate((widgetId) => (window as any).__skein.store.getWidget(widgetId) !== null, id);
}

function widgetCount(page: Page) {
  return page.evaluate(() => (window as any).__skein.store.widgetCount() as number);
}

const test = base;

test("a viewer's direct store mutation never reaches other peers", async ({ browser }) => {
  const context = await browser.newContext();

  const peerA = await openAclPeer(context);
  const peerB = await openAclPeer(context, peerA.canvasDocId);

  // baseline: confirm the sync channel actually works before touching roles.
  await addWidget(peerA.page, "admin-widget-1");
  await expect.poll(() => widgetCount(peerB.page), { timeout: 5000 }).toBe(1);

  // peerA (stamped as canvas admin on creation) demotes peerB to viewer.
  await peerA.page.evaluate((viewerPeerId) => {
    (window as any).__skein.store.setRole(viewerPeerId, "viewer");
  }, peerB.peerId);

  // peerB, now a viewer, bypasses the UI entirely and mutates its own store
  // directly — simulating a compromised/modified client.
  await addWidget(peerB.page, "viewer-injected-widget");

  // the local mutation itself is not blocked (there's no local enforcement,
  // only network-boundary enforcement) — confirm it really happened.
  expect(await hasWidget(peerB.page, "viewer-injected-widget")).toBe(true);

  // add a second legitimate widget from peerA *after* the malicious write,
  // and wait for peerB to see it. this both proves the sync channel is
  // still alive post-attack and gives real round-trip time for the
  // malicious change to have arrived at peerA, if it were ever going to.
  await addWidget(peerA.page, "admin-widget-2");
  await expect.poll(() => widgetCount(peerB.page), { timeout: 5000 }).toBe(3);

  // the viewer's injected widget must never have reached peerA.
  expect(await hasWidget(peerA.page, "viewer-injected-widget")).toBe(false);
  expect(await widgetCount(peerA.page)).toBe(2);
});

test("an unassigned peer's direct store mutation never reaches other peers either (default-deny)", async ({
  browser,
}) => {
  const context = await browser.newContext();

  const peerA = await openAclPeer(context);
  const peerB = await openAclPeer(context, peerA.canvasDocId);

  // peerB is never assigned a role at all, so it defaults to "viewer" - its
  // changes should be stripped exactly like an explicitly demoted viewer's,
  // proving the default itself denies write access rather than only an
  // explicit "viewer" role doing so.
  await addWidget(peerB.page, "unassigned-widget-1");
  expect(await hasWidget(peerB.page, "unassigned-widget-1")).toBe(true);

  // a legitimate widget from peerA (the stamped admin) still reaches peerB,
  // proving the sync channel itself is fine and this is role-based
  // filtering, not a broken channel.
  await addWidget(peerA.page, "admin-widget-3");
  await expect.poll(() => widgetCount(peerB.page), { timeout: 5000 }).toBe(2);

  // peerB's unassigned-role write must never have reached peerA.
  expect(await hasWidget(peerA.page, "unassigned-widget-1")).toBe(false);
  expect(await widgetCount(peerA.page)).toBe(1);
});

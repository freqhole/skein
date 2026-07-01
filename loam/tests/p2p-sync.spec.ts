/**
 * real-iroh p2p sync smoke tests.
 *
 * these tests use two isolated browser contexts, each with a real iroh
 * endpoint backed by the midden WASM module. peers connect to each other
 * by node ID and sync an automerge canvas document over QUIC.
 *
 * tag: @p2p
 * run with: npx playwright test --grep @p2p
 *
 * these tests are slow (iroh endpoints can take 5-30s to come online,
 * relay connections can take another 10-30s). default timeout is bumped
 * to 120s per test.
 */

import { test, expect } from "./fixtures/p2p-page";
import { addPeer, getEndpointState, getWidgetCount, waitForWidgetCount } from "./helpers/skein-bridge";

// ---------------------------------------------------------------------------
// smoke: two endpoints come online
// ---------------------------------------------------------------------------

test("both iroh endpoints reach online state @p2p", async ({ p2pPage }) => {
  test.setTimeout(120_000);

  const [peerA, peerB] = await Promise.all([p2pPage(), p2pPage()]);

  // the fixture already waits for "online" before returning, but assert it explicitly
  expect(await getEndpointState(peerA.page)).toBe("online");
  expect(await getEndpointState(peerB.page)).toBe("online");
});

// ---------------------------------------------------------------------------
// smoke: two peers can dial each other by node ID
// ---------------------------------------------------------------------------

test("peers can dial each other by node ID @p2p", async ({ p2pPage }) => {
  test.setTimeout(180_000);

  // spin up two peers in parallel — each gets its own BrowserContext
  // (separate IndexedDB namespaces, separate iroh identities)
  const [peerA, peerB] = await Promise.all([p2pPage(), p2pPage()]);

  // dial bidirectionally so automerge-repo can set up sync in both directions
  await Promise.all([
    addPeer(peerA.page, peerB.nodeId),
    addPeer(peerB.page, peerA.nodeId),
  ]);

  // wait for automerge-repo to see at least one peer on each side
  // (this confirms the iroh QUIC stream is established and the automerge
  //  handshake completed)
  await Promise.all([
    peerA.page.waitForFunction(
      () => ((window as any).__skeinTest.canvas.repo.peers?.() ?? []).length >= 1,
      { timeout: 60_000 }
    ),
    peerB.page.waitForFunction(
      () => ((window as any).__skeinTest.canvas.repo.peers?.() ?? []).length >= 1,
      { timeout: 60_000 }
    ),
  ]);
});

// ---------------------------------------------------------------------------
// canvas sync: widget added by peer A appears on peer B
// ---------------------------------------------------------------------------

test("widget added by peer A syncs to peer B @p2p", async ({ p2pPage }) => {
  test.setTimeout(240_000);

  // peerA creates the canvas; peerB joins it by document ID
  const peerA = await p2pPage();
  const peerB = await p2pPage({ canvasDocId: peerA.canvasDocId });

  // establish bidirectional iroh connection
  await Promise.all([
    addPeer(peerA.page, peerB.nodeId),
    addPeer(peerB.page, peerA.nodeId),
  ]);

  // wait for the repo handshake on both sides
  await Promise.all([
    peerA.page.waitForFunction(
      () => ((window as any).__skeinTest.canvas.repo.peers?.() ?? []).length >= 1,
      { timeout: 60_000 }
    ),
    peerB.page.waitForFunction(
      () => ((window as any).__skeinTest.canvas.repo.peers?.() ?? []).length >= 1,
      { timeout: 60_000 }
    ),
  ]);

  // peer A adds a widget
  const initialCount = await getWidgetCount(peerA.page);
  await peerA.page.evaluate(() => {
    (window as any).__skeinTest.canvas.store.addWidget("label", {
      x: 100,
      y: 100,
      width: 200,
      height: 60,
    });
  });

  // widget should appear on peer A immediately
  await waitForWidgetCount(peerA.page, initialCount + 1);

  // widget should sync to peer B over iroh
  await waitForWidgetCount(peerB.page, initialCount + 1, 30_000);
});

// ---------------------------------------------------------------------------
// TODO: access control smoke
// - peer without access cannot read canvas content after sync
// ---------------------------------------------------------------------------

// TODO: hub sync smoke
// - connect two peers via a reliquary hub node
// - verify hub receives and forwards automerge changes

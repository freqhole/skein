import { expect, test } from "./fixtures/canvas-page";
import type { CanvasTestHandle } from "./fixtures/canvas-page";
import type { BrowserContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// helper — open N peers all sharing the same canvas and BroadcastChannel context
// ---------------------------------------------------------------------------

async function canvasMesh(
  factory: (opts?: {
    canvasDocId?: string;
    context?: BrowserContext;
    syncOnly?: boolean;
  }) => Promise<CanvasTestHandle>,
  peerCount: number
): Promise<CanvasTestHandle[]> {
  // create peers sequentially — each peer's repo.find() must resolve before
  // the next page tries to join, otherwise BroadcastChannel sync hasn't had
  // time to make the doc available yet.
  // background peers (index >= 1) use syncOnly to skip PixiJS and keep
  // memory pressure low when running 5+ pages in the same browser context.
  const peers: CanvasTestHandle[] = [];
  const first = await factory();
  peers.push(first);
  // brief pause after peerA so its BroadcastChannel listener is fully registered
  // before background peers call repo.find() — avoids "Document unavailable" races.
  await first.page.waitForTimeout(300);
  for (let i = 1; i < peerCount; i++) {
    peers.push(
      await factory({ canvasDocId: first.canvasDocId, context: first.context, syncOnly: true })
    );
  }
  return peers;
}

// ---------------------------------------------------------------------------
// helper — add a widget to a page's canvas store
// ---------------------------------------------------------------------------

async function addWidget(
  page: import("@playwright/test").Page,
  id: string,
  opts: { type?: string; x?: number; y?: number } = {}
): Promise<void> {
  await page.evaluate(
    ([wid, o]) => {
      (window as any).__skein.store.addWidget({
        id: wid,
        type: o.type ?? "hello-world",
        x: o.x ?? 100,
        y: o.y ?? 100,
        width: 200,
        height: 100,
        zIndex: 0,
        props: {},
        collapsed: false,
        docId: null,
        parentId: null,
      });
    },
    [id, opts] as const
  );
}

// ---------------------------------------------------------------------------
// helper — poll widgetCount on a page
// ---------------------------------------------------------------------------

async function waitForWidgetCount(
  page: import("@playwright/test").Page,
  expected: number,
  timeout = 5000
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as any).__skein.store.widgetCount()), { timeout })
    .toBe(expected);
}

// ===========================================================================
// 3-peer tests
// ===========================================================================

test("3-peer mesh: widget added by A appears on B and C", async ({ canvasPage }) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  await addWidget(peerA.page, "mesh-3-w1");

  await Promise.all([waitForWidgetCount(peerB.page, 1), waitForWidgetCount(peerC.page, 1)]);

  // verify the widget data is intact on peerC
  const entry = await peerC.page.evaluate(() =>
    (window as any).__skein.store.getWidget("mesh-3-w1")
  );
  expect(entry).not.toBeNull();
  expect(entry.type).toBe("hello-world");
});

test("3-peer mesh: widget added by B appears on A and C", async ({ canvasPage }) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  await addWidget(peerB.page, "mesh-3-from-b");

  await Promise.all([waitForWidgetCount(peerA.page, 1), waitForWidgetCount(peerC.page, 1)]);
});

test("3-peer mesh: widgets removed by A disappear on B and C", async ({ canvasPage }) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  await addWidget(peerA.page, "del-1");
  await addWidget(peerA.page, "del-2");
  await Promise.all([waitForWidgetCount(peerB.page, 2), waitForWidgetCount(peerC.page, 2)]);

  await peerA.page.evaluate(() => {
    (window as any).__skein.store.removeWidget("del-1");
    (window as any).__skein.store.removeWidget("del-2");
  });

  await Promise.all([waitForWidgetCount(peerB.page, 0), waitForWidgetCount(peerC.page, 0)]);
});

test("3-peer mesh: concurrent additions from all three peers merge without loss", async ({
  canvasPage,
}) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  // all three add simultaneously
  await Promise.all([
    addWidget(peerA.page, "concurrent-a"),
    addWidget(peerB.page, "concurrent-b"),
    addWidget(peerC.page, "concurrent-c"),
  ]);

  // all three should eventually see all three widgets
  await Promise.all([
    waitForWidgetCount(peerA.page, 3),
    waitForWidgetCount(peerB.page, 3),
    waitForWidgetCount(peerC.page, 3),
  ]);
});

test("3-peer mesh: position update syncs to all peers", async ({ canvasPage }) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  await addWidget(peerA.page, "movable");
  await Promise.all([waitForWidgetCount(peerB.page, 1), waitForWidgetCount(peerC.page, 1)]);

  // A moves the widget
  await peerA.page.evaluate(() => (window as any).__skein.store.moveWidget("movable", 400, 500));

  // B and C should see the update
  await Promise.all([
    expect
      .poll(
        () => peerB.page.evaluate(() => (window as any).__skein.store.getWidget("movable")?.x),
        { timeout: 5000 }
      )
      .toBe(400),
    expect
      .poll(
        () => peerC.page.evaluate(() => (window as any).__skein.store.getWidget("movable")?.x),
        { timeout: 5000 }
      )
      .toBe(400),
  ]);
});

test("3-peer mesh: metadata title syncs to all peers", async ({ canvasPage }) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  await peerA.page.evaluate(() => (window as any).__skein.store.setTitle("shared canvas title"));

  await Promise.all([
    expect
      .poll(() => peerB.page.evaluate(() => (window as any).__skein.store.metadata().title), {
        timeout: 5000,
      })
      .toBe("shared canvas title"),
    expect
      .poll(() => peerC.page.evaluate(() => (window as any).__skein.store.metadata().title), {
        timeout: 5000,
      })
      .toBe("shared canvas title"),
  ]);
});

test("3-peer mesh: late-joining peer C receives existing widgets", async ({ canvasPage }) => {
  // A and B sync first, then C joins later
  const peerA = await canvasPage();
  const peerB = await canvasPage({ canvasDocId: peerA.canvasDocId, context: peerA.context });

  await addWidget(peerA.page, "pre-join-1");
  await addWidget(peerA.page, "pre-join-2");
  await addWidget(peerA.page, "pre-join-3");

  await waitForWidgetCount(peerB.page, 3);

  // C joins after the widgets are already there
  const peerC = await canvasPage({ canvasDocId: peerA.canvasDocId, context: peerA.context });
  await waitForWidgetCount(peerC.page, 3);
});

test("3-peer mesh: canvas deletion tombstone syncs to all peers", async ({ canvasPage }) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  await peerA.page.evaluate(() => (window as any).__skein.store.deleteCanvas("soft"));

  await Promise.all([
    expect
      .poll(() => peerB.page.evaluate(() => (window as any).__skein.store.isDeleted), {
        timeout: 5000,
      })
      .toBe(true),
    expect
      .poll(() => peerC.page.evaluate(() => (window as any).__skein.store.isDeleted), {
        timeout: 5000,
      })
      .toBe(true),
  ]);
});

test("3-peer mesh: restore after deletion syncs to all peers", async ({ canvasPage }) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  await peerA.page.evaluate(() => (window as any).__skein.store.deleteCanvas("soft"));
  await expect
    .poll(() => peerB.page.evaluate(() => (window as any).__skein.store.isDeleted), {
      timeout: 5000,
    })
    .toBe(true);

  await peerA.page.evaluate(() => (window as any).__skein.store.restoreCanvas());

  await Promise.all([
    expect
      .poll(() => peerB.page.evaluate(() => (window as any).__skein.store.isDeleted), {
        timeout: 5000,
      })
      .toBe(false),
    expect
      .poll(() => peerC.page.evaluate(() => (window as any).__skein.store.isDeleted), {
        timeout: 5000,
      })
      .toBe(false),
  ]);
});

test("3-peer mesh: peer registration syncs to other peers", async ({ canvasPage }) => {
  const [peerA, peerB, peerC] = await canvasMesh(canvasPage, 3);

  await peerA.page.evaluate(() => (window as any).__skein.store.addPeer("external-node-xyz"));

  await Promise.all([
    expect
      .poll(
        () =>
          peerB.page.evaluate(() => !!(window as any).__skein.store.peers()["external-node-xyz"]),
        { timeout: 5000 }
      )
      .toBe(true),
    expect
      .poll(
        () =>
          peerC.page.evaluate(() => !!(window as any).__skein.store.peers()["external-node-xyz"]),
        { timeout: 5000 }
      )
      .toBe(true),
  ]);
});

// ===========================================================================
// 5-peer tests
// ===========================================================================

test("5-peer mesh: widget from A reaches all four other peers", async ({ canvasPage }) => {
  const [peerA, peerB, peerC, peerD, peerE] = await canvasMesh(canvasPage, 5);

  await addWidget(peerA.page, "five-peer-widget");

  await Promise.all([peerB, peerC, peerD, peerE].map((p) => waitForWidgetCount(p.page, 1)));
});

test("5-peer mesh: concurrent additions from all five peers — no loss", async ({ canvasPage }) => {
  const peers = await canvasMesh(canvasPage, 5);

  await Promise.all(peers.map((p, i) => addWidget(p.page, `five-concurrent-${i}`)));

  await Promise.all(peers.map((p) => waitForWidgetCount(p.page, 5)));
});

test("5-peer mesh: one peer removes widgets — all peers converge to empty", async ({
  canvasPage,
}) => {
  const [peerA, ...rest] = await canvasMesh(canvasPage, 5);

  // A adds 3 widgets
  await Promise.all([
    addWidget(peerA.page, "rm-1"),
    addWidget(peerA.page, "rm-2"),
    addWidget(peerA.page, "rm-3"),
  ]);

  // wait for all to have 3
  await Promise.all([peerA, ...rest].map((p) => waitForWidgetCount(p.page, 3)));

  // B (rest[0]) removes all three
  await rest[0].page.evaluate(() => {
    const store = (window as any).__skein.store;
    store.removeWidget("rm-1");
    store.removeWidget("rm-2");
    store.removeWidget("rm-3");
  });

  // all peers should end up at 0
  await Promise.all([peerA, ...rest].map((p) => waitForWidgetCount(p.page, 0)));
});

test("5-peer mesh: z-order changes sync to all peers", async ({ canvasPage }) => {
  const peers = await canvasMesh(canvasPage, 5);
  const [peerA, ...rest] = peers;

  // A adds 3 widgets with explicit z-order
  await Promise.all([
    addWidget(peerA.page, "zo-a"),
    addWidget(peerA.page, "zo-b"),
    addWidget(peerA.page, "zo-c"),
  ]);

  // set explicit zIndex
  await peerA.page.evaluate(() => {
    const s = (window as any).__skein.store;
    s.setZIndex("zo-a", 0);
    s.setZIndex("zo-b", 1);
    s.setZIndex("zo-c", 2);
  });

  await Promise.all(rest.map((p) => waitForWidgetCount(p.page, 3)));

  // A brings zo-a to front
  await peerA.page.evaluate(() => (window as any).__skein.store.bringToFront("zo-a"));

  // all other peers should see zo-a at position 2
  for (const peer of rest) {
    await expect
      .poll(
        () => peer.page.evaluate(() => (window as any).__skein.store.getLayerInfo("zo-a").position),
        { timeout: 5000 }
      )
      .toBe(2);
  }
});

import type { Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// typed helpers that wrap page.evaluate() against window.__skeinTest.
//
// all raw `(window as any).__skeinTest.*` access lives here — test files
// import these helpers and never touch the window object themselves.
// ---------------------------------------------------------------------------

// --- canvas state ---

/** number of live widgets on the canvas */
export async function getWidgetCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as any).__skeinTest.canvas.widgetManager.getLiveWidgets().size
  );
}

/** all live widget entries as plain objects */
export async function getWidgets(page: Page): Promise<Array<{
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}>> {
  return page.evaluate(() => {
    const live = (window as any).__skeinTest.canvas.widgetManager.getLiveWidgets();
    return [...live.entries()].map(([id, w]: [string, any]) => ({
      id,
      type: w.entry.type,
      x: w.entry.x,
      y: w.entry.y,
      width: w.entry.width,
      height: w.entry.height,
    }));
  });
}

/** add a widget of a given type via the store */
export async function addWidget(
  page: Page,
  type: string,
  opts: { x?: number; y?: number; width?: number; height?: number } = {}
): Promise<string> {
  return page.evaluate(
    ([t, o]) => {
      const store = (window as any).__skeinTest.canvas.store;
      return store.addWidget(t, { x: o.x ?? 100, y: o.y ?? 100, width: o.width ?? 300, height: o.height ?? 200 });
    },
    [type, opts] as const
  );
}

/** wait for a specific widget count, retrying for up to timeoutMs */
export async function waitForWidgetCount(
  page: Page,
  expected: number,
  timeoutMs = 5_000
): Promise<void> {
  await page.waitForFunction(
    (n) => (window as any).__skeinTest.canvas.widgetManager.getLiveWidgets().size === n,
    expected,
    { timeout: timeoutMs }
  );
}

// --- p2p ---

/**
 * get this peer's iroh node ID.
 * only works on pages loaded from test-harness-p2p.html.
 */
export async function getNodeId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__skeinTest.p2p.getNodeId());
}

/**
 * dial a peer by node ID from this page's iroh endpoint.
 * only works on pages loaded from test-harness-p2p.html.
 */
export async function addPeer(page: Page, nodeId: string): Promise<void> {
  return page.evaluate((id) => (window as any).__skeinTest.p2p.addPeer(id), nodeId);
}

/**
 * get the current iroh endpoint state.
 * returns "off" | "starting" | "online" | "error"
 */
export async function getEndpointState(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__skeinTest.p2p.getEndpointState());
}

/**
 * wait until the peer count from automerge's perspective reaches expected,
 * i.e. at least `expected` peers have synced.
 * checks (window as any).__skeinTest.canvas.repo.peers()
 */
export async function waitForPeerCount(
  page: Page,
  expected: number,
  timeoutMs = 60_000
): Promise<void> {
  await page.waitForFunction(
    (n) => ((window as any).__skeinTest.canvas.repo.peers?.() ?? []).length >= n,
    expected,
    { timeout: timeoutMs }
  );
}

// --- canvas-doc direct assertions ---

/** the raw automerge doc snapshot (snapshot, not live) */
export async function getCanvasDoc(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as any).__skeinTest.canvas.store.doc());
}

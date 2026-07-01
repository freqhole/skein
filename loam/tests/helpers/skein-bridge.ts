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
  return page.evaluate(
    () => (window as any).__skeinTest.canvas.widgetManager.getLiveWidgets().size
  );
}

/** all live widget entries as plain objects */
export async function getWidgets(page: Page): Promise<
  Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>
> {
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
      // CanvasStore.addWidget() takes a single WidgetEntry object, not a
      // (type, options) pair — it previously called
      // `store.addWidget(t, {x,y,width,height})`, silently passing the type
      // string as the entry (missing id/props/etc.) instead of throwing.
      return store.addWidget({
        id: crypto.randomUUID(),
        type: t,
        x: o.x ?? 100,
        y: o.y ?? 100,
        width: o.width ?? 300,
        height: o.height ?? 200,
        zIndex: 1,
        props: {},
        collapsed: false,
        docId: null,
        parentId: null,
      });
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
 * checks (window as any).__skeinTest.canvas.repo.peers (a getter property,
 * not a method — see automerge-repo's Repo.js: `get peers()`).
 */
export async function waitForPeerCount(
  page: Page,
  expected: number,
  timeoutMs = 60_000
): Promise<void> {
  await page.waitForFunction(
    (n) => ((window as any).__skeinTest.canvas.repo.peers ?? []).length >= n,
    expected,
    { timeout: timeoutMs }
  );
}

/**
 * open a canvas doc that lives on an already-connected peer.
 *
 * call this only *after* dialing the owning peer via `addPeer()` — opening a
 * shared doc before any peer connection exists means `repo.find()` has
 * nothing to sync from and the document is marked unavailable (a real bug
 * that used to bite `p2p-sync.spec.ts`: it passed `canvasDocId` to the
 * p2pPage() fixture at peer-creation time, before the peers had dialed each
 * other). only works on pages loaded from test-harness-p2p.html.
 */
export async function joinCanvas(page: Page, docId: string): Promise<string> {
  return page.evaluate(
    (id) => (window as any).__joinCanvasForTest(id).then((r: { canvasDocId: string }) => r.canvasDocId),
    docId
  );
}

// --- canvas-doc direct assertions ---

/** the raw automerge doc snapshot (snapshot, not live) */
export async function getCanvasDoc(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as any).__skeinTest.canvas.store.doc());
}

// --- social ---
// these helpers require the full boot router (index.html), not a test harness
// page. they access window.__skeinTest.social which is populated by boot.ts
// in DEV builds.

/** read the current social profile object from the standalone social doc */
export async function getSocialProfile(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const social = (window as any).__skeinTest?.social;
    if (!social?.doc) return null;
    return (social.doc.current?.profile as Record<string, unknown>) ?? null;
  });
}

/**
 * generate or restore a P2P identity.
 * simulates the user clicking "generate identity" in the profile tab.
 */
export async function ensureIdentityBridge(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const social = (window as any).__skeinTest?.social;
    if (!social) throw new Error("__skeinTest.social not found — is this a full boot page?");
    const identity = await social.ensureIdentity();
    return identity.node_id as string;
  });
}

/** open or close the social overlay panel */
export async function toggleSocialOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__skeinTest?.social?.toggleOverlay();
  });
}

/**
 * trigger the avatar file picker inside the social widget.
 * call page.waitForEvent("filechooser") BEFORE this.
 */
export async function triggerAvatarPick(page: Page): Promise<void> {
  await page.evaluate(() => {
    // fire and don't await — input.click() is synchronous so the filechooser
    // event fires before the evaluate callback returns
    (window as any).__skeinTest?.social?.pickAvatar?.();
  });
}

/** wait for the social doc's profile to contain a 64-char hex nodeId */
export async function waitForNodeId(page: Page, timeoutMs = 30_000): Promise<string> {
  await page.waitForFunction(
    () => {
      const nodeId = (window as any).__skeinTest?.social?.doc?.current?.profile?.nodeId;
      return typeof nodeId === "string" && nodeId.length === 64;
    },
    { timeout: timeoutMs }
  );
  return page.evaluate(
    () => (window as any).__skeinTest?.social?.doc?.current?.profile?.nodeId ?? ""
  );
}

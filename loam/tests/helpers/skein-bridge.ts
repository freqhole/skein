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
 * stop maintaining this page's automerge-repo-level connection to a peer
 * added via `addPeer()` above \u2014 closes the existing stream and stops
 * reconnecting. only works on pages loaded from test-harness-p2p.html.
 *
 * use this to prove some other delivery path (e.g. a friendz-protocol
 * gossip digest) works on its own, independent of ordinary automerge doc
 * sync: once this link is severed, the automerge `Repo` genuinely has no
 * way left to sync changes with that peer.
 */
export async function forgetPeer(page: Page, nodeId: string): Promise<void> {
  return page.evaluate((id) => (window as any).__skeinTest.p2p.forgetPeer(id), nodeId);
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

// --- friendz ---

/**
 * send a friend request from this page to a peer by node id — another
 * browser peer or a real reliquary hub, the protocol doesn't distinguish.
 * only works on pages loaded from test-harness-p2p.html.
 */
export async function sendFriendRequest(page: Page, peerNodeId: string): Promise<void> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.friendz.sendFriendRequest(id),
    peerNodeId
  );
}

/**
 * whether a peer's friend request has been accepted (mutual friendship
 * established locally, tracked since the harness page loaded).
 * only works on pages loaded from test-harness-p2p.html.
 */
export async function isFriend(page: Page, peerNodeId: string): Promise<boolean> {
  return page.evaluate((id) => (window as any).__skeinTest.friendz.isFriend(id), peerNodeId);
}

/** wait until a peer is recorded as an accepted friend on this page. */
export async function waitForFriend(
  page: Page,
  peerNodeId: string,
  timeoutMs = 30_000
): Promise<void> {
  await page.waitForFunction(
    (id) => (window as any).__skeinTest.friendz.isFriend(id),
    peerNodeId,
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

// --- knock (access request) ---
// only work on pages loaded from test-harness-p2p.html — see
// src/dev/test-bridge.ts's buildKnockTestBridge() for what these wrap.

/** send a `canvas-knock` message from this page directly to a peer. */
export async function sendKnock(
  page: Page,
  peerNodeId: string,
  knock: { knockId: string; canvasDocId: string; requesterUsername: string; message: string }
): Promise<void> {
  return page.evaluate(
    ([id, k]) => (window as any).__skeinTest.knock.sendKnock(id, k),
    [peerNodeId, knock] as const
  );
}

/** approve a pending knock from this page (grants access + records the
 *  decision + establishes friendship + notifies the requester). */
export async function approveKnock(page: Page, requesterNodeId: string, role: string): Promise<void> {
  return page.evaluate(
    ([id, r]) => (window as any).__skeinTest.knock.approveKnock(id, r),
    [requesterNodeId, role] as const
  );
}

/** decline a pending knock from this page (records the decision + notifies
 *  the requester). */
export async function declineKnock(page: Page, requesterNodeId: string): Promise<void> {
  return page.evaluate((id) => (window as any).__skeinTest.knock.declineKnock(id), requesterNodeId);
}

/** relay-attribution events ({ canvasDocId, requesterNodeId, relayedBy })
 *  observed so far on this page. */
export async function getRelayedKnocks(
  page: Page
): Promise<Array<{ canvasDocId: string; requesterNodeId: string; relayedBy: string }>> {
  return page.evaluate(() => (window as any).__skeinTest.knock.getRelayedKnocks());
}

/** `canvas-knock-ack` events received so far on this page — a deterministic
 *  "the knock was actually processed by someone" signal. */
export async function getReceivedKnockAcks(
  page: Page
): Promise<Array<{ knockId: string; canvasDocId: string; ackerNodeId: string }>> {
  return page.evaluate(() => (window as any).__skeinTest.knock.getReceivedKnockAcks());
}

/** manually send a gossip digest carrying this page's own pending knocks
 *  for `canvasDocId` to a peer — triggers relay delivery deterministically
 *  instead of waiting on the real heartbeat timer. */
export async function sendKnocksGossipDigest(
  page: Page,
  peerNodeId: string,
  canvasDocId: string
): Promise<void> {
  return page.evaluate(
    ([id, docId]) => (window as any).__skeinTest.knock.sendKnocksGossipDigest(id, docId),
    [peerNodeId, canvasDocId] as const
  );
}

/** read a node id's role from a canvas doc's `.acl`, opening/syncing the doc
 *  first if this page doesn't already hold it. null if unreachable or no
 *  ACL entry. */
export async function getCanvasAcl(
  page: Page,
  canvasDocId: string,
  nodeId: string
): Promise<string | null> {
  return page.evaluate(
    ([docId, id]) => (window as any).__skeinTest.knock.getCanvasAcl(docId, id),
    [canvasDocId, nodeId] as const
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

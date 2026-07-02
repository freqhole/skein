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

// --- profile-tab "my canvases" (window.__skeinTest.social.profileTab) ---
// see docs/hub-and-profile-plan.md section 6 / section 8 step 7.

/** all canvases on the local peer's profile doc, per ProfileStore.canvases() directly. */
export async function getProfileCanvasEntries(
  page: Page
): Promise<Array<{ canvasDocId: string; title: string; description?: string; color?: number }>> {
  return page.evaluate(
    () => (window as any).__skeinTest?.social?.profileTab?.getCanvasEntries?.() ?? []
  );
}

/** whether the profile tab's "add current canvas" action is available in this mount. */
export async function canAddCurrentCanvasToProfile(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as any).__skeinTest?.social?.profileTab?.canAddCurrentCanvas?.() ?? false
  );
}

/** add the currently-open canvas to the profile, as if the button were tapped. */
export async function addCurrentCanvasToProfile(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__skeinTest?.social?.profileTab?.addCurrentCanvas?.());
}

/** remove a canvas from the profile by its doc id, as if its row's remove button were tapped. */
export async function removeCanvasFromProfile(page: Page, canvasDocId: string): Promise<void> {
  await page.evaluate(
    (id) => (window as any).__skeinTest?.social?.profileTab?.removeCanvas?.(id),
    canvasDocId
  );
}

/** titles currently rendered in the profile tab's "my canvases" list. */
export async function getRenderedProfileCanvasTitles(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as any).__skeinTest?.social?.profileTab?.getRenderedCanvasTitles?.() ?? []
  );
}

// --- profile canvas-bin widget (window.__skeinTest.social.canvasBin) ---
// see docs/hub-and-profile-plan.md section 10.2, widgets/narthex/social/canvas-bin.ts.

export interface CanvasBinNodeSummary {
  kind: "folder" | "canvas";
  id: string;
  title?: string;
  canvasDocId?: string;
}

/** child nodes of the canvas-bin widget's currently-viewed folder (or root). */
export async function getCanvasBinVisibleNodes(page: Page): Promise<CanvasBinNodeSummary[]> {
  return page.evaluate(
    () => (window as any).__skeinTest?.social?.canvasBin?.getVisibleNodes?.() ?? []
  );
}

/** the canvas-bin widget's currently-viewed folder id, or null at root. */
export async function getCanvasBinCurrentFolderId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (window as any).__skeinTest?.social?.canvasBin?.getCurrentFolderId?.() ?? null
  );
}

/** enter a folder or navigate to a canvas, as if its card were tapped. */
export async function activateCanvasBinNode(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    (id) => (window as any).__skeinTest?.social?.canvasBin?.activateNode?.(id),
    nodeId
  );
}

/** return to the parent folder, as if the "‹ back" button were tapped. */
export async function canvasBinGoBack(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__skeinTest?.social?.canvasBin?.goBack?.());
}

/** create a new folder under the currently-viewed folder. returns its new id. */
export async function addCanvasBinFolder(page: Page, title: string): Promise<string> {
  return page.evaluate(
    (t) => (window as any).__skeinTest?.social?.canvasBin?.addFolder?.(t) ?? "",
    title
  );
}

/** move a node to a new parent folder id (or root when null), as if dragged and dropped. */
export async function moveCanvasBinNode(
  page: Page,
  nodeId: string,
  newParentId: string | null
): Promise<boolean> {
  return page.evaluate(
    ({ nodeId, newParentId }) =>
      (window as any).__skeinTest?.social?.canvasBin?.moveNode?.(nodeId, newParentId) ?? false,
    { nodeId, newParentId }
  );
}

// --- share dialog (window.__skeinTest.share) ---
// see src/dev/test-bridge.ts's ShareTestHooks for what these wrap. only
// present once the toolbar's real share button has been pressed at least
// once for the current canvas (boot.ts's onShare handler registers it fresh
// on every open, since the dialog itself is built ad hoc per click rather
// than mounted once like messagez/friends-tab).

/** click the toolbar's real share button, exactly as a user would \u2014 opens
 *  (or refreshes) the share dialog and (re)populates window.__skeinTest.share
 *  with a fresh snapshot of the friends-to-invite list. */
export async function openShareDialog(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__skein.toolbar.shareBtn.onPress.emit());
}

/** wait until window.__skeinTest.share has been registered (the share
 *  dialog has been opened at least once). */
export async function waitForShareHooks(page: Page, timeoutMs = 15_000): Promise<void> {
  await page.waitForFunction(() => (window as any).__skeinTest?.share != null, {
    timeout: timeoutMs,
  });
}

/** the friend-invite list passed to the most recently opened share dialog
 *  (a snapshot \u2014 call openShareDialog() again to refresh it). */
export async function getFriendsForInvite(
  page: Page
): Promise<
  Array<{ friendId: string; username: string; nodeId: string; isHub?: boolean; isPending?: boolean }>
> {
  return page.evaluate(() => (window as any).__skeinTest?.share?.getFriendsForInvite?.() ?? []);
}

/** pending invites on the current canvas doc, read live via
 *  CanvasStore.pendingInvites(). */
export async function getSharePendingInvites(
  page: Page
): Promise<Array<{ targetNodeId: string; invite: Record<string, unknown> }>> {
  return page.evaluate(() => (window as any).__skeinTest?.share?.getPendingInvites?.() ?? []);
}

/** raw messagez outbox `shares` entries for the current canvas, read live
 *  from the messagez doc. */
export async function getShareMessagezShares(
  page: Page
): Promise<Array<{ toNodeId: string; canvasDocId: string; declined?: boolean; cancelled?: boolean }>> {
  return page.evaluate(() => (window as any).__skeinTest?.share?.getMessagezShares?.() ?? []);
}

/** invite a friend by node id + role, calling the dialog's real
 *  onInviteFriend handler exactly as if its "invite" button were pressed. */
export async function inviteFriendViaShareDialog(
  page: Page,
  nodeId: string,
  role: "member" | "viewer"
): Promise<void> {
  await page.evaluate(
    ([id, r]) => (window as any).__skeinTest.share.inviteFriend(id, r),
    [nodeId, role] as const
  );
}

/** cancel a pending invite by target node id, calling the dialog's real
 *  onCancelInvite handler exactly as if its "cancel" button were pressed. */
export async function cancelInviteViaShareDialog(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => (window as any).__skeinTest.share.cancelInvite(id), nodeId);
}

/** the rendered display-name text for a friend-invite row (regular or hub
 *  section), by node id, or null if that friend isn't currently rendered.
 *  proves the actual rendered row content, not just the FriendInfo passed
 *  in \u2014 see docs/hub-and-profile-plan.md section 10.3. */
export async function getShareFriendRowText(page: Page, nodeId: string): Promise<string | null> {
  return page.evaluate(
    (id) => (window as any).__skeinTest?.share?.getFriendRowText?.(id) ?? null,
    nodeId
  );
}

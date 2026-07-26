import type { Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// typed helpers that wrap page.evaluate() against window.__skeinTest.
//
// all raw `(window as any).__skeinTest.*` access lives here — test files
// import these helpers and never touch the window object themselves.
// ---------------------------------------------------------------------------

/**
 * start collecting console warnings/errors matching pixi's own internal
 * "mask bounds" renderer diagnostic ("Mask bounds, renderable is not
 * inside the root container") — this is a `console.warn` call, not a
 * thrown exception, so a `page.on("pageerror", ...)` listener (see
 * texture-lifecycle.test.ts) never sees it; a passing test can still be
 * masking a broken/blank render (a real bug that got past every e2e test
 * in this repo, 2026-07-02 — see profile-tab.ts's/friends-tab.ts's
 * `.height`-on-a-masked-container mistake). deliberately narrower than
 * "any PixiJS warning" — this app also emits other, unrelated, benign
 * PixiJS warnings (e.g. "HTMLTextSystem: Failed to clean texture") that
 * aren't evidence of this specific bug class. call this right after
 * `page.goto()`, then assert the returned array is empty after exercising
 * the flow under test.
 */
export function collectPixiWarnings(page: Page): string[] {
  const messages: string[] = [];
  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "warning" && type !== "error") return;
    const text = msg.text();
    if (text.includes("Mask bounds")) {
      messages.push(text);
    }
  });
  return messages;
}

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

// --- profile-doc gossip relay (docs/hub-and-profile-plan.md section 6) ---
// only work on pages loaded from test-harness-p2p.html — see
// src/dev/test-bridge.ts's buildProfileGossipTestBridge() for what these wrap.

/** this page's own profile-doc id. */
export async function getMyProfileDocId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__skeinTest.profileGossip.getMyProfileDocId());
}

/** update this page's own profile content (bumps the doc's `updatedAt`). */
export async function setMyProfile(page: Page, username: string, bio: string): Promise<void> {
  return page.evaluate(
    ([u, b]) => (window as any).__skeinTest.profileGossip.setMyProfile(u, b),
    [username, bio] as const
  );
}

/** seed a friend entry on this page with a known node id — mirrors what a
 *  real friend-request/accept handshake would already have populated, so
 *  gossip merge has somewhere to write a relayed profile pointer into. */
export async function addProfileGossipFriend(page: Page, peerNodeId: string): Promise<void> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.profileGossip.addFriend(id),
    peerNodeId
  );
}

/** the profile-doc pointer this page currently knows for a peer node id
 *  (learned directly or via relay), or null if unknown. */
export async function getKnownProfilePointer(
  page: Page,
  peerNodeId: string
): Promise<{ profileDocId: string; updatedAt: string } | null> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.profileGossip.getKnownProfilePointer(id),
    peerNodeId
  );
}

/** profile-doc pointers merged via gossip relay so far on this page. */
export async function getRelayedProfiles(
  page: Page
): Promise<Array<{ peerNodeId: string; profileDocId: string; relayedBy: string }>> {
  return page.evaluate(() => (window as any).__skeinTest.profileGossip.getRelayedProfiles());
}

/** manually send a gossip digest from this page to a peer, carrying this
 *  page's own profile pointer plus every other known friend pointer it's
 *  aware of — triggers relay delivery deterministically instead of waiting
 *  on the real heartbeat/peer-online timer. */
export async function sendProfileGossipDigest(page: Page, peerNodeId: string): Promise<void> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.profileGossip.sendProfileGossipDigest(id),
    peerNodeId
  );
}

/** read a profile doc's content directly from this page, opening/syncing it
 *  first if not already held. null if unreachable. */
export async function readProfileDoc(
  page: Page,
  profileDocId: string
): Promise<{ username: string; bio: string } | null> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.profileGossip.readProfileDoc(id),
    profileDocId
  );
}

/** seed a still-pending outbound friend request on this page to `toNodeId`. */
export async function addOutboundFriendRequest(page: Page, toNodeId: string): Promise<void> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.profileGossip.addOutboundRequest(id),
    toNodeId
  );
}

/** this page's currently-held `toUsername`/`toBio`/`toAvatarDataUrl` for its
 *  own outbound request to `toNodeId`, or null if no such request exists. */
export async function getOutboundRequestToInfo(
  page: Page,
  toNodeId: string
): Promise<{ toUsername: string; toBio: string; toAvatarDataUrl: string } | null> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.profileGossip.getOutboundRequestToInfo(id),
    toNodeId
  );
}

/** this page's currently-held `username`/`bio`/`avatarDataUrl` for a friend
 *  (pending or confirmed) matching `nodeId`, or null if not a friend at all. */
export async function getFriendInfoForNodeId(
  page: Page,
  nodeId: string
): Promise<{ username: string; bio: string; avatarDataUrl: string } | null> {
  return page.evaluate(
    (id) => (window as any).__skeinTest.profileGossip.getFriendInfoForNodeId(id),
    nodeId
  );
}

/** send a gossip digest from this page to `peerNodeId`, carrying a single
 *  relayed `pendingFriendRequests` entry - simulates a mutual friend/hub
 *  handing back identity info it already knows about the target of
 *  someone else's still-pending outbound friend request. */
export async function sendFriendRequestGossipDigest(
  page: Page,
  peerNodeId: string,
  entry: {
    fromNodeId: string;
    toNodeId: string;
    toUsername?: string;
    toBio?: string;
    toAvatarDataUrl?: string;
  }
): Promise<void> {
  return page.evaluate(
    ([peer, e]) => (window as any).__skeinTest.profileGossip.sendFriendRequestGossipDigest(peer, e),
    [peerNodeId, entry] as const
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

/** send a real friend request to a node id through this page's actual
 *  production FriendzProtocol instance \u2014 exactly what friends-tab.ts's
 *  "add friend" flow does. distinct from the p2p-harness-only
 *  `sendFriendRequest()` above (which needs test-harness-p2p.html). */
export async function sendFriendRequestToBridge(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    (id) => (window as any).__skeinTest.social.sendFriendRequestTo(id),
    nodeId
  );
}

/** this page's own messagez `invites` inbox \u2014 real, network-delivered
 *  canvas invites written by `onCanvasInvite` (friendz-wiring.ts). */
export async function getMessagezInvites(
  page: Page
): Promise<Array<{ id: string; canvasDocId: string; fromNodeId: string; status: string }>> {
  return page.evaluate(
    () => (window as any).__skeinTest.social.getMessagezInvites() as Array<{
      id: string;
      canvasDocId: string;
      fromNodeId: string;
      status: string;
    }>
  );
}

/** dispatch the same `skein:accept-canvas-invite` custom event the real
 *  inbox widget's accept button fires, and wait for
 *  `skein:accept-canvas-invite-done` (boot.ts's `acceptCanvasInvite()`
 *  dispatches it once the handler fully completes). */
export async function acceptCanvasInviteViaEvent(
  page: Page,
  invite: {
    canvasDocId: string;
    fromNodeId: string;
    canvasTitle: string;
    canvasDescription: string;
    canvasColor: number;
    canvasPreviewUrl: string;
    fromUsername: string;
    relayedBy?: string;
    role?: string;
  }
): Promise<void> {
  await page.evaluate((detail) => {
    return new Promise<void>((resolve) => {
      window.addEventListener("skein:accept-canvas-invite-done", () => resolve(), { once: true });
      window.dispatchEvent(new CustomEvent("skein:accept-canvas-invite", { detail }));
    });
  }, invite);
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

/** canvasDocIds in the profile tab's "my canvases" list whose preview-image
 *  Sprite has actually finished loading and attached. */
export async function getLoadedPreviewCanvasIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as any).__skeinTest?.social?.profileTab?.getLoadedPreviewCanvasIds?.() ?? []
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
 *  dialog has been opened at least once). checks for the actual hook
 *  function — a bare `!== null` check passes vacuously while the slot is
 *  still `undefined` (never-registered), which made this wait a no-op and
 *  left a boot-timing race (exposed when the midden worker migration
 *  slowed app boot slightly). */
export async function waitForShareHooks(page: Page, timeoutMs = 15_000): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as any).__skeinTest?.share?.inviteFriend === "function",
    { timeout: timeoutMs }
  );
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

/**
 * test bootstrap for playwright e2e tests that require real iroh p2p networking.
 *
 * loaded by test-harness-p2p.html. creates a full IrohNetworkAdapter +
 * automerge Repo and exposes window.__skeinTest with p2p bridge methods.
 *
 * usage from playwright:
 *   await page.goto("/test-harness-p2p.html");
 *   await page.waitForFunction(() => typeof window.__initSkeinP2PForTest === "function");
 *   const { canvasDocId, nodeId } = await page.evaluate(opts =>
 *     window.__initSkeinP2PForTest(opts), { canvasDocId: null }
 *   );
 */

import type { Repo } from "@automerge/automerge-repo";
import { z } from "zod";
import { createTestRegistry } from "../../widgets/index";
import { initCanvas } from "../canvas/init";
import { PresenceManager } from "../canvas/presence-manager";
import { ProfileStore } from "../canvas/profile-doc";
import { Viewport } from "../canvas/viewport";
import { createSkeinHarness } from "../harness/skein-harness";
import { FriendzProtocol } from "../p2p/friends-protocol";
import { FRIENDZ_ALPN, type IrohNetworkAdapter } from "../p2p/iroh-network-adapter";
import { createWidgetDoc } from "../widgets/widget-doc";
import {
  buildFriendzTestBridge,
  buildKnockTestBridge,
  buildP2PBridge,
  buildProfileGossipTestBridge,
} from "./test-bridge";

// a simple zod schema exercised by createWidgetDoc in tests
const testWidgetSchema = z.object({
  count: z.number().default(0),
  step: z.number().default(1),
  label: z.string().default("test"),
});

interface P2PTestInitOptions {
  canvasDocId?: string | null;
}

interface P2PTestInitResult {
  canvasDocId: string;
  nodeId: string;
}

// module-scoped so `joinCanvas` (called later, after the test dials a peer)
// can reuse the same repo/mountElement without recreating the iroh endpoint.
let sharedRepo: Repo | null = null;
let sharedMountElement: HTMLElement | null = null;
let sharedIrohAdapter: IrohNetworkAdapter | null = null;

/**
 * initialize a skein canvas with real iroh p2p for playwright tests.
 * returns the canvas doc ID and this peer's iroh node ID.
 *
 * note: if `options.canvasDocId` refers to a document that only exists on
 * another (not-yet-connected) peer, `repo.find()` will fail with "Document
 * ... is unavailable" — this peer has no local copy and no connected peer to
 * fetch it from yet. connect to the owning peer first (see `addPeer` in
 * skein-bridge.ts), then use `joinCanvas()` below to open the shared doc.
 */
async function initSkeinP2PForTest(options: P2PTestInitOptions = {}): Promise<P2PTestInitResult> {
  // build the repo (broadcast + iroh) and canvas doc via the harness (see
  // harness/skein-harness.ts — phase 2 step 4 of the SkeinHarness
  // extraction) instead of hand-rolling ensureIdentity/IrohNetworkAdapter/
  // Repo here. "both" mirrors what this file built by hand before: iroh for
  // real cross-process peers, broadcast for same-browser-context tabs.
  const harness = await createSkeinHarness({
    network: "both",
    canvasDocId: options.canvasDocId ?? null,
  });
  sharedRepo = harness.repo;
  sharedMountElement = document.getElementById("canvas-root")!;
  sharedIrohAdapter = harness.iroh!;

  // pass the already-resolved doc id so initCanvas does not create its own
  const canvas = await initCanvas({
    mountElement: sharedMountElement,
    canvasDocId: harness.store.handle.documentId,
    registry: createTestRegistry(),
    repo: harness.repo,
    restrictBlobToPeers: (blake3Hash, peerNodeIds) =>
      harness.iroh!.restrictBlobToPeers(blake3Hash, peerNodeIds),
  });

  const irohAdapter = harness.iroh!;
  const p2pBridge = buildP2PBridge(irohAdapter);

  // wait for iroh to come online (the adapter starts async in the background
  // once it detects a stored identity via checkIdentityAndStart)
  await p2pBridge.waitForOnline(15_000);

  const nodeId = await p2pBridge.getNodeId();

  // the harness's CanvasStore.create()/open() never sets a local node id or
  // stamps an admin the way production's real canvas-creation flow does
  // (see standalone/boot.ts) — without this, every canvas built through
  // this harness has an empty `.acl`, so `store.isAdmin()`/`isLocalAdmin()`
  // always default to `false` for everyone, including the creator. this bit
  // knock-flow.spec.ts once real admin-only gating was added to
  // approveKnock()/declineKnock() (friendz-wiring.ts).
  canvas.store.setLocalNodeId(nodeId);
  if (!options.canvasDocId) {
    // only stamp when this peer created the canvas itself — a peer that
    // joined an existing canvas via `options.canvasDocId` shouldn't
    // self-stamp as admin before the real admin's `.acl` has synced over
    // (stampAdmin() is a no-op once *any* admin exists, but a race where
    // the join happens before that sync completes could otherwise create
    // two admins on the same canvas).
    canvas.store.stampAdmin(nodeId);
  }

  // wire up a real FriendzProtocol instance so tests can drive the
  // skein-friendz/1 handshake (friend requests, accepts) against another
  // browser peer or a real reliquary hub — production wiring for this lives
  // in standalone/friendz-wiring.ts, which writes into the real social
  // automerge doc; this harness has no narthex/social doc, so accepted
  // friends are tracked in a plain in-memory set instead (see
  // buildFriendzTestBridge in test-bridge.ts).
  const acceptedFriends = new Set<string>();
  const friendzProtocol = new FriendzProtocol({
    getMidden: () => irohAdapter.getNode(),
    localNodeId: nodeId,
    localUsername: "test-peer",
    getLocalProfile: () => ({ username: "test-peer", bio: "", avatarDataUrl: "" }),
    isFriend: (peerNodeId) => acceptedFriends.has(peerNodeId),
    profileVisibility: "everyone",
    friendRequestsFrom: "everyone",
  });
  irohAdapter.registerAlpnHandler(FRIENDZ_ALPN, (stream) => {
    friendzProtocol.handleStream(stream);
  });
  const friendzBridge = buildFriendzTestBridge(friendzProtocol, acceptedFriends);

  // knock (access-request) test bridge — wires the real `canvas-knock*`
  // message handlers and gossip-digest merge logic
  // (`standalone/friendz-wiring.ts`'s `wireKnockHandlers`/
  // `mergeGossipDigestKnocks`) onto the same protocol instance. `getStore`
  // reads back through `window.__skeinTest.canvas` (rather than closing
  // over `canvas` directly) so it keeps working after `joinCanvasForTest`
  // below swaps the active canvas out.
  const knockBridge = buildKnockTestBridge({
    protocol: friendzProtocol,
    getStore: () => (window as any).__skeinTest.canvas.store,
    repo: harness.repo,
    irohAdapter,
    localNodeId: nodeId,
  });

  // profile-doc gossip test bridge (docs/hub-and-profile-plan.md section 6)
  // — own dedicated ProfileStore per test peer (this harness has no real
  // "my own profile doc" discovery/boot.ts wiring, so create one fresh
  // rather than trying to reuse ensureMyProfileDoc()'s IndexedDB-meta-key
  // singleton pattern, which is specific to the real app's boot sequence).
  const profileStore = ProfileStore.create(harness.repo);
  const profileGossipBridge = buildProfileGossipTestBridge({
    protocol: friendzProtocol,
    repo: harness.repo,
    profileStore,
    localNodeId: nodeId,
  });

  // expose the typed bridge as the single window test entry point
  (window as any).__skeinTest = {
    canvas,
    p2p: p2pBridge,
    friendz: friendzBridge,
    knock: knockBridge,
    profileGossip: profileGossipBridge,
  };

  // backward-compat aliases used by existing tests
  (window as any).__skein = canvas;
  (window as any).__skeinHelpers = { createWidgetDoc, testWidgetSchema, Viewport, PresenceManager };

  return { canvasDocId: canvas.store.handle.documentId, nodeId };
}

(window as any).__initSkeinP2PForTest = initSkeinP2PForTest;

/**
 * open a canvas document that lives on an already-connected peer.
 *
 * call this only *after* dialing the owning peer (see `addPeer` in
 * skein-bridge.ts) — opening a doc before any peer connection exists means
 * `repo.find()` has nothing to sync from and will mark the document
 * unavailable. reuses the existing repo/iroh endpoint from
 * `initSkeinP2PForTest`; destroys and replaces the current canvas.
 *
 * no retry loop here: `CanvasStore.open()` (used internally by
 * `initCanvas()`) already waits out a transient "unavailable" verdict via
 * automerge-repo's own event-driven `whenReady()` recovery — see its doc
 * comment in canvas-store.ts. a manual retry loop used to live here,
 * silently working around the exact same failure mode as a real,
 * user-reported production crash (2026-07-03) — which is exactly why e2e
 * coverage never caught it before now.
 */
async function joinCanvasForTest(docId: string): Promise<{ canvasDocId: string }> {
  if (!sharedRepo || !sharedMountElement) {
    throw new Error("joinCanvasForTest called before initSkeinP2PForTest");
  }

  const bridge = (window as any).__skeinTest;
  bridge.canvas.destroy();

  const canvas = await initCanvas({
    mountElement: sharedMountElement,
    canvasDocId: docId,
    registry: createTestRegistry(),
    repo: sharedRepo,
    restrictBlobToPeers: sharedIrohAdapter
      ? (blake3Hash, peerNodeIds) => sharedIrohAdapter!.restrictBlobToPeers(blake3Hash, peerNodeIds)
      : undefined,
  });

  bridge.canvas = canvas;
  (window as any).__skein = canvas;

  return { canvasDocId: canvas.store.handle.documentId };
}

(window as any).__joinCanvasForTest = joinCanvasForTest;

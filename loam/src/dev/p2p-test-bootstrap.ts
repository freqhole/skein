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
import { Viewport } from "../canvas/viewport";
import { createSkeinHarness } from "../harness/skein-harness";
import { FriendzProtocol } from "../p2p/friends-protocol";
import { FRIENDZ_ALPN } from "../p2p/iroh-network-adapter";
import { createWidgetDoc } from "../widgets/widget-doc";
import { buildFriendzTestBridge, buildP2PBridge } from "./test-bridge";

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

  // pass the already-resolved doc id so initCanvas does not create its own
  const canvas = await initCanvas({
    mountElement: sharedMountElement,
    canvasDocId: harness.store.handle.documentId,
    registry: createTestRegistry(),
    repo: harness.repo,
  });

  const irohAdapter = harness.iroh!;
  const p2pBridge = buildP2PBridge(irohAdapter);

  // wait for iroh to come online (the adapter starts async in the background
  // once it detects a stored identity via checkIdentityAndStart)
  await p2pBridge.waitForOnline(15_000);

  const nodeId = await p2pBridge.getNodeId();

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

  // expose the typed bridge as the single window test entry point
  (window as any).__skeinTest = { canvas, p2p: p2pBridge, friendz: friendzBridge };

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
 * even after `repo.peers` shows the peer connection, `repo.find()` on a
 * docId this repo has never seen before can still race: automerge-repo's
 * sync-message plumbing for a *brand new* document request needs a moment
 * to actually reach the other peer and get a response, and `repo.find()`
 * rejects with "Document ... is unavailable" if that round-trip doesn't
 * land in time. retry a few times with a short delay — this is a test-only
 * concern (real usage has much more time between connecting and opening a
 * shared doc, e.g. a human clicking an invite link).
 */
async function joinCanvasForTest(docId: string): Promise<{ canvasDocId: string }> {
  if (!sharedRepo || !sharedMountElement) {
    throw new Error("joinCanvasForTest called before initSkeinP2PForTest");
  }

  const bridge = (window as any).__skeinTest;
  bridge.canvas.destroy();

  const maxAttempts = 5;
  const delayMs = 1000;
  let canvas: Awaited<ReturnType<typeof initCanvas>> | null = null;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      canvas = await initCanvas({
        mountElement: sharedMountElement,
        canvasDocId: docId,
        registry: createTestRegistry(),
        repo: sharedRepo,
      });
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  if (!canvas) {
    throw lastErr;
  }

  bridge.canvas = canvas;
  (window as any).__skein = canvas;

  return { canvasDocId: canvas.store.handle.documentId };
}

(window as any).__joinCanvasForTest = joinCanvasForTest;

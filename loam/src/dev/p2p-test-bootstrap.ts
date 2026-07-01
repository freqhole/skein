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

import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { z } from "zod";
import { createTestRegistry } from "../../widgets/index";
import { initCanvas } from "../canvas/init";
import { PresenceManager } from "../canvas/presence-manager";
import { Viewport } from "../canvas/viewport";
import { ensureIdentity, getMiddenNode } from "../p2p/identity";
import { IrohNetworkAdapter, type MiddenStreamNode } from "../p2p/iroh-network-adapter";
import { createWidgetDoc } from "../widgets/widget-doc";
import { buildP2PBridge } from "./test-bridge";

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
  // ensure a P2P identity exists — creates one the first time, restores on
  // subsequent calls (identity is persisted in the browser context's IndexedDB).
  await ensureIdentity();

  // build a repo that combines BroadcastChannel (for same-browser-context tabs)
  // and iroh QUIC (for real cross-process / cross-browser networking).
  const storage = new IndexedDBStorageAdapter();
  const getMidden = async (): Promise<MiddenStreamNode> =>
    (await getMiddenNode()) as unknown as MiddenStreamNode;
  const irohAdapter = new IrohNetworkAdapter(getMidden);
  const repo = new Repo({
    storage,
    network: [new BroadcastChannelNetworkAdapter(), irohAdapter],
  });
  sharedRepo = repo;
  sharedMountElement = document.getElementById("canvas-root")!;

  // pass the pre-built repo so initCanvas does not create its own
  const canvas = await initCanvas({
    mountElement: sharedMountElement,
    canvasDocId: options.canvasDocId ?? null,
    registry: createTestRegistry(),
    repo,
  });

  const p2pBridge = buildP2PBridge(irohAdapter);

  // wait for iroh to come online (the adapter starts async in the background
  // once it detects a stored identity via checkIdentityAndStart)
  await p2pBridge.waitForOnline(15_000);

  const nodeId = await p2pBridge.getNodeId();

  // expose the typed bridge as the single window test entry point
  (window as any).__skeinTest = { canvas, p2p: p2pBridge };

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
  });

  bridge.canvas = canvas;
  (window as any).__skein = canvas;

  return { canvasDocId: canvas.store.handle.documentId };
}

(window as any).__joinCanvasForTest = joinCanvasForTest;

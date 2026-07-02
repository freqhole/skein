// SkeinHarness — the non-presentation half of a skein canvas.
//
// phase 2 of the harness extraction (see docs/skein-runtime-plan.md
// § "proposed: SkeinHarness" and § "migration path — phase 2"). step 1
// (done) covered the pieces `test-bootstrap.ts` and `sync-test-bootstrap.ts`
// hand-built themselves: an automerge `Repo` and a `CanvasStore`
// opened/created on it. step 4 (this revision) adds real iroh p2p
// networking, mirroring what `p2p-test-bootstrap.ts` used to hand-build.
//
// deliberately does NOT yet own `PresenceManager`, `identity` (as a general
// seam — iroh's own identity is wired up internally), or `blobs` — those get
// pulled in as later steps once `initCanvas()` is updated to accept a
// harness and stop constructing its own `PresenceManager` (adding presence
// here first would risk two independent `PresenceManager` instances
// fighting over the same ephemeral channel — see the plan doc).

import type { DocumentId, NetworkAdapter } from "@automerge/automerge-repo";
import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { CanvasStore } from "../canvas/canvas-store";
import { ensureIdentity, getMiddenNode } from "../p2p/identity";
import { IrohNetworkAdapter, type MiddenStreamNode } from "../p2p/iroh-network-adapter";
import { handleSkeinStream } from "../p2p/skein-handler";

export interface SkeinHarnessOptions {
  /**
   * network adapters to use:
   * - "broadcast" (default) — same-browser-context only, good for unit-ish
   *   harness tests and cross-tab sync.
   * - "iroh" — real p2p over iroh QUIC only. ensures a P2P identity exists
   *   (`ensureIdentity()`) and builds an `IrohNetworkAdapter`.
   * - "both" — broadcast + iroh together (this is what the real app and
   *   the p2p test bootstrap both want: same-tab sync stays instant while
   *   iroh handles cross-process/cross-browser peers).
   * - "none" — skip network entirely (rare — a fully offline single-peer
   *   harness).
   *
   * ignored if `networkAdapter` or `repo` is provided.
   */
  network?: "broadcast" | "iroh" | "both" | "none";
  /**
   * escape hatch for callers that need a network adapter this module doesn't
   * know how to construct. when provided, `network` is ignored and
   * `harness.iroh` stays `null` (this module didn't build the adapter, so it
   * has nothing typed to hand back).
   */
  networkAdapter?: NetworkAdapter;
  /**
   * skip the IndexedDB storage adapter entirely (ephemeral repo — doc state
   * only exists in memory / synced from peers). mirrors what
   * `sync-test-bootstrap.ts` does today to avoid IDB write-lock contention
   * with a primary peer's repo in the same browser context.
   */
  ephemeralStorage?: boolean;
  /** seed an existing canvas doc instead of creating a fresh one. */
  canvasDocId?: string | null;
  /**
   * escape hatch for callers that already have a fully-built `Repo` (e.g.
   * the real app in `boot.ts`, which shares one repo across the narthex and
   * every canvas). when provided, `network`/`networkAdapter`/`ephemeralStorage`
   * are ignored, and `harness.iroh` stays `null`.
   */
  repo?: Repo;
}

export interface SkeinHarness {
  /** the automerge repo — storage + network + doc handle cache. */
  readonly repo: Repo;
  /** the canvas automerge doc, wrapped with typed mutation methods. */
  readonly store: CanvasStore;
  /**
   * the iroh network adapter, when `network` was `"iroh"` or `"both"`.
   * `null` for broadcast-only/none harnesses, or when a pre-built `repo` /
   * `networkAdapter` escape hatch was used instead.
   */
  readonly iroh: IrohNetworkAdapter | null;
  /** tear down the harness. disconnects `iroh` (if present) — `Repo` and
   *  `CanvasStore` don't own any other resources that need explicit cleanup
   *  today, but callers should still call this so future harness members
   *  (presence, blobs) have a single place to add teardown logic. */
  destroy(): void;
}

/**
 * build the non-presentation half of a skein canvas: a `Repo` (storage +
 * network), a `CanvasStore` opened or created on it, and (optionally) an
 * `IrohNetworkAdapter` for real p2p networking.
 *
 * this is a straight extraction of what `test-bootstrap.ts`,
 * `sync-test-bootstrap.ts`, and `p2p-test-bootstrap.ts` each used to build
 * by hand — see those files for the code this is meant to replace.
 */
export async function createSkeinHarness(
  options: SkeinHarnessOptions = {}
): Promise<SkeinHarness> {
  let repo: Repo;
  let iroh: IrohNetworkAdapter | null = null;

  if (options.repo) {
    repo = options.repo;
  } else if (options.networkAdapter) {
    repo = new Repo({
      storage: options.ephemeralStorage ? undefined : new IndexedDBStorageAdapter(),
      network: [options.networkAdapter],
    });
  } else {
    const mode = options.network ?? "broadcast";
    const network: NetworkAdapter[] = [];

    if (mode === "broadcast" || mode === "both") {
      network.push(new BroadcastChannelNetworkAdapter());
    }

    if (mode === "iroh" || mode === "both") {
      // ensure a P2P identity exists — creates one the first time, restores
      // on subsequent calls (identity is persisted in IndexedDB).
      await ensureIdentity();
      const getMidden = async (): Promise<MiddenStreamNode> =>
        (await getMiddenNode()) as unknown as MiddenStreamNode;
      iroh = new IrohNetworkAdapter(getMidden);

      // register the skein/1 handler so this peer can serve blobs (and
      // answer ensure_blob probes) to other peers/hubs — mirrors what
      // boot.ts/friendz-wiring.ts do for the production app. without this,
      // any peer built via this harness silently drops inbound skein/1
      // streams (see iroh-network-adapter.ts's accept loop), which broke
      // the hub's blob-snatch pipeline in e2e tests.
      iroh.registerAlpnHandler("skein/1", handleSkeinStream);
      network.push(iroh);
    }

    repo = new Repo({
      storage: options.ephemeralStorage ? undefined : new IndexedDBStorageAdapter(),
      network,
    });
  }

  const store = options.canvasDocId
    ? await CanvasStore.open(repo, options.canvasDocId as DocumentId)
    : CanvasStore.create(repo);

  return {
    repo,
    store,
    iroh,
    destroy() {
      iroh?.disconnect();
    },
  };
}

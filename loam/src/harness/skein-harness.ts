// SkeinHarness — the non-presentation half of a skein canvas.
//
// phase 2, step 1 of the harness extraction (see
// docs/skein-runtime-plan.md § "proposed: SkeinHarness" and
// § "migration path — phase 2"). owns exactly the pieces that
// `test-bootstrap.ts` and `sync-test-bootstrap.ts` currently hand-build
// themselves: an automerge `Repo` and a `CanvasStore` opened/created on it.
//
// deliberately does NOT yet own `PresenceManager`, `identity`, `blobs`, or
// `iroh` — those get pulled in as later steps once `initCanvas()` is updated
// to accept a harness and stop constructing its own `PresenceManager`
// (adding presence here first would risk two independent `PresenceManager`
// instances fighting over the same ephemeral channel — see the plan doc).

import type { DocumentId, NetworkAdapter } from "@automerge/automerge-repo";
import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { CanvasStore } from "../canvas/canvas-store";

export interface SkeinHarnessOptions {
  /**
   * network adapters to use. "broadcast" (default) is same-browser-context
   * only — good for unit-ish harness tests and cross-tab sync. "none" skips
   * network entirely (rare — a fully offline single-peer harness).
   *
   * ignored if `networkAdapter` or `repo` is provided.
   */
  network?: "broadcast" | "none";
  /**
   * escape hatch for callers that need a network adapter this module doesn't
   * know how to construct (e.g. `IrohNetworkAdapter` — real p2p networking
   * isn't wired into the harness yet, see plan doc phase 2 step 4).
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
   * are ignored.
   */
  repo?: Repo;
}

export interface SkeinHarness {
  /** the automerge repo — storage + network + doc handle cache. */
  readonly repo: Repo;
  /** the canvas automerge doc, wrapped with typed mutation methods. */
  readonly store: CanvasStore;
  /** tear down the harness. currently a no-op placeholder — `Repo` and
   *  `CanvasStore` don't own any resources that need explicit cleanup today,
   *  but callers should still call this so future harness members
   *  (presence, iroh, blobs) have a single place to add teardown logic. */
  destroy(): void;
}

/**
 * build the non-presentation half of a skein canvas: a `Repo` (storage +
 * network) and a `CanvasStore` opened or created on it.
 *
 * this is a straight extraction of what `test-bootstrap.ts` and
 * `sync-test-bootstrap.ts` each currently build by hand — see those files
 * for the code this is meant to replace.
 */
export async function createSkeinHarness(
  options: SkeinHarnessOptions = {}
): Promise<SkeinHarness> {
  let repo: Repo;

  if (options.repo) {
    repo = options.repo;
  } else {
    const network: NetworkAdapter[] = options.networkAdapter
      ? [options.networkAdapter]
      : options.network === "none"
        ? []
        : [new BroadcastChannelNetworkAdapter()];

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
    destroy() {
      // nothing to tear down yet — placeholder for future harness members.
    },
  };
}

// SkeinHarness — the non-presentation half of a skein canvas.
//
// phase 2 of the harness extraction (see docs/skein-runtime-plan.md
// § "proposed: SkeinHarness" and § "migration path — phase 2"). step 1
// (done) covered the pieces `test-bootstrap.ts` and `sync-test-bootstrap.ts`
// hand-built themselves: an automerge `Repo` and a `CanvasStore`
// opened/created on it. step 4 added real iroh p2p networking, mirroring
// what `p2p-test-bootstrap.ts` used to hand-build. step 5 (this revision)
// makes the iroh transport pluggable (browser midden WASM vs. tauri's
// rust-backed transport), lets a caller wrap the raw iroh adapter before it
// reaches the repo's network list (ACL filtering), lets a caller skip the
// eager `ensureIdentity()` call, and lets a caller skip building a
// `CanvasStore` entirely — all needed to migrate `standalone/boot.ts` (the
// real app) onto the harness.
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
import { ensureIdentity, getMiddenNode as getDefaultMiddenNode } from "../p2p/identity";
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
  /**
   * transport-node factory used to build the iroh adapter (only consulted
   * when `network` is `"iroh"` or `"both"`). defaults to the browser midden
   * WASM node (`getMiddenNode()` from `p2p/identity.ts`). callers that need
   * a different transport — e.g. the real app under tauri, which routes p2p
   * through the rust backend's iroh endpoint instead of midden WASM — pass
   * their own factory here instead.
   */
  getMiddenNode?: () => Promise<MiddenStreamNode>;
  /**
   * wrap the raw iroh adapter before it's added to the repo's network list
   * (e.g. the real app's ACL filtering). `harness.iroh` still returns the
   * *unwrapped* adapter — callers need direct access to it for things like
   * `registerAlpnHandler` and connection-state introspection — only the
   * repo's network array sees the wrapped version.
   */
  wrapNetworkAdapter?: (adapter: IrohNetworkAdapter) => NetworkAdapter;
  /**
   * skip the `await ensureIdentity()` call this module normally makes
   * before constructing the iroh adapter. `IrohNetworkAdapter` itself
   * already lazily checks for a stored identity and starts once one shows
   * up (`checkIdentityAndStart`/`onIdentityChange` in
   * `iroh-network-adapter.ts`), so callers that don't want to force-create
   * a P2P identity just by building a harness — the real app should only
   * generate an identity when the user actually shares/joins a canvas —
   * should set this to `true`.
   */
  skipEnsureIdentity?: boolean;
  /**
   * skip creating/opening a `CanvasStore` entirely — `harness.store` is
   * `null`. for callers (like the real app's router) that manage many
   * canvas docs lazily per-navigation and don't want a fresh, unused
   * automerge doc created as a side effect of building a harness.
   */
  skipStore?: boolean;
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
 * variant returned when `skipStore: true` is passed — no `CanvasStore` is
 * created/opened, so `store` is `null`. used by callers that manage many
 * canvas docs lazily instead of wanting one fresh/opened automerge doc
 * built for them on every harness construction (see `skipStore` above).
 */
export interface SkeinHarnessNoStore {
  readonly repo: Repo;
  readonly store: null;
  readonly iroh: IrohNetworkAdapter | null;
  destroy(): void;
}

/**
 * build the non-presentation half of a skein canvas: a `Repo` (storage +
 * network), a `CanvasStore` opened or created on it (unless `skipStore` is
 * set), and (optionally) an `IrohNetworkAdapter` for real p2p networking.
 *
 * this is a straight extraction of what `test-bootstrap.ts`,
 * `sync-test-bootstrap.ts`, and `p2p-test-bootstrap.ts` each used to build
 * by hand — see those files for the code this is meant to replace.
 */
export function createSkeinHarness(
  options?: SkeinHarnessOptions & { skipStore?: false }
): Promise<SkeinHarness>;
export function createSkeinHarness(
  options: SkeinHarnessOptions & { skipStore: true }
): Promise<SkeinHarnessNoStore>;
export async function createSkeinHarness(
  options: SkeinHarnessOptions = {}
): Promise<SkeinHarness | SkeinHarnessNoStore> {
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
      // on subsequent calls (identity is persisted in IndexedDB). skippable
      // (see `skipEnsureIdentity`) for callers whose iroh adapter already
      // handles identity lazily and don't want a harness construction to
      // force-create one.
      if (!options.skipEnsureIdentity) {
        await ensureIdentity();
      }
      const getMidden =
        options.getMiddenNode ??
        (async (): Promise<MiddenStreamNode> =>
          (await getDefaultMiddenNode()) as unknown as MiddenStreamNode);
      iroh = new IrohNetworkAdapter(getMidden);

      // register the skein/1 handler so this peer can serve blobs (and
      // answer ensure_blob probes) to other peers/hubs — mirrors what
      // boot.ts/friendz-wiring.ts do for the production app. without this,
      // any peer built via this harness silently drops inbound skein/1
      // streams (see iroh-network-adapter.ts's accept loop), which broke
      // the hub's blob-snatch pipeline in e2e tests.
      iroh.registerAlpnHandler("skein/1", handleSkeinStream);
      network.push(options.wrapNetworkAdapter ? options.wrapNetworkAdapter(iroh) : iroh);
    }

    repo = new Repo({
      storage: options.ephemeralStorage ? undefined : new IndexedDBStorageAdapter(),
      network,
    });
  }

  const store = options.skipStore
    ? null
    : options.canvasDocId
      ? await CanvasStore.open(repo, options.canvasDocId as DocumentId)
      : CanvasStore.create(repo);

  return {
    repo,
    store,
    iroh,
    destroy() {
      iroh?.disconnect();
    },
  } as SkeinHarness | SkeinHarnessNoStore;
}

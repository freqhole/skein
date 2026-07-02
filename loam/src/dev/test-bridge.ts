import type { SkeinCanvas } from "../canvas/init";
import type { EndpointState, IrohNetworkAdapter } from "../p2p/iroh-network-adapter";
import { storeBlob, classifyDomain } from "../storage/skein-blob-store";

/**
 * p2p test bridge — methods only available when the page was bootstrapped
 * with a real IrohNetworkAdapter (test-harness-p2p.html).
 */
export interface SkeinP2PBridge {
  /** this instance's iroh node ID (async — may need to wait for midden to init) */
  getNodeId(): Promise<string>;
  /** dial a peer by node ID and keep the connection alive */
  addPeer(nodeId: string): Promise<void>;
  /** read the current endpoint lifecycle state synchronously */
  getEndpointState(): EndpointState;
  /**
   * resolve once the endpoint reaches "online", or reject after timeoutMs.
   * default timeout: 30 000 ms.
   */
  waitForOnline(timeoutMs?: number): Promise<void>;
  /**
   * import raw bytes into this peer's midden iroh-blobs store AND register a
   * matching local blob record (mirrors what `widgets/file.ts`'s real upload
   * flow does via `storeBlobFromFile`). returns the blake3 hex hash — use
   * this as the canonical `blake3` field on a file widget's state doc for
   * tests that need a peer to actually have a blob available for
   * snatch/download.
   *
   * registering the local blob record matters: the file widget's own
   * `checkLocality()` looks the blob up in this peer's local blob store
   * (IndexedDB/OPFS), not midden's in-memory iroh-blobs store — if it isn't
   * found there, the widget assumes the blob is remote and strips this
   * peer's node id back out of `snatchedBy` on mount, which starves the hub
   * of any peer to probe.
   */
  importBlob(data: Uint8Array, options?: { filename?: string; mime?: string }): Promise<string>;
  /**
   * fetch a blob's bytes directly from another peer by node id + blake3
   * hash, using midden's `download_verified_with_ensure` (the same
   * verified iroh-blobs transfer `widgets/file-utils.ts` uses for full
   * blob downloads). this talks straight to the peer's raw iroh endpoint —
   * it does not go through the canvas doc or `AclFilteringNetworkAdapter`
   * at all, which is exactly what makes it useful for testing whether blob
   * access is (or isn't) gated by canvas membership.
   */
  fetchBlob(peerNodeId: string, blake3Hash: string): Promise<Uint8Array>;
}

/**
 * social test bridge — present on `window.__skeinTest.social` when the full
 * boot router has initialised (i.e. the page loaded index.html, not a test
 * harness page). populated in DEV builds only.
 */
export interface SkeinTestBridgeSocial {
  /** the live standalone social doc (profile, friends, requests, etc.) */
  readonly doc: { current: Record<string, unknown> } | null;
  /** generate or restore a P2P identity. mirrors identity.ts ensureIdentity(). */
  ensureIdentity(): Promise<{ node_id: string }>;
  /** open / close the social overlay panel */
  toggleOverlay(): void;
  /** trigger the avatar file picker (set by profile-tab on mount) */
  pickAvatar?(): Promise<void>;
}

/**
 * the single window-level test bridge placed on `window.__skeinTest`.
 *
 * consolidates all test-time APIs into one typed, documented object — no more
 * scattered `window.__*` hooks spread across source files.
 *
 * populated in dev mode only; never present in production builds.
 */
export interface SkeinTestBridge {
  /** the running skein canvas instance */
  canvas: SkeinCanvas;
  /**
   * social helpers — present when the full boot router is running (index.html).
   * null when using test harness pages (test-harness.html etc.).
   */
  social?: SkeinTestBridgeSocial;
  /**
   * p2p helpers — present only when the page was bootstrapped via
   * test-harness-p2p.html / p2p-test-bootstrap.ts.
   * null for ordinary BroadcastChannel-only test pages.
   */
  p2p: SkeinP2PBridge | null;
}

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

/**
 * build a SkeinP2PBridge from a live IrohNetworkAdapter.
 * call this from test bootstrap code after creating the adapter.
 */
export function buildP2PBridge(adapter: IrohNetworkAdapter): SkeinP2PBridge {
  return {
    async getNodeId(): Promise<string> {
      const node = await adapter.getNode();
      return node.node_id();
    },

    addPeer(nodeId: string): Promise<void> {
      return adapter.addPeer(nodeId);
    },

    getEndpointState(): EndpointState {
      return adapter.getEndpointState();
    },

    async waitForOnline(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (adapter.getEndpointState() !== "online") {
        if (Date.now() > deadline) {
          const state = adapter.getEndpointState();
          throw new Error(
            `iroh endpoint did not reach "online" within ${timeoutMs}ms (state: "${state}")`
          );
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
    },

    async importBlob(data: Uint8Array, options?: { filename?: string; mime?: string }): Promise<string> {
      const node = await adapter.getNode();
      // the MiddenStreamNode type only declares the transport-adjacent
      // methods this adapter needs; the underlying wasm node also exposes
      // iroh-blobs helpers like `import_blob`, used here to make test blobs
      // servable without depending on the full upload/widget UI flow.
      const nodeAny = node as unknown as { import_blob(data: Uint8Array): Promise<string> };
      const blake3 = await nodeAny.import_blob(data);

      // also register a local blob record, mirroring what a real upload
      // (storeBlobFromFile) does — without this, the blob only exists in
      // midden's in-memory iroh-blobs store, and checkBlobLocality (which
      // only looks at IndexedDB/OPFS) reports it as remote.
      const mime = options?.mime ?? "application/octet-stream";
      const filename = options?.filename ?? "test-blob";
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      await storeBlob(blake3, buffer, {
        blob_id: blake3,
        sha256: "",
        blake3,
        filename,
        mime,
        size: data.byteLength,
        domain: classifyDomain(mime),
        blob_type: "original",
        parent_blob_id: null,
        metadata: {},
      });

      return blake3;
    },

    async fetchBlob(peerNodeId: string, blake3Hash: string): Promise<Uint8Array> {
      const node = await adapter.getNode();
      // same reasoning as importBlob() above: `download_verified_with_ensure`
      // is a real midden wasm export (see midden/src/lib.rs), not part of
      // the narrow MiddenStreamNode transport interface this adapter needs.
      const nodeAny = node as unknown as {
        download_verified_with_ensure(peerAddr: string, blake3: string): Promise<Uint8Array>;
      };
      return nodeAny.download_verified_with_ensure(peerNodeId, blake3Hash);
    },
  };
}

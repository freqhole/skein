import { cbor } from "@automerge/automerge-repo";

import type { SkeinCanvas } from "../canvas/init";
import type { FriendzProtocol } from "../p2p/friends-protocol";
import type { EndpointState, IrohNetworkAdapter } from "../p2p/iroh-network-adapter";
import { storeBlob, classifyDomain } from "../storage/skein-blob-store";

/**
 * ALPN for reliquary's remote hub-administration protocol
 * (`reliquary/src/protocol/hub_admin.rs`). lets an authenticated remote
 * admin peer manage the hub's friendz allow-list over the network.
 */
const HUB_ADMIN_ALPN = "iroh/skein-hub-admin/1";

/**
 * max response size to read back from a hub admin request. matches
 * reliquary's own `MAX_MESSAGE_SIZE` in `protocol/hub_admin.rs`.
 */
const DEFAULT_MAX_ADMIN_RESPONSE_BYTES = 1024 * 1024;

/**
 * request payloads for `iroh/skein-hub-admin/1`, mirroring
 * `reliquary::protocol::hub_admin::AdminRequest`.
 */
export type AdminRequest =
  | { kind: "allow"; nodeId: string }
  | { kind: "list" }
  | { kind: "remove"; nodeId: string };

/** a single friendz row, as reported by an `AdminResponse::List`. */
export interface AdminFriendSummary {
  nodeId: string;
  status: string;
  updatedAt: number;
}

/**
 * response payloads for `iroh/skein-hub-admin/1`, mirroring
 * `reliquary::protocol::hub_admin::AdminResponse`.
 */
export type AdminResponse =
  | { kind: "allowed"; nodeId: string; status: string }
  | { kind: "list"; friends: AdminFriendSummary[] }
  | { kind: "removed"; nodeId: string }
  | { kind: "notAdmin" }
  | { kind: "error"; message: string };

/**
 * build the CBOR-ready wire value for an `AdminRequest`, matching serde's
 * default externally-tagged enum representation (the shape `ciborium`
 * produces/expects on the reliquary side): a unit variant like `List`
 * encodes as just its variant name, a struct variant like `Allow { .. }`
 * encodes as a single-key map `{ Allow: { node_id: .. } }`.
 */
function toWireAdminRequest(request: AdminRequest): unknown {
  switch (request.kind) {
    case "allow":
      return { Allow: { node_id: request.nodeId } };
    case "list":
      return "List";
    case "remove":
      return { Remove: { node_id: request.nodeId } };
  }
}

/** parse the CBOR-decoded wire value for an `AdminResponse` back into our TS shape. */
function fromWireAdminResponse(wire: unknown): AdminResponse {
  if (wire === "NotAdmin") {
    return { kind: "notAdmin" };
  }
  if (wire && typeof wire === "object") {
    const obj = wire as Record<string, unknown>;
    if ("Allowed" in obj) {
      const v = obj.Allowed as { node_id: string; status: string };
      return { kind: "allowed", nodeId: v.node_id, status: v.status };
    }
    if ("List" in obj) {
      const v = obj.List as {
        friends: Array<{ node_id: string; status: string; updated_at: number }>;
      };
      return {
        kind: "list",
        friends: v.friends.map((f) => ({
          nodeId: f.node_id,
          status: f.status,
          updatedAt: f.updated_at,
        })),
      };
    }
    if ("Removed" in obj) {
      const v = obj.Removed as { node_id: string };
      return { kind: "removed", nodeId: v.node_id };
    }
    if ("Error" in obj) {
      const v = obj.Error as { message: string };
      return { kind: "error", message: v.message };
    }
  }
  throw new Error(`unrecognized AdminResponse wire shape: ${JSON.stringify(wire)}`);
}

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
  /**
   * PROTOTYPE test hook for the blob-ACL gating spike (see
   * `midden::build_gated_blobs_events` / `MiddenNode::restrict_blob_to_peers`
   * in `midden/src/lib.rs`): restricts a blob (by blake3 hash) on THIS
   * peer's `iroh_blobs::BlobsProtocol` so only the given peer node ids may
   * fetch it. a hash never passed to this method is unrestricted (today's
   * default, unchanged) — this is a stopgap demo of the extension point,
   * not the real canvas-ACL integration.
   */
  restrictBlobToPeers(blake3Hash: string, peerNodeIds: string[]): Promise<void>;
  /**
   * dial a hub's `iroh/skein-hub-admin/1` remote admin protocol and send a
   * single request, returning its parsed response. opens a raw bidirectional
   * stream via the underlying midden node (same `open_bi` mechanism
   * `importBlob`/`fetchBlob` use), writes a CBOR-encoded request terminated
   * by `finish()`, then reads the CBOR-encoded response back with
   * `read_to_end()` — mirrors reliquary's `protocol::hub_admin` framing.
   *
   * the caller is only treated as an admin if their own node id is already
   * in the hub's `hub_adminz` table (bootstrapped locally, e.g. via
   * `ReliquaryHubHandle.adminAllow()` in tests) — a non-admin caller gets
   * back a `{ kind: "notAdmin" }` response and nothing changes hub-side.
   */
  hubAdminRequest(peerNodeId: string, request: AdminRequest): Promise<AdminResponse>;
}

/**
 * friendz test bridge — methods only available when the page was
 * bootstrapped with a real FriendzProtocol instance (test-harness-p2p.html).
 *
 * this drives the `skein-friendz/1` handshake against any peer by node id —
 * another browser peer or a real reliquary hub, the protocol doesn't
 * distinguish between the two. production wiring lives in
 * `standalone/friendz-wiring.ts` and writes into the real social automerge
 * doc; this test bridge tracks accepted friends in a plain in-memory set
 * instead, since the p2p test harness has no narthex/social doc set up.
 */
export interface SkeinFriendzTestBridge {
  /** send a friend request to a peer by node id. */
  sendFriendRequest(peerNodeId: string): Promise<void>;
  /** whether a peer's friend request has been accepted (mutual friendship
   *  established locally, tracked since the harness page loaded). */
  isFriend(peerNodeId: string): boolean;
  /** all peer node ids currently recorded as accepted friends. */
  getFriends(): string[];
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
  /**
   * friendz helpers — present only when the page was bootstrapped via
   * test-harness-p2p.html / p2p-test-bootstrap.ts.
   * null for ordinary BroadcastChannel-only test pages.
   */
  friendz?: SkeinFriendzTestBridge | null;
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

    async restrictBlobToPeers(blake3Hash: string, peerNodeIds: string[]): Promise<void> {
      const node = await adapter.getNode();
      // `restrict_blob_to_peers` is the prototype gating hook exposed by
      // midden (see midden/src/lib.rs); not part of MiddenStreamNode.
      const nodeAny = node as unknown as {
        restrict_blob_to_peers(blake3: string, peerNodeIds: string[]): void;
      };
      nodeAny.restrict_blob_to_peers(blake3Hash, peerNodeIds);
    },

    async hubAdminRequest(peerNodeId: string, request: AdminRequest): Promise<AdminResponse> {
      const node = await adapter.getNode();
      // `open_bi` is part of the narrow MiddenStreamNode interface already,
      // but the raw (non-length-delimited) framing methods used by
      // `skein/1`/`skein-hub-admin/1`-style protocols aren't — same pattern
      // as BiStreamLike's optional `read_to_end`/`write_raw_and_finish`.
      const stream = await node.open_bi(peerNodeId, HUB_ADMIN_ALPN);
      const streamAny = stream as unknown as {
        write_raw_and_finish(data: Uint8Array): Promise<void>;
        read_to_end(max_size: number): Promise<Uint8Array>;
        close(): void;
      };

      const wireRequest = toWireAdminRequest(request);
      const encoded = cbor.encode(wireRequest);
      await streamAny.write_raw_and_finish(encoded);
      const responseBytes = await streamAny.read_to_end(DEFAULT_MAX_ADMIN_RESPONSE_BYTES);
      streamAny.close();

      const wireResponse = cbor.decode(responseBytes);
      return fromWireAdminResponse(wireResponse);
    },
  };
}

/**
 * build a SkeinFriendzTestBridge from a live FriendzProtocol.
 *
 * wires `protocol.onFriendAccept` to record accepted friends into
 * `acceptedFriends` — the caller owns this set (and typically also passes
 * it as the `isFriend` predicate's backing store when constructing the
 * protocol itself), since the protocol constructor needs an `isFriend`
 * callback before the bridge can exist to provide one.
 */
export function buildFriendzTestBridge(
  protocol: FriendzProtocol,
  acceptedFriends: Set<string>
): SkeinFriendzTestBridge {
  protocol.onFriendAccept = (_msg, fromNodeId) => {
    acceptedFriends.add(fromNodeId);
  };

  return {
    async sendFriendRequest(peerNodeId: string): Promise<void> {
      await protocol.sendFriendRequest(peerNodeId);
    },

    isFriend(peerNodeId: string): boolean {
      return acceptedFriends.has(peerNodeId);
    },

    getFriends(): string[] {
      return [...acceptedFriends];
    },
  };
}

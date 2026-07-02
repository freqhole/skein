// ---------------------------------------------------------------------------
// hub admin client — production `iroh/skein-hub-admin/1` protocol client.
//
// promotes the exact same open_bi + CBOR framing mechanics that
// `SkeinP2PBridge.hubAdminRequest` (`src/dev/test-bridge.ts`) already
// exercises against a real reliquary hub, into a real, importable,
// production-callable client — see docs/hub-and-profile-plan.md section 5.
//
// wire shapes mirror `reliquary::protocol::hub_admin::AdminRequest` /
// `AdminResponse` (`reliquary/src/protocol/hub_admin.rs`), including the
// `ListPendingKnocks` / `PendingKnocks` variants that `test-bridge.ts`'s
// copy doesn't cover yet — this module is the complete, canonical TS
// mirror of the current Rust enum shapes.
//
// deliberately independent of `test-bridge.ts` (not imported by it, doesn't
// import from it) — see this module's own request/response types below,
// which are a superset of test-bridge's. kept separate rather than merged
// so existing test-bridge-consuming e2e tests (`hub-admin.spec.ts`) are
// completely unaffected by this addition.
// ---------------------------------------------------------------------------

import { cbor } from "@automerge/automerge-repo";
import type { MiddenStreamNode } from "./iroh-network-adapter";

/** ALPN protocol identifier for reliquary's remote hub-administration protocol. */
const HUB_ADMIN_ALPN = "iroh/skein-hub-admin/1";

/**
 * max response size to read back from a hub admin request. matches
 * reliquary's own `MAX_MESSAGE_SIZE` in `protocol/hub_admin.rs`.
 */
const DEFAULT_MAX_ADMIN_RESPONSE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// wire types
// ---------------------------------------------------------------------------

/** a single friendz row, as reported by an `AdminResponse::List`. */
export interface HubAdminFriendSummary {
  nodeId: string;
  status: string;
  updatedAt: number;
}

/**
 * a single pending knock, aggregated across every canvas doc the hub
 * holds, as reported by `AdminResponse::PendingKnocks`. read-only — this
 * panel never approves/declines a knock (see
 * docs/hub-and-profile-plan.md section 5 and
 * docs/knock-and-hub-relay-plan.md section 8's `ListPendingKnocks` note).
 */
export interface HubAdminPendingKnockSummary {
  canvasDocId: string;
  /** stable id for this knock in listings — the requester's node id,
   *  exposed under its own name (mirrors `HubKnockSummary.knock_id`
   *  in `hub_admin.rs`). */
  knockId: string;
  requesterNodeId: string;
  requesterUsername: string;
  message: string;
  /** unix seconds (matches `HubKnockSummary.knocked_at`'s
   *  `OffsetDateTime::unix_timestamp()`). */
  knockedAt: number;
}

/**
 * request payloads for `iroh/skein-hub-admin/1`, mirroring
 * `reliquary::protocol::hub_admin::AdminRequest`.
 */
export type HubAdminRequest =
  | { kind: "allow"; nodeId: string }
  | { kind: "list" }
  | { kind: "remove"; nodeId: string }
  | { kind: "listPendingKnocks" };

/**
 * response payloads for `iroh/skein-hub-admin/1`, mirroring
 * `reliquary::protocol::hub_admin::AdminResponse`.
 */
export type HubAdminResponse =
  | { kind: "allowed"; nodeId: string; status: string }
  | { kind: "list"; friends: HubAdminFriendSummary[] }
  | { kind: "removed"; nodeId: string }
  | { kind: "notAdmin" }
  | { kind: "error"; message: string }
  | { kind: "pendingKnocks"; knocks: HubAdminPendingKnockSummary[] };

/**
 * build the CBOR-ready wire value for an `HubAdminRequest`, matching
 * serde's default externally-tagged enum representation (the shape
 * `ciborium` produces/expects on the reliquary side): a unit variant like
 * `List` encodes as just its variant name, a struct variant like
 * `Allow { .. }` encodes as a single-key map `{ Allow: { node_id: .. } }`.
 */
function toWireAdminRequest(request: HubAdminRequest): unknown {
  switch (request.kind) {
    case "allow":
      return { Allow: { node_id: request.nodeId } };
    case "list":
      return "List";
    case "remove":
      return { Remove: { node_id: request.nodeId } };
    case "listPendingKnocks":
      return "ListPendingKnocks";
  }
}

/** parse the CBOR-decoded wire value for an `AdminResponse` back into our TS shape. */
function fromWireAdminResponse(wire: unknown): HubAdminResponse {
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
    if ("PendingKnocks" in obj) {
      const v = obj.PendingKnocks as {
        knocks: Array<{
          canvas_doc_id: string;
          knock_id: string;
          requester_node_id: string;
          requester_username: string;
          message: string;
          knocked_at: number;
        }>;
      };
      return {
        kind: "pendingKnocks",
        knocks: v.knocks.map((k) => ({
          canvasDocId: k.canvas_doc_id,
          knockId: k.knock_id,
          requesterNodeId: k.requester_node_id,
          requesterUsername: k.requester_username,
          message: k.message,
          knockedAt: k.knocked_at,
        })),
      };
    }
  }
  throw new Error(`unrecognized AdminResponse wire shape: ${JSON.stringify(wire)}`);
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

/**
 * the narrow transport dependency this client needs — just "give me a
 * midden node to open a raw bidirectional stream on", same `getMidden`
 * shape already used by `FriendzProtocolOptions` (`friends-protocol.ts`).
 * kept as an explicit, injectable dependency (rather than reaching for a
 * module-level singleton) so unit tests can supply a fake node without any
 * real iroh transport, and so this module has no hidden coupling to
 * `endpoint-control.ts`'s adapter lifecycle.
 */
export interface HubAdminTransport {
  getMidden(): Promise<MiddenStreamNode>;
}

/**
 * build a `HubAdminTransport` from a live `IrohNetworkAdapter` — the usual
 * production entry point once a caller (e.g. the friend-detail view, in a
 * later wiring step) has one in hand.
 */
export function hubAdminTransportFromAdapter(adapter: {
  getNode(): Promise<MiddenStreamNode>;
}): HubAdminTransport {
  return { getMidden: () => adapter.getNode() };
}

/**
 * open a fresh `iroh/skein-hub-admin/1` stream to `peerNodeId`, write a
 * single CBOR-encoded request terminated by `finish()`, and read back a
 * single CBOR-encoded response with `read_to_end()` — mirrors reliquary's
 * `protocol::hub_admin` framing exactly (no length prefix, one
 * request/response pair per stream).
 */
async function sendAdminRequest(
  transport: HubAdminTransport,
  peerNodeId: string,
  request: HubAdminRequest
): Promise<HubAdminResponse> {
  const node = await transport.getMidden();
  // `open_bi` is part of the narrow MiddenStreamNode interface already, but
  // the raw (non-length-delimited) framing methods used by
  // `skein/1`/`skein-hub-admin/1`-style protocols aren't — same pattern as
  // BiStreamLike's optional `read_to_end`/`write_raw_and_finish`.
  const stream = await node.open_bi(peerNodeId, HUB_ADMIN_ALPN);
  const streamAny = stream as unknown as {
    write_raw_and_finish(data: Uint8Array): Promise<void>;
    read_to_end(max_size: number): Promise<Uint8Array>;
    close(): void;
  };

  const encoded = cbor.encode(toWireAdminRequest(request));
  await streamAny.write_raw_and_finish(encoded);
  const responseBytes = await streamAny.read_to_end(DEFAULT_MAX_ADMIN_RESPONSE_BYTES);
  streamAny.close();

  return fromWireAdminResponse(cbor.decode(responseBytes));
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

/**
 * typed `iroh/skein-hub-admin/1` client, bound to a single transport.
 *
 * usage:
 *   const client = createHubAdminClient(hubAdminTransportFromAdapter(adapter));
 *   const response = await client.hubAdminList(hubNodeId);
 */
export interface HubAdminClient {
  /** pre-approve a peer into the hub's friendz allow-list (mirrors `reliquary friend allow`). */
  hubAdminAllow(peerNodeId: string, nodeIdToAllow: string): Promise<HubAdminResponse>;
  /** list every friendz row the hub knows about (mirrors `reliquary friend list`). */
  hubAdminList(peerNodeId: string): Promise<HubAdminResponse>;
  /** remove a peer from the hub's friendz entirely (mirrors `reliquary friend remove`). */
  hubAdminRemove(peerNodeId: string, nodeIdToRemove: string): Promise<HubAdminResponse>;
  /**
   * list pending knocks the hub is holding across every canvas doc it
   * holds — read-only, informational aggregation. approving/declining a
   * knock is never done through this channel (see
   * docs/hub-and-profile-plan.md section 5).
   */
  hubAdminListPendingKnocks(peerNodeId: string): Promise<HubAdminResponse>;
}

/** build a `HubAdminClient` bound to the given transport. */
export function createHubAdminClient(transport: HubAdminTransport): HubAdminClient {
  return {
    hubAdminAllow(peerNodeId, nodeIdToAllow) {
      return sendAdminRequest(transport, peerNodeId, { kind: "allow", nodeId: nodeIdToAllow });
    },
    hubAdminList(peerNodeId) {
      return sendAdminRequest(transport, peerNodeId, { kind: "list" });
    },
    hubAdminRemove(peerNodeId, nodeIdToRemove) {
      return sendAdminRequest(transport, peerNodeId, { kind: "remove", nodeId: nodeIdToRemove });
    },
    hubAdminListPendingKnocks(peerNodeId) {
      return sendAdminRequest(transport, peerNodeId, { kind: "listPendingKnocks" });
    },
  };
}

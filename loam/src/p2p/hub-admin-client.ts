// ---------------------------------------------------------------------------
// hub admin client — production `iroh/skein-hub-admin/1` protocol client.
//
// promotes the exact same open_bi + CBOR framing mechanics that
// `SkeinP2PBridge.hubAdminRequest` (`src/dev/test-bridge.ts`) already
// exercises against a real reliquary hub, into a real, importable,
// production-callable client — see docs/hub-and-profile-plan.md section 5.
//
// wire shapes mirror `tumulus::protocol::hub_admin::AdminRequest` /
// `AdminResponse` (`tumulus/src/protocol/hub_admin.rs`), including the
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
 * max response size to read back from a hub admin request. 4 MB gives
 * headroom for large BlobUsage lists without hitting reliquary's own
 * `MAX_MESSAGE_SIZE` in `protocol/hub_admin.rs`.
 */
const DEFAULT_MAX_ADMIN_RESPONSE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// wire types
// ---------------------------------------------------------------------------

/**
 * a single friendz row, as reported by an `AdminResponse::List`.
 *
 * `username`/`bio`/`avatarDataUrl` are best-effort profile info the hub
 * already has cached in its own `userz` directory — empty strings if it's
 * never seen a profile for this peer. `avatarDataUrl` is a ready-to-render
 * `data:<mime>;base64,...` string, computed server-side (see
 * `FriendSummary`'s doc comment in `reliquary/src/protocol/hub_admin.rs`
 * for why: a hub's cached avatar blob isn't tied to any canvas, so it
 * wouldn't pass the canvas-membership half of the blob ACL gate anyway).
 * `isAdmin` cross-references the hub's `adminz` table.
 */
export interface HubAdminFriendSummary {
  nodeId: string;
  status: string;
  updatedAt: number;
  username: string;
  bio: string;
  avatarDataUrl: string;
  isAdmin: boolean;
}

/**
 * a single pending knock, aggregated across every canvas doc the hub
 * holds, as reported by `AdminResponse::PendingKnocks`. `knockId` doubles
 * as the `requesterNodeId` `hubAdminApproveKnock`/`hubAdminDeclineKnock`
 * expect for `canvasDocId`.
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

/** disk/blob usage summary from `AdminResponse::DiskUsage`. */
export interface HubAdminDiskUsage {
  totalBlobBytes: number;
  blobCount: number;
  diskAvailableBytes: number | null;
  diskTotalBytes: number | null;
  softDeletedBlobBytes: number;
  softDeletedBlobCount: number;
}

/** per-canvas blob usage row from `AdminResponse::CanvasUsage`. */
export interface HubAdminCanvasUsageSummary {
  canvasDocId: string;
  blobCount: number;
  totalBytes: number;
}

/** hub profile data from `AdminResponse::HubProfile`. */
export interface HubAdminHubProfile {
  username: string;
  bio: string;
  accentColor: number;
  avatarDataUrl: string;
}

/** a single blob row from `AdminResponse::BlobUsage`. */
export interface HubAdminBlobUsageSummary {
  blake3: string;
  filename: string | null;
  mime: string | null;
  size: number;
  external: boolean;
  softDeleted: boolean;
}

/** a single soft-deleted blob row from `AdminResponse::SoftDeleted`. */
export interface HubAdminSoftDeletedBlob {
  blake3: string;
  filename: string | null;
  mime: string | null;
  size: number;
  softDeletedAt: number;
  softDeletedBy: string;
}

/**
 * a single outgoing blob transfer in progress on the hub (this hub
 * serving, some peer snatching), as reported by
 * `AdminResponse::ActiveTransfers` — see `TransferSummary` in
 * `hub_admin.rs`.
 */
export interface HubAdminActiveTransfer {
  peer: string;
  blake3: string;
  bytesSent: number;
  totalSize: number;
  elapsedMs: number;
}

/**
 * request payloads for `iroh/skein-hub-admin/1`, mirroring
 * `reliquary::protocol::hub_admin::AdminRequest`.
 */
export type HubAdminRequest =
  | { kind: "allow"; nodeId: string }
  | { kind: "list" }
  | { kind: "remove"; nodeId: string }
  | { kind: "block"; nodeId: string }
  | { kind: "promoteAdmin"; nodeId: string }
  | { kind: "demoteAdmin"; nodeId: string }
  | { kind: "listPendingKnocks" }
  | { kind: "approveKnock"; canvasDocId: string; requesterNodeId: string; role: string }
  | { kind: "declineKnock"; canvasDocId: string; requesterNodeId: string }
  | { kind: "diskUsage" }
  | { kind: "canvasUsage"; offset: number; limit: number }
  | { kind: "blobUsage"; offset: number; limit: number }
  | { kind: "softDeleteBlobs"; blake3s: string[] }
  | { kind: "restoreBlobs"; blake3s: string[] }
  | { kind: "listSoftDeleted"; offset: number; limit: number }
  | { kind: "hardDeleteBlobs"; blake3s: string[]; all: boolean }
  | { kind: "unsyncCanvas"; canvasDocId: string }
  | { kind: "getHubProfile" }
  | { kind: "setHubProfile"; username: string | null; bio: string | null; accentColor: number | null }
  | { kind: "setHubAvatar"; imageBase64: string }
  | { kind: "canvasBlobs"; canvasDocId: string; offset: number; limit: number }
  | { kind: "activeTransfers" };

/**
 * response payloads for `iroh/skein-hub-admin/1`, mirroring
 * `reliquary::protocol::hub_admin::AdminResponse`.
 */
export type HubAdminResponse =
  | { kind: "allowed"; nodeId: string; status: string }
  | { kind: "list"; friends: HubAdminFriendSummary[] }
  | { kind: "removed"; nodeId: string }
  | { kind: "blocked"; nodeId: string }
  | { kind: "adminChanged"; nodeId: string; isAdmin: boolean }
  | { kind: "notAdmin" }
  | { kind: "error"; message: string }
  | { kind: "pendingKnocks"; knocks: HubAdminPendingKnockSummary[] }
  | { kind: "knockDecided"; canvasDocId: string; requesterNodeId: string }
  | { kind: "diskUsage"; usage: HubAdminDiskUsage }
  | { kind: "canvasUsage"; canvases: HubAdminCanvasUsageSummary[]; total: number }
  | { kind: "blobUsage"; blobs: HubAdminBlobUsageSummary[]; total: number }
  | { kind: "blobsMutation"; affected: number; failed: string[] }
  | { kind: "softDeleted"; blobs: HubAdminSoftDeletedBlob[]; total: number }
  | { kind: "canvasUnsynced"; canvasDocId: string; swept: number }
  | { kind: "hubProfile"; profile: HubAdminHubProfile }
  | { kind: "canvasBlobs"; canvasDocId: string; blobs: HubAdminBlobUsageSummary[]; total: number }
  | { kind: "activeTransfers"; transfers: HubAdminActiveTransfer[] };

/**
 * build the CBOR-ready wire value for an `HubAdminRequest`, matching
 * serde's default externally-tagged enum representation (the shape
 * `ciborium` produces/expects on the reliquary side): a unit variant like
 * `List` encodes as just its variant name, a struct variant like
 * `Allow { .. }` encodes as a single-key map `{ Allow: { node_id: .. } }`.
 */
export function toWireAdminRequest(request: HubAdminRequest): unknown {
  switch (request.kind) {
    case "allow":
      return { Allow: { node_id: request.nodeId } };
    case "list":
      return "List";
    case "remove":
      return { Remove: { node_id: request.nodeId } };
    case "block":
      return { Block: { node_id: request.nodeId } };
    case "promoteAdmin":
      return { PromoteAdmin: { node_id: request.nodeId } };
    case "demoteAdmin":
      return { DemoteAdmin: { node_id: request.nodeId } };
    case "listPendingKnocks":
      return "ListPendingKnocks";
    case "approveKnock":
      return {
        ApproveKnock: {
          canvas_doc_id: request.canvasDocId,
          requester_node_id: request.requesterNodeId,
          role: request.role,
        },
      };
    case "declineKnock":
      return {
        DeclineKnock: { canvas_doc_id: request.canvasDocId, requester_node_id: request.requesterNodeId },
      };
    case "diskUsage":
      return "DiskUsage";
    case "canvasUsage":
      return { CanvasUsage: { offset: request.offset, limit: request.limit } };
    case "blobUsage":
      return { BlobUsage: { offset: request.offset, limit: request.limit } };
    case "softDeleteBlobs":
      return { SoftDeleteBlobs: { blake3s: request.blake3s } };
    case "restoreBlobs":
      return { RestoreBlobs: { blake3s: request.blake3s } };
    case "listSoftDeleted":
      return { ListSoftDeleted: { offset: request.offset, limit: request.limit } };
    case "hardDeleteBlobs":
      return { HardDeleteBlobs: { blake3s: request.blake3s, all: request.all } };
    case "unsyncCanvas":
      return { UnsyncCanvas: { canvas_doc_id: request.canvasDocId } };
    case "getHubProfile":
      return "GetHubProfile";
    case "setHubProfile":
      return { SetHubProfile: { username: request.username, bio: request.bio, accent_color: request.accentColor } };
    case "setHubAvatar":
      return { SetHubAvatar: { image_base64: request.imageBase64 } };
    case "canvasBlobs":
      return { CanvasBlobs: { canvas_doc_id: request.canvasDocId, offset: request.offset, limit: request.limit } };
    case "activeTransfers":
      return "ActiveTransfers";
  }
}

/** parse the CBOR-decoded wire value for an `AdminResponse` back into our TS shape. */
/** cbor decodes rust u64 as BigInt (values ≤ 2^53 included, depending on
 *  encoder) — coerce to number at the wire boundary so ui math/formatting
 *  never mixes BigInt with number (a TypeError). sizes here fit in 2^53. */
function toNum(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : (v as number);
}

export function fromWireAdminResponse(wire: unknown): HubAdminResponse {
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
        friends: Array<{
          node_id: string;
          status: string;
          updated_at: number;
          username: string;
          bio: string;
          avatar_data_url: string;
          is_admin: boolean;
        }>;
      };
      return {
        kind: "list",
        friends: v.friends.map((f) => ({
          nodeId: f.node_id,
          status: f.status,
          updatedAt: toNum(f.updated_at),
          username: f.username,
          bio: f.bio,
          avatarDataUrl: f.avatar_data_url,
          isAdmin: f.is_admin,
        })),
      };
    }
    if ("Removed" in obj) {
      const v = obj.Removed as { node_id: string };
      return { kind: "removed", nodeId: v.node_id };
    }
    if ("Blocked" in obj) {
      const v = obj.Blocked as { node_id: string };
      return { kind: "blocked", nodeId: v.node_id };
    }
    if ("AdminChanged" in obj) {
      const v = obj.AdminChanged as { node_id: string; is_admin: boolean };
      return { kind: "adminChanged", nodeId: v.node_id, isAdmin: v.is_admin };
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
          knockedAt: toNum(k.knocked_at),
        })),
      };
    }
    if ("KnockDecided" in obj) {
      const v = obj.KnockDecided as { canvas_doc_id: string; requester_node_id: string };
      return { kind: "knockDecided", canvasDocId: v.canvas_doc_id, requesterNodeId: v.requester_node_id };
    }
    if ("DiskUsage" in obj) {
      const v = obj.DiskUsage as {
        total_blob_bytes: number;
        blob_count: number;
        disk_available_bytes: number | null;
        disk_total_bytes: number | null;
        soft_deleted_blob_bytes: number;
        soft_deleted_blob_count: number;
      };
      return {
        kind: "diskUsage",
        usage: {
          totalBlobBytes: toNum(v.total_blob_bytes),
          blobCount: toNum(v.blob_count),
          diskAvailableBytes: v.disk_available_bytes === null ? null : toNum(v.disk_available_bytes),
          diskTotalBytes: v.disk_total_bytes === null ? null : toNum(v.disk_total_bytes),
          softDeletedBlobBytes: toNum(v.soft_deleted_blob_bytes),
          softDeletedBlobCount: toNum(v.soft_deleted_blob_count),
        },
      };
    }
    if ("CanvasUsage" in obj) {
      const v = obj.CanvasUsage as {
        canvases: Array<{ canvas_doc_id: string; blob_count: number; total_bytes: number }>;
        total: number;
      };
      return {
        kind: "canvasUsage",
        total: toNum(v.total),
        canvases: v.canvases.map((c) => ({
          canvasDocId: c.canvas_doc_id,
          blobCount: toNum(c.blob_count),
          totalBytes: toNum(c.total_bytes),
        })),
      };
    }
    if ("BlobUsage" in obj) {
      const v = obj.BlobUsage as {
        total: number;
        blobs: Array<{
          blake3: string;
          filename: string | null;
          mime: string | null;
          size: number;
          external: boolean;
          soft_deleted: boolean;
        }>;
      };
      return {
        kind: "blobUsage",
        total: toNum(v.total),
        blobs: v.blobs.map((b) => ({
          blake3: b.blake3,
          filename: b.filename,
          mime: b.mime,
          size: toNum(b.size),
          external: b.external,
          softDeleted: b.soft_deleted,
        })),
      };
    }
    if ("BlobsMutation" in obj) {
      const v = obj.BlobsMutation as { affected: number; failed: string[] };
      return { kind: "blobsMutation", affected: toNum(v.affected), failed: v.failed };
    }
    if ("SoftDeleted" in obj) {
      const v = obj.SoftDeleted as {
        total: number;
        blobs: Array<{
          blake3: string;
          filename: string | null;
          mime: string | null;
          size: number;
          soft_deleted_at: number;
          soft_deleted_by: string;
        }>;
      };
      return {
        kind: "softDeleted",
        total: toNum(v.total),
        blobs: v.blobs.map((b) => ({
          blake3: b.blake3,
          filename: b.filename,
          mime: b.mime,
          size: toNum(b.size),
          softDeletedAt: toNum(b.soft_deleted_at),
          softDeletedBy: b.soft_deleted_by,
        })),
      };
    }
    if ("CanvasUnsynced" in obj) {
      const v = obj.CanvasUnsynced as { canvas_doc_id: string; swept: number };
      return { kind: "canvasUnsynced", canvasDocId: v.canvas_doc_id, swept: toNum(v.swept) };
    }
    if ("HubProfile" in obj) {
      const v = obj.HubProfile as { username: string; bio: string; accent_color: number; avatar_data_url: string };
      return {
        kind: "hubProfile",
        profile: {
          username: v.username,
          bio: v.bio,
          accentColor: toNum(v.accent_color),
          avatarDataUrl: v.avatar_data_url,
        },
      };
    }
    if ("CanvasBlobs" in obj) {
      const v = obj.CanvasBlobs as {
        canvas_doc_id: string;
        blobs: Array<{ blake3: string; filename: string | null; mime: string | null; size: number; external: boolean; soft_deleted: boolean }>;
        total: number;
      };
      return {
        kind: "canvasBlobs",
        canvasDocId: v.canvas_doc_id,
        total: toNum(v.total),
        blobs: v.blobs.map((b) => ({
          blake3: b.blake3,
          filename: b.filename,
          mime: b.mime,
          size: toNum(b.size),
          external: b.external,
          softDeleted: b.soft_deleted,
        })),
      };
    }
    if ("ActiveTransfers" in obj) {
      const v = obj.ActiveTransfers as {
        transfers: Array<{ peer: string; blake3: string; bytes_sent: number; total_size: number; elapsed_ms: number }>;
      };
      return {
        kind: "activeTransfers",
        transfers: v.transfers.map((t) => ({
          peer: t.peer,
          blake3: t.blake3,
          bytesSent: toNum(t.bytes_sent),
          totalSize: toNum(t.total_size),
          elapsedMs: toNum(t.elapsed_ms),
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
 * single CBOR-encoded response with `read_to_end()` (no length prefix, one
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
  /** deny a peer (sets friendz status to blocked) — the reverse ("unblock")
   *  is just `hubAdminAllow` again, no separate method. */
  hubAdminBlock(peerNodeId: string, nodeIdToBlock: string): Promise<HubAdminResponse>;
  /** grant a friend hub-admin rights (mirrors `reliquary admin allow`) —
   *  lets them make their own remote hub-admin requests. */
  hubAdminPromoteAdmin(peerNodeId: string, nodeIdToPromote: string): Promise<HubAdminResponse>;
  /** revoke a peer's hub-admin rights (mirrors `reliquary admin remove`). */
  hubAdminDemoteAdmin(peerNodeId: string, nodeIdToDemote: string): Promise<HubAdminResponse>;
  /**
   * list pending knocks the hub is holding across every canvas doc it
   * holds — a cross-canvas convenience view.
   */
  hubAdminListPendingKnocks(peerNodeId: string): Promise<HubAdminResponse>;
  /**
   * approve a pending knock: grants `role` ("member" or "viewer") on the
   * canvas doc's acl and records the decision. does not establish a friend
   * relationship with the requester (that's specific to a peer-to-peer
   * admin accepting someone into their own social graph, not the hub).
   */
  hubAdminApproveKnock(
    peerNodeId: string,
    canvasDocId: string,
    requesterNodeId: string,
    role: string
  ): Promise<HubAdminResponse>;
  /** decline a pending knock: records the decision, grants no access. */
  hubAdminDeclineKnock(peerNodeId: string, canvasDocId: string, requesterNodeId: string): Promise<HubAdminResponse>;
  /** fetch disk and blob storage usage metrics for the hub. */
  hubAdminDiskUsage(peerNodeId: string): Promise<HubAdminResponse>;
  /**
   * fetch per-canvas blob usage breakdown, sorted by total_bytes desc (hub-side).
   * results are paginated; offset/limit are clamped hub-side (max 200, 0 -> 50).
   */
  hubAdminCanvasUsage(peerNodeId: string, offset?: number, limit?: number): Promise<HubAdminResponse>;
  /**
   * fetch active (non-soft-deleted) blobs stored on the hub.
   * results are paginated; offset/limit are clamped hub-side (max 200, 0 -> 50).
   */
  hubAdminBlobUsage(peerNodeId: string, offset?: number, limit?: number): Promise<HubAdminResponse>;
  /** soft-delete the given blobs by blake3 hash — marks them for deletion but doesn't free disk. */
  hubAdminSoftDeleteBlobs(peerNodeId: string, blake3s: string[]): Promise<HubAdminResponse>;
  /** restore soft-deleted blobs by blake3 hash. */
  hubAdminRestoreBlobs(peerNodeId: string, blake3s: string[]): Promise<HubAdminResponse>;
  /**
   * list only the soft-deleted blobs.
   * results are paginated; offset/limit are clamped hub-side (max 200, 0 -> 50).
   */
  hubAdminListSoftDeleted(peerNodeId: string, offset?: number, limit?: number): Promise<HubAdminResponse>;
  /**
   * permanently hard-delete blobs — irreversible.
   * pass `all=true` to purge every soft-deleted blob regardless of `blake3s`.
   * pass specific `blake3s` with `all=false` (default) to delete only those hashes.
   */
  hubAdminHardDeleteBlobs(
    peerNodeId: string,
    blake3s: string[],
    all?: boolean
  ): Promise<HubAdminResponse>;
  /**
   * remove the hub from the canvas doc's peers/acl, stop syncing it, and
   * soft-delete blobs only that canvas referenced. `swept` is the count of
   * soft-deleted blobs.
   */
  hubAdminUnsyncCanvas(peerNodeId: string, canvasDocId: string): Promise<HubAdminResponse>;
  /** fetch the hub's own profile (username, bio, accent_color, avatar). */
  hubAdminGetProfile(peerNodeId: string): Promise<HubAdminResponse>;
  /**
   * update the hub's own profile fields. pass null for any field to leave
   * it unchanged hub-side.
   */
  hubAdminSetProfile(
    peerNodeId: string,
    opts: { username?: string | null; bio?: string | null; accentColor?: number | null }
  ): Promise<HubAdminResponse>;
  /**
   * upload a new avatar for the hub. `imageBase64` is a plain base64-encoded
   * image (no data-url prefix). the hub re-encodes it to 128px webp.
   * decoded size is capped at 512KB hub-side — callers should pre-resize.
   */
  hubAdminSetAvatar(peerNodeId: string, imageBase64: string): Promise<HubAdminResponse>;
  /**
   * list blobs belonging to a specific canvas doc.
   * results are paginated; offset/limit are clamped hub-side (max 200, 0 -> 50).
   * blobs may overlap with other canvases by design.
   */
  hubAdminCanvasBlobs(peerNodeId: string, canvasDocId: string, offset?: number, limit?: number): Promise<HubAdminResponse>;
  /**
   * snapshot of this hub's own outgoing blob transfers currently in flight
   * (this hub serving, some peer snatching) — mirrors
   * `AdminRequest::ActiveTransfers` / `TransferSummary` in `hub_admin.rs`.
   * used e.g. by e2e tests to observe hub->peer transfer progress.
   */
  hubAdminActiveTransfers(peerNodeId: string): Promise<HubAdminResponse>;
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
    hubAdminBlock(peerNodeId, nodeIdToBlock) {
      return sendAdminRequest(transport, peerNodeId, { kind: "block", nodeId: nodeIdToBlock });
    },
    hubAdminPromoteAdmin(peerNodeId, nodeIdToPromote) {
      return sendAdminRequest(transport, peerNodeId, {
        kind: "promoteAdmin",
        nodeId: nodeIdToPromote,
      });
    },
    hubAdminDemoteAdmin(peerNodeId, nodeIdToDemote) {
      return sendAdminRequest(transport, peerNodeId, {
        kind: "demoteAdmin",
        nodeId: nodeIdToDemote,
      });
    },
    hubAdminListPendingKnocks(peerNodeId) {
      return sendAdminRequest(transport, peerNodeId, { kind: "listPendingKnocks" });
    },
    hubAdminApproveKnock(peerNodeId, canvasDocId, requesterNodeId, role) {
      return sendAdminRequest(transport, peerNodeId, {
        kind: "approveKnock",
        canvasDocId,
        requesterNodeId,
        role,
      });
    },
    hubAdminDeclineKnock(peerNodeId, canvasDocId, requesterNodeId) {
      return sendAdminRequest(transport, peerNodeId, {
        kind: "declineKnock",
        canvasDocId,
        requesterNodeId,
      });
    },
    hubAdminDiskUsage(peerNodeId) {
      return sendAdminRequest(transport, peerNodeId, { kind: "diskUsage" });
    },
    hubAdminCanvasUsage(peerNodeId, offset = 0, limit = 50) {
      return sendAdminRequest(transport, peerNodeId, { kind: "canvasUsage", offset, limit });
    },
    hubAdminBlobUsage(peerNodeId, offset = 0, limit = 50) {
      return sendAdminRequest(transport, peerNodeId, { kind: "blobUsage", offset, limit });
    },
    hubAdminSoftDeleteBlobs(peerNodeId, blake3s) {
      return sendAdminRequest(transport, peerNodeId, { kind: "softDeleteBlobs", blake3s });
    },
    hubAdminRestoreBlobs(peerNodeId, blake3s) {
      return sendAdminRequest(transport, peerNodeId, { kind: "restoreBlobs", blake3s });
    },
    hubAdminListSoftDeleted(peerNodeId, offset = 0, limit = 50) {
      return sendAdminRequest(transport, peerNodeId, { kind: "listSoftDeleted", offset, limit });
    },
    hubAdminHardDeleteBlobs(peerNodeId, blake3s, all = false) {
      return sendAdminRequest(transport, peerNodeId, { kind: "hardDeleteBlobs", blake3s, all });
    },
    hubAdminUnsyncCanvas(peerNodeId, canvasDocId) {
      return sendAdminRequest(transport, peerNodeId, { kind: "unsyncCanvas", canvasDocId });
    },
    hubAdminGetProfile(peerNodeId) {
      return sendAdminRequest(transport, peerNodeId, { kind: "getHubProfile" });
    },
    hubAdminSetProfile(peerNodeId, opts) {
      return sendAdminRequest(transport, peerNodeId, {
        kind: "setHubProfile",
        username: opts.username ?? null,
        bio: opts.bio ?? null,
        accentColor: opts.accentColor ?? null,
      });
    },
    hubAdminSetAvatar(peerNodeId, imageBase64) {
      return sendAdminRequest(transport, peerNodeId, { kind: "setHubAvatar", imageBase64 });
    },
    hubAdminCanvasBlobs(peerNodeId, canvasDocId, offset = 0, limit = 50) {
      return sendAdminRequest(transport, peerNodeId, { kind: "canvasBlobs", canvasDocId, offset, limit });
    },
    hubAdminActiveTransfers(peerNodeId) {
      return sendAdminRequest(transport, peerNodeId, { kind: "activeTransfers" });
    },
  };
}

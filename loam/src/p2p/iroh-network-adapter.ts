// ---------------------------------------------------------------------------
// iroh transport wiring for skein
//
// the iroh QUIC transport for automerge-repo - length-delimited cbor
// framing over midden bidirectional streams, peer supersession handling,
// reconnect backoff, alpn dispatch for protocols layered on top of sync -
// lives in @freqhole/reliquary/automerge. this module only owns what's
// specific to skein: wiring the adapter to skein's own p2p identity source
// (p2p/identity.ts), skein's friendz alpn, and the blob-acl gate helper
// that rides on the same midden node the adapter already holds.
// ---------------------------------------------------------------------------

import {
  IrohNetworkAdapter,
  SYNC_ALPN,
  type BiStreamLike,
  type ConnectionSummary,
  type EndpointState,
  type MiddenStreamNode,
} from "@freqhole/reliquary/automerge";

import { getStoredIdentity, onIdentityChange } from "./identity";
import { log } from "@freqhole/reliquary/utils";

const TAG = "p2p.iroh-network-adapter";

export { IrohNetworkAdapter, SYNC_ALPN };
export type { BiStreamLike, ConnectionSummary, EndpointState, MiddenStreamNode };

/** alpn for friend requests, profile sharing, presence, knocks, and acl
 *  notifications - the shared `@freqhole/haruspex/protocol` wire format,
 *  not a skein-specific one. */
export const FRIENDZ_ALPN = "freqhole-friendz/1";

/**
 * build an `IrohNetworkAdapter` wired up with skein's own p2p identity
 * source: if an identity is already stored, transport starts immediately
 * at `connect()` time; otherwise it stays passive until `ensureIdentity()`
 * (or the profile widget's "generate" button) creates one.
 */
export function createIrohNetworkAdapter(
  getNode: () => Promise<MiddenStreamNode>
): IrohNetworkAdapter {
  return new IrohNetworkAdapter({
    getNode,
    getIdentity: getStoredIdentity,
    onIdentityChange,
  });
}

/**
 * restrict a blob (by blake3 hex hash) so only the given peer node ids may
 * fetch it from this peer over the `iroh-blobs/*` alpn - see
 * `MiddenNode::restrict_blob_to_peers` in `midden/src/lib.rs`.
 *
 * this REPLACES the allow-list for the hash, it is not additive - always
 * call it with the full, current list of node ids that should have
 * access, not just newly-added ones, so a peer that's been removed from
 * the list actually loses access rather than lingering from an earlier
 * call. see `../canvas/blob-acl-sync.ts` (the production caller) for how
 * the full list is recomputed from a canvas's `.acl` on every change.
 *
 * a no-op if the underlying transport doesn't expose this method (e.g.
 * tauri mode, which serves blobs through a separate native path that this
 * gate doesn't cover).
 */
export async function restrictBlobToPeers(
  adapter: IrohNetworkAdapter,
  blake3Hash: string,
  peerNodeIds: string[]
): Promise<void> {
  const node = await adapter.getNode();
  const nodeAny = node as unknown as {
    restrict_blob_to_peers?: (blake3: string, peerNodeIds: string[]) => void | Promise<void>;
  };
  if (typeof nodeAny.restrict_blob_to_peers !== "function") return;
  // await - on the worker-hosted node this is a promise, and callers
  // (blob-acl-sync, e2e assertions) rely on the gate being live when this
  // function resolves
  await nodeAny.restrict_blob_to_peers(blake3Hash, peerNodeIds);
}

/** one outgoing blob transfer in flight on this browser peer (this peer
 *  serving, some other peer snatching) - see `MiddenNode::get_active_transfers`
 *  in `midden/src/lib.rs` / `midden/src/transfers.rs`. */
export interface MiddenActiveTransfer {
  peerId: string;
  blake3: string;
  bytesSent: number;
  totalSize: number;
}

/**
 * snapshot of this browser peer's own outgoing blob transfers currently in
 * flight - the browser-peer counterpart to tauri's
 * `p2p/transfer-progress.ts` polling, so the file widget can show upload
 * progress for browser peers too, not just tauri peers.
 *
 * returns `[]` if the underlying transport doesn't expose this method
 * (e.g. tauri mode, which tracks transfers through a separate native path -
 * see `transfer-progress.ts`'s tauri dispatch instead).
 */
export async function getActiveTransfers(adapter: IrohNetworkAdapter): Promise<MiddenActiveTransfer[]> {
  const node = await adapter.getNode();
  const nodeAny = node as unknown as {
    get_active_transfers?: () => MiddenActiveTransfer[] | Promise<MiddenActiveTransfer[]>;
  };
  if (typeof nodeAny.get_active_transfers !== "function") {
    return [];
  }
  return (await nodeAny.get_active_transfers()) ?? [];
}


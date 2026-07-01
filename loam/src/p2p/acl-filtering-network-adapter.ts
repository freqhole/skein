// ---------------------------------------------------------------------------
// ACL-filtering network adapter wrapper for automerge-repo
//
// enforces per-canvas viewer read-only access at the network boundary.
// automerge-repo's DocSynchronizer calls Automerge.receiveSyncMessage()
// unconditionally for every inbound "sync"/"request" message — there's no
// hook inside automerge-repo to reject a peer's changes before they're
// applied to the local doc. this wrapper sits in front of a real
// NetworkAdapter and strips any CRDT changes carried by a "viewer" peer's
// sync/request messages before automerge-repo ever sees them, while still
// letting "have"/"need"/"heads" through so viewers can keep receiving
// updates normally.
//
// usage:
//   const roleResolver = createRepoRoleResolver(repo);
//   new Repo({
//     network: [new AclFilteringNetworkAdapter(realAdapter, roleResolver)],
//     ...
//   });
// ---------------------------------------------------------------------------

import { decodeSyncMessage, encodeSyncMessage } from "@automerge/automerge";
import {
  NetworkAdapter,
  type DocumentId,
  type Message,
  type PeerId,
  type PeerMetadata,
  type Repo,
} from "@automerge/automerge-repo";

import { canvasRoleSchema, type CanvasRole } from "../canvas/canvas-doc";
import { log } from "../utils/log";

/** console log prefix. */
const TAG = "p2p.acl-filter";

/**
 * resolves the effective role a peer has on a given document, so the
 * adapter can decide whether to strip that peer's changes. must be
 * synchronous — it's called inline while handling an inbound message.
 */
export type RoleResolver = (documentId: DocumentId, senderId: PeerId) => CanvasRole;

/**
 * a NetworkAdapter that wraps another NetworkAdapter and strips CRDT
 * changes out of "viewer" peers' inbound sync/request messages.
 *
 * everything else — connect/send/disconnect, peer-candidate/peer-disconnected/
 * close events, and any message that isn't a sync/request carrying changes
 * from a viewer — passes through completely unchanged, so this is a
 * drop-in replacement for the wrapped adapter from automerge-repo's point
 * of view.
 */
export class AclFilteringNetworkAdapter extends NetworkAdapter {
  private wrapped: NetworkAdapter;
  private roleResolver: RoleResolver;

  constructor(wrapped: NetworkAdapter, roleResolver: RoleResolver) {
    super();
    this.wrapped = wrapped;
    this.roleResolver = roleResolver;

    this.wrapped.on("peer-candidate", (payload) => this.emit("peer-candidate", payload));
    this.wrapped.on("peer-disconnected", (payload) => this.emit("peer-disconnected", payload));
    this.wrapped.on("close", () => this.emit("close"));
    this.wrapped.on("message", (message) => this.handleMessage(message));
  }

  isReady(): boolean {
    return this.wrapped.isReady();
  }

  whenReady(): Promise<void> {
    return this.wrapped.whenReady();
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId;
    this.peerMetadata = peerMetadata;
    this.wrapped.connect(peerId, peerMetadata);
  }

  send(message: Message): void {
    this.wrapped.send(message);
  }

  disconnect(): void {
    this.wrapped.disconnect();
  }

  /**
   * inspect an inbound message from the wrapped adapter. sync/request
   * messages from a "viewer" peer that carry changes get those changes
   * stripped (heads/need/have are preserved so the viewer's own reads
   * keep working); everything else is re-emitted untouched.
   */
  private handleMessage(message: Message): void {
    if (message.type !== "sync" && message.type !== "request") {
      this.emit("message", message);
      return;
    }

    if (!message.documentId || !message.data) {
      this.emit("message", message);
      return;
    }

    const role = this.roleResolver(message.documentId, message.senderId);
    if (role !== "viewer") {
      this.emit("message", message);
      return;
    }

    const decoded = decodeSyncMessage(message.data);
    if (decoded.changes.length === 0) {
      this.emit("message", message);
      return;
    }

    log.debug(
      TAG,
      `stripping ${decoded.changes.length} change(s) from viewer`,
      message.senderId,
      "for doc",
      message.documentId
    );

    const filtered = encodeSyncMessage({ ...decoded, changes: [] });
    this.emit("message", { ...message, data: filtered });
  }
}

/**
 * build a `RoleResolver` backed by a `Repo` instance.
 *
 * looks up the already-cached `DocHandle` for `documentId` via `repo.handles`
 * (a plain synchronous record of handles the repo already knows about) and
 * reads its role out of `.acl` — this deliberately avoids `repo.find()`,
 * which can trigger a network fetch and has side effects (creating a new
 * handle, marking it as requested from peers) that have no place in a
 * message-filtering hot path. if the repo has never seen this document, or
 * the cached handle isn't ready yet, there's nothing to check against, so
 * this defaults to `"member"` — the same default `CanvasStore.getRole()`
 * uses for a missing/invalid `.acl` entry.
 *
 * the `.acl` value itself is validated through `canvasRoleSchema.safeParse()`
 * before being trusted, mirroring `CanvasStore.getRole()`'s defensive
 * parsing — `.acl` is regular automerge doc data, synced from other peers
 * with no server-side validation.
 */
export function createRepoRoleResolver(repo: Repo): RoleResolver {
  return (documentId, senderId) => {
    const handle = repo.handles[documentId];
    if (!handle || !handle.isReady()) {
      return "member";
    }

    const doc = handle.doc() as { acl?: Record<string, { role?: unknown }> } | undefined;
    const raw = doc?.acl?.[senderId]?.role;
    const parsed = canvasRoleSchema.safeParse(raw);
    return parsed.success ? parsed.data : "member";
  };
}

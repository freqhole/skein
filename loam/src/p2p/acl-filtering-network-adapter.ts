// ---------------------------------------------------------------------------
// canvas-role acl filtering for skein
//
// enforces per-canvas viewer read-only access at the network boundary,
// built on @freqhole/reliquary/automerge's generic acl-filtering adapter.
// the message-filtering mechanism itself - decode a sync message, strip
// its changes when the sender's role doesn't permit writes, re-encode -
// lives in the package; this module only owns skein's own role
// vocabulary: a canvas's `.acl` maps node id to "admin" | "member" |
// "viewer", "viewer" is the one read-only role, and a peer with no
// recorded (or an invalid) role defaults to "viewer", the safe read-only
// floor.
//
// usage:
//   const roleResolver = createRepoRoleResolver(repo);
//   new Repo({
//     network: [createAclFilteringAdapter(realAdapter, roleResolver)],
//     ...
//   });
// ---------------------------------------------------------------------------

import type { NetworkAdapter, PeerId, Repo } from "@automerge/automerge-repo";
import {
  createAclFilteringAdapter as createGenericAclFilteringAdapter,
  createHandleBasedRoleResolver,
  type AclFilteringNetworkAdapter as GenericAclFilteringNetworkAdapter,
  type RoleResolver as GenericRoleResolver,
} from "@freqhole/reliquary/automerge";

import { canvasRoleSchema, type CanvasRole } from "../canvas/canvas-doc";

/** the acl-filtering adapter, specialized to skein's canvas role vocabulary. */
export type AclFilteringNetworkAdapter = GenericAclFilteringNetworkAdapter<CanvasRole>;

/**
 * resolves the effective canvas role a peer has on a given document, so
 * the adapter can decide whether to strip that peer's changes. must be
 * synchronous - it's called inline while handling an inbound message.
 */
export type RoleResolver = GenericRoleResolver<CanvasRole>;

/**
 * a "viewer" role is read-only; every other canvas role (member, admin)
 * may write.
 */
export function isReadOnlyCanvasRole(role: CanvasRole): boolean {
  return role === "viewer";
}

/**
 * reads a peer's canvas role out of a document's `.acl` field, validating
 * through `canvasRoleSchema.safeParse()` before trusting it - `.acl` is
 * regular automerge doc data, synced from other peers with no
 * server-side validation. defaults to `"viewer"` for a missing or
 * invalid entry, matching `CanvasStore.getRole()`'s default for the same
 * case.
 */
export function readCanvasRole(doc: unknown, senderId: PeerId): CanvasRole {
  const acl = (doc as { acl?: Record<string, { role?: unknown }> } | undefined)?.acl;
  const parsed = canvasRoleSchema.safeParse(acl?.[senderId]?.role);
  return parsed.success ? parsed.data : "viewer";
}

/**
 * build a `RoleResolver` backed by a `Repo` instance's already-cached
 * document handles.
 *
 * looks up the cached `DocHandle` for `documentId` via `repo.handles` (a
 * plain synchronous record the repo already knows about) and reads its
 * role via `readCanvasRole` above - this deliberately avoids
 * `repo.find()`, which can trigger a network fetch and has side effects
 * (creating a new handle, marking it as requested from peers) that have
 * no place in a message-filtering hot path. if the repo has never seen
 * this document, or the cached handle isn't ready yet, there's nothing
 * to check against, so this defaults to `"viewer"`.
 */
export function createRepoRoleResolver(repo: Repo): RoleResolver {
  return createHandleBasedRoleResolver(repo, readCanvasRole, "viewer");
}

/**
 * build an `AclFilteringNetworkAdapter` that strips a "viewer" peer's
 * inbound sync/request changes before automerge-repo ever sees them,
 * while letting "have"/"need"/"heads" through so viewers keep receiving
 * updates normally.
 */
export function createAclFilteringAdapter(
  wrapped: NetworkAdapter,
  resolveRole: RoleResolver
): AclFilteringNetworkAdapter {
  return createGenericAclFilteringAdapter(wrapped, {
    resolveRole,
    isReadOnly: isReadOnlyCanvasRole,
  });
}

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

import type { DocumentId, NetworkAdapter, PeerId, Repo } from "@automerge/automerge-repo";
import {
  createAclFilteringAdapter as createGenericAclFilteringAdapter,
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

/** true if `doc` has its own `.acl` object - a real canvas document, as
 *  opposed to a per-widget document (which only ever carries
 *  `ownerCanvasId`, never its own `.acl`). mirrors
 *  `canvas-scoped-share-policy.ts`'s identically-named helper - kept as a
 *  separate copy rather than a shared import since the two modules
 *  already tolerate slightly different doc shapes and this predicate is a
 *  one-liner. */
function hasAclField(doc: unknown): doc is { acl: Record<string, { role?: unknown }> } {
  return !!doc && typeof doc === "object" && "acl" in doc && typeof (doc as { acl: unknown }).acl === "object";
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
 * no place in a message-filtering hot path.
 *
 * a peer receiving a canvas doc for the very first time can never have a
 * ready local copy to check `.acl` against - that's exactly what's being
 * negotiated (the same bootstrap problem canvas-scoped-share-policy.ts
 * solves one layer up, at the sync-eligibility gate). defaulting to
 * `"viewer"` for a not-yet-ready handle would strip the legitimate
 * admin's very first sync payload, so the local copy could never become
 * ready - a permanent deadlock, not just a transient race.
 *
 * automerge-repo's own `DocHandle.state` machine already answers this for
 * free, synchronously: the `"requesting"` state is only ever entered once
 * local storage has been checked and confirmed NOT to have this document
 * (automerge-repo's `DocHandle` fires its `REQUEST` transition "when the
 * document is not found in storage"). so `"requesting"` means this device
 * has never had this document, ever - genuine first contact, safe to let
 * the bootstrap sync through unfiltered. any other not-ready state
 * (`"loading"` - still checking local storage for a document this device
 * may already know from a past session; `"idle"`/`"unloaded"`/
 * `"unavailable"`) keeps the strict `"viewer"` default, so a page reload
 * of an already-known (possibly viewer-downgraded) canvas can't exploit
 * this bootstrap window - local storage resolves to `"ready"` almost
 * immediately, well before any peer's sync traffic could arrive, so the
 * window this bypass opens never applies to a document the device has
 * already seen. once ready, the real `.acl`-based check governs, always.
 *
 * a per-widget document (file, audio-recording, etc.) never carries its
 * own `.acl` - only its owning canvas does. without the `ownerCanvasId`
 * fallback below, EVERY write to an already-ready widget document would
 * resolve to `"viewer"` (the safe default for "no `.acl` found") and get
 * silently stripped, no matter the sender's real canvas role - only that
 * document's very first, one-time "requesting" sync ever bypassed the
 * filter. this is why an uploaded file's `blobId`/metadata could
 * disappear into the void on a peer that already had the (still-empty)
 * widget document from an earlier canvas sync: the upload writes arrived
 * as ordinary "ready"-state sync messages and were stripped before
 * automerge-repo ever saw them. mirrors
 * `canvas-scoped-share-policy.ts`'s rule 2 - same reasoning, same
 * `ownerCanvasId` field, applied here at the write-filtering boundary
 * instead of the sync-eligibility gate.
 */
export function createRepoRoleResolver(repo: Repo): RoleResolver {
  return (documentId, senderId) => {
    const handle = repo.handles[documentId];
    if (handle?.isReady()) {
      const doc = handle.doc();
      if (hasAclField(doc)) {
        return readCanvasRole(doc, senderId);
      }
      const ownerCanvasId = (doc as { ownerCanvasId?: unknown } | undefined)?.ownerCanvasId;
      if (typeof ownerCanvasId === "string" && ownerCanvasId) {
        const ownerHandle = repo.handles[ownerCanvasId as DocumentId];
        if (ownerHandle?.isReady()) {
          const ownerDoc = ownerHandle.doc();
          if (hasAclField(ownerDoc)) {
            return readCanvasRole(ownerDoc, senderId);
          }
        }
      }
      return "viewer";
    }
    if (handle?.state === "requesting") {
      // storage was checked and came up empty - this device has never
      // synced this document before, so there's no prior "downgraded to
      // viewer" state a bypass could be exploiting. "member" (not
      // "admin") is used here only as "not read-only" - this resolver's
      // return value only ever feeds `isReadOnlyCanvasRole()` below, it
      // never grants admin-only authority (share/invite) anywhere else.
      return "member";
    }
    return "viewer";
  };
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

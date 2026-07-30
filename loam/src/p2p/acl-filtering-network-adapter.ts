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
import { log } from "@freqhole/reliquary/utils";

const TAG = "p2p.acl-filter-resolver";

// diagnostic-only: logs a given (doc, peer, resolved-role) combination at
// most once per page session - see canvas-scoped-share-policy.ts's matching
// diagnostic for the other half of this pair. safe to delete both once the
// "requester's doc handle never reaches ready" bug is found.
const loggedOnce = new Set<string>();
function logOnce(key: string, msg: string, ...args: unknown[]): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  // trace (not debug) - see canvas-scoped-share-policy.ts's matching
  // logOnce() comment for why.
  log.trace(TAG, msg, ...args);
}

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
 * the bootstrap sync through unfiltered.
 *
 * `"unavailable"` gets the SAME bypass, for the same reason. it looks like
 * it should be a hard failure state, but automerge-repo's own state chart
 * (`DocHandle.js`) only ever reaches `"unavailable"` FROM `"loading"` or
 * `"requesting"` - i.e. local storage has always already been checked and
 * come up empty by the time this state is entered, exactly like
 * `"requesting"` - and its entry handler resets the doc to `A.init()`, so
 * there is never a real prior copy being protected here either. the state
 * is also NOT terminal: automerge-repo's chart still accepts a `DOC_READY`
 * transition out of `"unavailable"` straight to `"ready"` the moment real
 * sync content arrives (see `canvas-store.ts`'s `resolveDocReady()`, built
 * specifically around this fact instead of treating `"unavailable"` as
 * terminal the way automerge-repo's own `repo.find()` does). a real,
 * confirmed production deadlock (2026-07-29): a brand-new invite's local
 * handle can race into `"unavailable"` (via automerge-repo's own internal
 * ~60s `after` timeout, or another connected-but-unrelated peer replying
 * `DOC_UNAVAILABLE` before the real owner's connection even finishes
 * negotiating) before the owner's actual sync payload ever arrives.
 * treating `"unavailable"` as an ordinary not-ready state (falling through
 * to the strict `"viewer"` default below) meant that payload got silently
 * stripped every single time, forever - the doc could never reach
 * `"ready"` no matter how long the caller was willing to wait, since
 * automerge-repo's own recovery path requires real content to actually
 * get through first.
 *
 * any OTHER not-ready state (`"loading"` - still checking local storage
 * for a document this device may already know from a past session;
 * `"idle"`/`"unloaded"`) keeps the strict `"viewer"` default, so a page
 * reload of an already-known (possibly viewer-downgraded) canvas can't
 * exploit this bootstrap window - local storage resolves to `"ready"`
 * almost immediately, well before any peer's sync traffic could arrive, so
 * the window this bypass opens never applies to a document the device has
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
    if (handle?.state === "requesting" || handle?.state === "unavailable") {
      // storage was checked and came up empty - this device has never
      // synced this document before, so there's no prior "downgraded to
      // viewer" state a bypass could be exploiting. "member" (not
      // "admin") is used here only as "not read-only" - this resolver's
      // return value only ever feeds `isReadOnlyCanvasRole()` below, it
      // never grants admin-only authority (share/invite) anywhere else.
      logOnce(
        "bootstrap-bypass:" + documentId + ":" + senderId + ":" + handle.state,
        "role resolved via bootstrap bypass (" + handle.state + ") -> member (not read-only)",
        "doc:",
        documentId.slice(0, 16) + "...",
        "sender:",
        senderId.slice(0, 16) + "..."
      );
      return "member";
    }
    logOnce(
      "default-viewer:" + documentId + ":" + senderId + ":" + (handle?.state ?? "no-handle"),
      "role resolved via default fallback -> viewer (read-only, changes will be stripped)",
      "doc:",
      documentId.slice(0, 16) + "...",
      "sender:",
      senderId.slice(0, 16) + "...",
      "handle.state:",
      handle?.state ?? "(no handle at all)"
    );
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

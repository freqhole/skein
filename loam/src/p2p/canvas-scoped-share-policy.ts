// ---------------------------------------------------------------------------
// canvas-scoped automerge-repo share policy
//
// automerge-repo's own default `shareConfig` (`{ announce: async () => true,
// access: async () => true }`) shares EVERY locally-known document with ANY
// connected peer — narthex, every canvas ever created or visited, the
// private social/messagez docs, all of it — the moment that peer connects
// for automerge sync, regardless of what they were actually invited to.
// this app never overrode that default, so a reliquary hub connected purely
// to accept ONE canvas invite would (per automerge-repo's own
// `CollectionSynchronizer.addPeer()`, which iterates every doc synchronizer
// and checks `shouldShare` unconditionally) get proactively pushed a copy of
// every other canvas/doc this peer has ever touched too — a real
// confidentiality gap, not just a cosmetic one (a user-reported concern,
// 2026-07-03: "is it that the hub peer is syncing ALL of a user's canvases?
// it should only sync stuff i share with it").
//
// this module scopes both `announce` (do we proactively push a doc to a
// peer) and `access` (do we honor a peer's own request for a doc) down to:
// "does this specific document's own `.acl` list this peer" — the exact
// same per-document ACL model `CanvasStore`/`ProfileStore`/
// `createRepoRoleResolver()` (acl-filtering-network-adapter.ts) already use,
// just enforced at the network-boundary sync-eligibility layer instead of
// (or rather, in addition to) the CRDT-content-filtering layer that adapter
// covers. a doc with no `.acl` field at all (narthex, social, messagez —
// none of which are ever meant to leave the local device) is denied by
// default, not treated as "no restriction".
//
// per-widget state docs (file/canvas-card/canvas-info/etc.) don't carry
// their own `.acl` — they inherit whichever canvas references them via that
// canvas's `widgets[*].docId`. this policy resolves that by scanning
// locally-known canvas docs for a `widgets` entry pointing at the requested
// document id, then checking the OWNING canvas's `.acl` instead. a widget
// doc whose owning canvas can't be found locally (not yet loaded, or
// genuinely orphaned) is denied — same "deny unless positively authorized"
// default as everything else here.
// ---------------------------------------------------------------------------

import type { DocumentId, PeerId, Repo } from "@automerge/automerge-repo";

/** minimal shape this policy actually reads off a doc — deliberately loose
 *  (`unknown`-ish), since it must tolerate every doc shape in the app
 *  (canvas, profile, narthex, social, messagez, per-widget state, ...) and
 *  untrusted remote-synced data. */
interface AclBearingDoc {
  acl?: Record<string, { role?: unknown }>;
}

interface WidgetBearingDoc {
  widgets?: Record<string, { docId?: unknown }>;
}

/**
 * true if `doc` has an `.acl` object (regardless of whether `peerId` is
 * actually in it) — used to distinguish "this is an ACL-bearing doc type,
 * so check membership" from "this doc type never carries its own ACL, keep
 * looking (e.g. at an owning canvas)".
 */
function hasAclField(doc: unknown): doc is AclBearingDoc {
  return !!doc && typeof doc === "object" && "acl" in doc && typeof (doc as AclBearingDoc).acl === "object";
}

/** true if `peerId` has any recorded role at all in `doc.acl`. does not
 *  distinguish admin/member/viewer — any of the three is "authorized to
 *  sync this doc" for this policy's purposes (role-based read/write
 *  restriction is a separate, already-existing concern — see
 *  `AclFilteringNetworkAdapter`/`createRepoRoleResolver`). */
function peerIsInAcl(doc: AclBearingDoc, peerId: string): boolean {
  return typeof doc.acl?.[peerId]?.role === "string";
}

/**
 * find a locally-known canvas doc that references `documentId` as one of
 * its widgets' `docId`, and return whether `peerId` is authorized on THAT
 * canvas's own `.acl`. returns `false` if no owning canvas is found
 * locally (deny by default), not just when one is found and denies.
 */
function widgetDocAuthorizedViaOwningCanvas(
  repo: Repo,
  documentId: DocumentId,
  peerId: string
): boolean {
  for (const handle of Object.values(repo.handles)) {
    if (!handle.isReady()) continue;
    const ownerDoc = handle.doc() as WidgetBearingDoc | undefined;
    if (!ownerDoc?.widgets) continue;

    const isReferencedHere = Object.values(ownerDoc.widgets).some((w) => w?.docId === documentId);
    if (!isReferencedHere) continue;

    // found the owning canvas — its own .acl (if any) is authoritative,
    // regardless of whether it has one. don't keep searching other
    // handles once the real owner is found, even if it denies.
    return hasAclField(ownerDoc) && peerIsInAcl(ownerDoc, peerId);
  }
  return false;
}

/**
 * build a `Repo.shareConfig`-compatible policy scoping sync eligibility to
 * "does this specific document (or, for a per-widget state doc, its owning
 * canvas) list this peer in its own `.acl`". intended to be assigned to
 * BOTH `announce` and `access` (see this module's doc comment for why both
 * matter — `announce` alone leaves the door open for a peer to just ask for
 * an unshared doc directly).
 *
 * `documentId` is optional per automerge-repo's own `SharePolicy` type
 * (called with `undefined` in some internal paths) — treated as deny.
 *
 * results are memoized per `(peerId, documentId)` for a short window (see
 * `CACHE_TTL_MS`). automerge-repo calls `announce`/`access` for EVERY
 * locally-known doc synchronizer on every peer (re)connect
 * (`CollectionSynchronizer.addPeer`), and again on every single inbound
 * sync message for a doc (`#documentGenerousPeers`/`receiveMessage`) —
 * both call `announce` AND `access` together (`Promise.all`) every time,
 * so a single peer reconnect against a canvas with a handful of widgets
 * means dozens of evaluations in a tight burst. cutting that redundant
 * work is a reasonable win on its own, independent of the open regression
 * noted below.
 *
 * KNOWN OPEN ISSUE (2026-07-03, not yet root-caused): wiring this policy
 * in made `canvas-share-hub.spec.ts`'s "hub restarted mid-flight" test
 * fail consistently (it passed reliably before). isolated so far to the
 * `announce` gate specifically (leaving `access` restrictive but
 * `announce` permissive still fails; leaving `announce` permissive but
 * `access` restrictive mostly passes) — i.e. something about this
 * function being asked as the `announce` policy specifically prevents
 * the canvas doc's content from ever reaching the hub within its ~30s
 * peer-write retry budget after a restart/reconnect, even though the
 * policy's own decision (checked via debug logging) correctly resolves
 * to `true` for that peer+doc. tried and ruled out: (a) this being a
 * synchronous-CPU/event-loop-starvation problem (the memoizing cache
 * added here was the fix attempt, did not help), (b) automerge-repo's
 * own documented "reconnecting peer is a no-op in
 * `CollectionSynchronizer#addPeer`" gap (tried forcing
 * `repo.synchronizer.reevaluateDocumentShare()` on every
 * `networkSubsystem` "peer" event, did not help either). see
 * `/memories/session/canvas-scoped-share-policy-regression.md` for the
 * full investigation log before resuming this.
 */
const CACHE_TTL_MS = 1000;

export function createCanvasScopedSharePolicy(
  repo: Repo
): (peerId: PeerId, documentId?: DocumentId) => Promise<boolean> {
  const cache = new Map<string, { result: boolean; expiresAt: number }>();

  return async (peerId, documentId) => {
    if (!documentId) return false;

    const cacheKey = `${peerId}:${documentId}`;
    const cached = cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    const result = await evaluate(repo, peerId, documentId);
    cache.set(cacheKey, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
  };
}

async function evaluate(repo: Repo, peerId: PeerId, documentId: DocumentId): Promise<boolean> {
  const handle = repo.handles[documentId];
  if (!handle) return false;

  // best-effort: give an already-in-flight load a moment to resolve so a
  // doc that's *about* to be ready isn't denied purely on timing. not
  // awaited indefinitely — `shareConfig` callbacks run on a hot sync
  // path, so a doc that never becomes ready should fall through to
  // "deny", not hang the caller.
  if (!handle.isReady()) {
    await Promise.race([
      handle.whenReady().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 200)),
    ]);
  }
  if (!handle.isReady()) return false;

  const doc = handle.doc();
  if (!doc) return false;

  if (hasAclField(doc)) {
    return peerIsInAcl(doc, peerId);
  }

  // no .acl field on this doc itself — check whether it's a per-widget
  // state doc owned by a canvas the peer IS authorized on.
  return widgetDocAuthorizedViaOwningCanvas(repo, documentId, peerId);
}

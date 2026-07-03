// ---------------------------------------------------------------------------
// canvas-scoped automerge-repo share policy
//
// automerge-repo's own default `shareConfig` (`{ announce: async () => true,
// access: async () => true }`) shares EVERY locally-known document with ANY
// connected peer — narthex, every canvas ever created or visited, the
// private social/messagez docs, all of it — the moment that peer connects
// for automerge sync, regardless of what they were actually invited to. a
// real, confirmed confidentiality gap, 2026-07-03 ("is it that the hub peer
// is syncing ALL of a user's canvases? it should only sync stuff i share
// with it").
//
// this module scopes `announce` (do we proactively push a doc to a peer)
// and `access` (do we honor a peer's own request for a doc) using two
// layered rules, from most to least precise:
//
// 1. a doc with its own `.acl` field (a canvas doc) — sync eligibility is
//    exactly "does `.acl` list this peer" (any role). this is the same
//    per-document ACL model `CanvasStore`/`createRepoRoleResolver()`
//    (acl-filtering-network-adapter.ts) already use, just enforced at the
//    network-boundary sync-eligibility layer instead of (or rather, in
//    addition to) the CRDT-content-filtering layer that adapter covers. a
//    doc with an `.acl` field that doesn't list the peer (including an
//    EMPTY `.acl`, e.g. narthex, which is a real canvas doc that never gets
//    `stampAdmin()`'d — see `narthex-seed.ts`) is denied, full stop, no
//    fallback.
//
// 2. a doc with NO `.acl` of its own but an `ownerCanvasId` field (a
//    per-widget state doc — file, audio-recording, etc; see
//    `widget-manager.ts`'s `mountWidget()`, which stamps this at creation
//    time) — sync eligibility defers to THAT canvas's own `.acl`, if the
//    canvas doc is locally known and ready. if it isn't (yet), fall back to
//    rule 3 (friend-gate) rather than denying outright — the canvas doc
//    becoming available later re-triggers this via `CanvasStore`'s own
//    `reevaluateDocumentShare()` call on every change, narrowing access
//    down to the real ACL once it's resolvable.
//
//    `ownerCanvasId` is an infrastructure-only field, unrelated to any
//    widget's own application data — several widget schemas already have
//    their OWN, differently-meaning `canvasDocId` field (`canvas-card.ts`:
//    the canvas a narthex card *links to*; `messagez-widget.ts`: the canvas
//    a knock/invite message *refers to*), so reusing THAT name here for
//    "the canvas this widget doc physically lives on" would silently
//    collide and corrupt those widgets' real data — hence the different
//    name. this field is written directly into the automerge doc's raw
//    content (bypassing each widget's own zod schema, which strips
//    anything it doesn't declare) and is never read by widget code — only
//    this policy reads it, straight off `handle.doc()`.
//
//    this deliberately replaces an EARLIER, more "precise"-looking design
//    that instead reverse-scanned every other locally-known doc looking for
//    one whose `widgets[*].docId` referenced this doc, to guess its owning
//    canvas. that had a real, confirmed race: a widget doc's own sync-
//    eligibility check runs essentially the instant `repo.create()` is
//    called, which could run before the *separate* canvas-doc sync message
//    (carrying the new widget's docId link) ever reached a remote peer —
//    two independent automerge docs, no ordering guarantee between their
//    sync messages — silently and permanently denying a widget that should
//    have been allowed (2026-07-03: reported as "widgets not syncing
//    between peers, sometimes showing a crashed UI state"). direct
//    ownership (`ownerCanvasId`, stamped once at creation, always part of
//    the doc's own synced content) needs no such guessing.
//
// 3. anything else (no `.acl`, no `ownerCanvasId` — social/messagez docs,
//    or a widget doc created before `ownerCanvasId` existed) — denied by
//    default. these were never meant to leave the local device via
//    automerge-repo sync at all (friend requests/messages go over a
//    dedicated protocol instead, see `friends-protocol.ts`), so there's no
//    friend-gate fallback for this bucket specifically — only rule 2's
//    "resolving a real widget's owning canvas" gets that allowance.
// ---------------------------------------------------------------------------

import type { DocumentId, PeerId, Repo } from "@automerge/automerge-repo";

/** minimal shape this policy actually reads off a doc — deliberately loose
 *  (`unknown`-ish), since it must tolerate every doc shape in the app
 *  (canvas, profile, narthex, social, messagez, per-widget state, ...) and
 *  untrusted remote-synced data. */
interface AclBearingDoc {
  acl?: Record<string, { role?: unknown }>;
}

interface WidgetOwnedDoc {
  ownerCanvasId?: unknown;
}

/**
 * true if `doc` has an `.acl` object (regardless of whether `peerId` is
 * actually in it) — used to distinguish "this is an ACL-bearing doc type,
 * so check membership, no fallback" from "this doc type never carries its
 * own ACL, keep looking (e.g. at an owning canvas, or the friend-gate
 * floor)".
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

const CACHE_TTL_MS = 1000;

/**
 * build a `Repo.shareConfig`-compatible policy. intended to be assigned to
 * BOTH `announce` and `access` (see this module's doc comment for why both
 * matter — `announce` alone leaves the door open for a peer to just ask
 * for an unshared doc directly).
 *
 * `isFriend` is a lazily-read callback (not a snapshot) so it can be wired
 * up via the same "box" pattern `boot.ts` already uses for `roleResolver` —
 * the social/friends doc isn't available yet at the point this policy is
 * constructed, only once `boot()` finishes a bit later.
 *
 * `documentId` is optional per automerge-repo's own `SharePolicy` type
 * (called with `undefined` in some internal paths) — treated as deny.
 *
 * results are memoized per `(peerId, documentId)` for a short window —
 * automerge-repo calls `announce`/`access` for EVERY locally-known doc
 * synchronizer on every peer (re)connect, and again on every inbound sync
 * message for a doc, both calling `announce` AND `access` together on
 * every call, so a single peer reconnect against a canvas with a handful
 * of widgets means dozens of evaluations in a tight burst — cutting that
 * redundant work is a reasonable, low-risk win on its own.
 */
export function createCanvasScopedSharePolicy(
  repo: Repo,
  isFriend: (peerId: string) => boolean
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

    const result = await evaluate(repo, peerId, documentId, isFriend);
    cache.set(cacheKey, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
  };
}

async function evaluate(
  repo: Repo,
  peerId: PeerId,
  documentId: DocumentId,
  isFriend: (peerId: string) => boolean
): Promise<boolean> {
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

  // rule 1 — a real canvas doc, own ACL is authoritative, no fallback.
  if (hasAclField(doc)) {
    return peerIsInAcl(doc, peerId);
  }

  // rule 2 — a per-widget state doc, stamped with its owning canvas's id.
  const ownerCanvasId = (doc as WidgetOwnedDoc).ownerCanvasId;
  if (typeof ownerCanvasId === "string" && ownerCanvasId) {
    const ownerHandle = repo.handles[ownerCanvasId as DocumentId];
    if (ownerHandle?.isReady()) {
      const ownerDoc = ownerHandle.doc();
      if (hasAclField(ownerDoc)) {
        return peerIsInAcl(ownerDoc, peerId);
      }
    }
    // owning canvas not resolvable locally yet — friend-gate floor, not a
    // hard deny (see this module's doc comment, rule 2).
    return isFriend(peerId);
  }

  // rule 3 — no .acl, no ownerCanvasId. deny by default.
  return false;
}

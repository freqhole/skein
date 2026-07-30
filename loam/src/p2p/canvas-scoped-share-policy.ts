// ---------------------------------------------------------------------------
// canvas-scoped automerge-repo share policy
//
// automerge-repo's own default `shareConfig` (`{ announce: async () => true,
// access: async () => true }`) shares EVERY locally-known document with ANY
// connected peer — narthex, every canvas ever created or visited, the
// private social/messagez docs, all of it — the moment that peer connects
// for automerge sync, regardless of what they were actually invited to. this
// is a confirmed confidentiality gap ("is it that the hub peer is syncing ALL
// of a user's canvases? it should only sync stuff i share with it").
//
// this module scopes `announce` (do we proactively push a doc to a peer)
// and `access` (do we honor a peer's own request/accept an inbound push for
// a doc) using layered rules, from most to least precise. **both** are
// evaluated the same way here — `announce` alone would leave the door open
// for a peer to just ask for an unshared doc directly.
//
// CRITICAL DESIGN CONSTRAINT: a peer opening a canvas newly shared with them
// can trigger an uncaught "Document ...
// is unavailable" crash): `access`/`announce` get evaluated on BOTH the
// data-holding side (who has real content, real `.acl`, and can safely
// make a content-based decision) AND the first-time-receiving side (who by
// definition has NO content yet for a doc they've never seen before —
// that's exactly what's being negotiated). a rule that requires reading
// `.acl` off the doc's own content is fine for the former and IMPOSSIBLE
// for the latter — the doc can only become ready by accepting the very
// message this policy is being asked whether to accept. this is why every
// rule below explicitly separates "doc is ready, make the real content-
// based decision" from "doc isn't ready yet, don't wait for it (no
// setTimeout/polling — automerge-repo re-invokes this policy on every
// subsequent reconnect and inbound message, and `CanvasStore`'s own
// `reevaluateDocumentShare()` call on every change re-triggers it too, so
// the decision self-corrects, purely event-driven, the moment real content
// arrives) — fall back to a friend-gate floor instead of denying outright."
// that floor is safe: it only ever applies transiently, on whichever
// device DOESN'T yet hold the real data — the device that DOES hold it
// always evaluates the real, content-based rule (its own handle is always
// ready), so a friend fishing for a canvas they were never actually
// invited to still gets correctly denied there.
//
// the rules:
//
// 1. a doc with its own `.acl` field once ready (a canvas doc) — sync
//    eligibility is exactly "does `.acl` list this peer" (any role). this
//    is the same per-document ACL model `CanvasStore`/
//    `createRepoRoleResolver()` (acl-filtering-network-adapter.ts) already
//    use, just enforced at the network-boundary sync-eligibility layer
//    too. an EMPTY `.acl` (e.g. narthex, which is a real canvas doc that
//    never gets `stampAdmin()`'d — see `narthex-seed.ts`) denies everyone,
//    correctly, once ready — no special-casing needed.
//
// 2. a doc with NO `.acl` of its own but an `ownerCanvasId` field once
//    ready (a per-widget state doc — file, audio-recording, etc; see
//    `widget-manager.ts`'s `mountWidget()`, which stamps this at creation
//    time) — sync eligibility defers to THAT canvas's own `.acl`, if the
//    canvas doc is ALSO locally known and ready. if the owning canvas
//    itself isn't resolvable yet either, friend-gate floor (same
//    self-correcting reasoning as above).
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
//    this rule deliberately replaces an EARLIER, more "precise"-looking
//    design that instead reverse-scanned every other locally-known doc
//    looking for one whose `widgets[*].docId` referenced this doc, to
//    guess its owning canvas — a real, confirmed race (a widget doc's own
//    sync-eligibility check could run before the *separate* canvas-doc
//    sync message carrying the new widget's docId link ever reached a
//    remote peer), fixed by direct, always-available ownership instead of
//    guessing.
//
// 3. a doc that IS ready, and has neither `.acl` nor `ownerCanvasId` —
//    social/messagez/narthex-shaped docs. denied, no fallback: these were
//    never meant to leave the local device via automerge-repo sync at all
//    (friend requests/messages go over a dedicated protocol instead, see
//    `friends-protocol.ts`).
//
// 4. a doc that is NOT YET ready (registered locally — automerge-repo
//    always registers a handle before any sync traffic for it can flow —
//    but no content has arrived yet) — friend-gate floor, full stop. we
//    genuinely cannot know yet which of rules 1-3 will end up applying, so
//    we don't try to guess further than "is this at least a friend" (the
//    minimum bar for anything reaching this policy at all). self-corrects
//    to the real rule the moment the doc actually becomes ready (see the
//    "critical design constraint" note above).
// ---------------------------------------------------------------------------

import type { DocumentId, PeerId, Repo } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";

const TAG = "p2p.canvas-share-policy";

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

/**
 * build a `Repo.shareConfig`-compatible policy. intended to be assigned to
 * BOTH `announce` and `access`.
 *
 * `isFriend` is a lazily-read callback (not a snapshot) so it can be wired
 * up via the same "box" pattern `boot.ts` already uses for `roleResolver` —
 * the social/friends doc isn't available yet at the point this policy is
 * constructed, only once `boot()` finishes a bit later.
 *
 * `documentId` is optional per automerge-repo's own `SharePolicy` type
 * (called with `undefined` in some internal paths) — treated as deny.
 *
 * deliberately synchronous in spirit (wrapped in `Promise.resolve()` only
 * because the `SharePolicy` type requires a `Promise<boolean>`) — no
 * `await`, no polling, no timeout anywhere in this function. see the
 * module doc comment's "critical design constraint" section for why: a
 * not-yet-ready doc gets an immediate, honest "friend-gate floor" answer
 * rather than waiting around for it to maybe become ready, trusting
 * automerge-repo's own re-invocation (on every reconnect/inbound message)
 * plus `CanvasStore`'s `reevaluateDocumentShare()` hook to naturally
 * re-ask once real content — and therefore a real answer — is available.
 */
export function createCanvasScopedSharePolicy(
  repo: Repo,
  isFriend: (peerId: string) => boolean
): (peerId: PeerId, documentId?: DocumentId) => Promise<boolean> {
  return async (peerId, documentId) => evaluate(repo, peerId, documentId, isFriend);
}

// diagnostic-only: logs a given (doc, peer, outcome-tag) combination at most
// once per page session, so a peer stuck retrying a not-ready doc doesn't
// flood the console - see friendz-wiring.ts's matching approveKnock log for
// the other half of this diagnostic pair. safe to delete both once the
// underlying "requester's doc handle never reaches ready" bug is found.
const loggedOnce = new Set<string>();
function logOnce(key: string, msg: string, ...args: unknown[]): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  // trace (not debug): this fires once per unique doc+peer+outcome combo,
  // which still adds up to a lot of console noise across ~20 locally
  // known docs every time a peer connects. the acute bug this was added
  // to diagnose (2026-07-29's "unavailable"-state deadlock) is now fixed
  // - kept at trace (off by default) rather than removed outright in case
  // it's needed again.
  log.trace(TAG, msg, ...args);
}

function evaluate(
  repo: Repo,
  peerId: PeerId,
  documentId: DocumentId | undefined,
  isFriend: (peerId: string) => boolean
): boolean {
  if (!documentId) return false;

  const handle = repo.handles[documentId];
  if (!handle) {
    logOnce(
      "no-handle:" + documentId + ":" + peerId,
      "deny: no local handle at all for doc:",
      documentId.slice(0, 16) + "...",
      "peer:",
      peerId.slice(0, 16) + "..."
    );
    return false;
  }

  // rule 4 — not ready yet: friend-gate floor, no waiting. see this
  // module's doc comment for why this is both necessary (the alternative
  // is an impossible-to-satisfy content check) and safe (this branch only
  // ever applies transiently, on whichever device doesn't yet hold the
  // real data — the data-holding device's handle is always ready, so it
  // always gets the real, content-based answer below instead).
  if (!handle.isReady()) {
    const allowed = isFriend(peerId);
    logOnce(
      "rule4:" + documentId + ":" + peerId + ":" + allowed + ":" + handle.state,
      "rule 4 (not ready yet, friend-gate floor):",
      allowed ? "allow" : "deny",
      "doc:",
      documentId.slice(0, 16) + "...",
      "peer:",
      peerId.slice(0, 16) + "...",
      "handle.state:",
      handle.state
    );
    return allowed;
  }

  const doc = handle.doc();
  if (!doc) return false;

  // rule 1 — a real canvas doc, own ACL is authoritative, no fallback.
  if (hasAclField(doc)) {
    const allowed = peerIsInAcl(doc, peerId);
    if (!allowed) {
      logOnce(
        "rule1-deny:" + documentId + ":" + peerId,
        "rule 1 deny: peer not in doc.acl",
        "doc:",
        documentId.slice(0, 16) + "...",
        "peer:",
        peerId.slice(0, 16) + "...",
        "acl keys:",
        JSON.stringify(Object.keys(doc.acl ?? {}).map((k) => k.slice(0, 16) + "..."))
      );
    }
    return allowed;
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

  // rule 3 — ready, no .acl, no ownerCanvasId. deny by default.
  return false;
}

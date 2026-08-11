// ---------------------------------------------------------------------------
// profile automerge document — schema + store.
//
// see docs/hub-and-profile-plan.md section 6. this is a NEW, synced,
// shareable doc type — distinct from `SocialDoc`'s `profile` sub-schema
// (widgets/narthex/social/schema.ts), which stays private/local/per-user
// and is never synced to anyone. that doc is "what i know about myself,
// kept on my own devices"; this one is "what i choose to publish to
// friends" — same underlying fields (username/bio/avatar) but a different
// doc with a different trust boundary, so friends can hold/sync a read-only
// copy without also getting the rest of the local social doc (friend list,
// pending requests, private share groups, etc).
//
// this file covers section 6's first half only (schema + store for
// creating/reading/updating your OWN profile doc) per the phased order in
// section 8 step 4. gossip relay (section 8 step 5) and the canvas-bin
// widget (section 8 step 6) are separate, later phases — not built here.
//
// mirrors canvas-doc.ts + canvas-store.ts's "typed automerge doc + a Store
// class wrapping DocHandle with typed accessor methods" pattern closely,
// bundled into a single file here since the profile doc is much smaller
// than the canvas doc (no widgets/peers/invites/knocks to model).
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import { getMetaValue, setMetaValue } from "../storage/meta-db";
import { resolveDocReadyCached } from "../p2p/doc-ready";
import { logDocHistoryStats } from "../p2p/doc-history-stats";
import { canvasRoleSchema, type CanvasRole } from "./canvas-doc";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

/** a single canvas curated onto a peer's profile — a title/description/
 *  preview index, not a live grant of access (see the module doc comment
 *  in docs/hub-and-profile-plan.md section 2: a profile's listed canvases
 *  are deliberately NOT auto-viewable; opening one you lack access to
 *  falls back to the existing knock/invite flow). */
export const profileCanvasEntrySchema = z.object({
  canvasDocId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  color: z.number().optional(),
  previewUrl: z.string().optional(),
  /** ISO timestamp. set once, when the entry is first added — see
   *  `ProfileStore.addCanvasToProfile()`. */
  addedAt: z.string(),
});
export type ProfileCanvasEntry = z.infer<typeof profileCanvasEntrySchema>;

/**
 * the top-level profile document stored in Automerge. one per local peer
 * identity — see `ensureMyProfileDoc()` below for how "my own" profile doc
 * is created/discovered.
 */
export const profileDocumentSchema = z.object({
  username: z.string(),
  bio: z.string(),
  avatarDataUrl: z.string(),
  /** curated, user-chosen list — see `ProfileCanvasEntry` above. */
  canvases: z.array(profileCanvasEntrySchema),
  /**
   * the local peer's own canvas-bin doc id (canvas-bin-doc.ts's
   * `CanvasBinStore`) — a separate automerge doc holding the recursive
   * folder tree that organizes this profile's curated canvases for
   * display (see docs/hub-and-profile-plan.md section 10.2). riding this
   * along on the profile doc (rather than inventing a new gossip/wire
   * field) means a friend who already syncs this profile doc for free
   * also learns where to find the owner's canvas-bin doc, once they open
   * it — see `ProfileStore.setCanvasBinDocId()`/`canvasBinDocId()` below.
   * "" / absent means the local peer hasn't created one yet.
   */
  canvasBinDocId: z.string().optional(),
  /**
   * ISO timestamp of the last content mutation (username/bio/avatar/
   * canvases — NOT `.acl` changes, which aren't "profile content").
   * stamped by every mutating `ProfileStore` method. used for gossip
   * staleness comparison (see `docs/hub-and-profile-plan.md` section 6's
   * gossip relay) — a peer relaying a `GossipDigestProfileEntry` includes
   * this so the receiver can tell whether its own cached copy (if any) is
   * out of date, without opening the doc itself.
   */
  updatedAt: z.string().optional(),
  /**
   * access control — see the "access control" section of this file's doc
   * comment (near `ProfileStore`) for the full reasoning. reuses
   * `CanvasRole`'s shape/schema so the existing generic
   * `createRepoRoleResolver()` (p2p/acl-filtering-network-adapter.ts) can
   * enforce it at the network boundary for free, with zero changes to that
   * file — it already resolves `.acl` on whatever doc a documentId points
   * at, not just canvas docs specifically.
   */
  acl: z.record(z.string(), z.object({ role: canvasRoleSchema })).optional(),
});
export type ProfileDocument = z.infer<typeof profileDocumentSchema>;

/** create an empty profile document with default values. */
export function emptyProfileDoc(): ProfileDocument {
  return {
    username: "",
    bio: "",
    avatarDataUrl: "",
    canvases: [],
  };
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/**
 * wraps the profile automerge document with typed accessor/mutation
 * methods — mirrors `CanvasStore`'s constructor/create/open shape.
 *
 * ## access control
 *
 * a profile doc is inherently "owner writes, everyone-with-a-copy reads" —
 * there's no admin/member complexity to model (no invites, no nested
 * resources, no concept of a second writer ever). that said, this reuses
 * `CanvasRole`'s `"viewer"` value (rather than inventing a second, parallel
 * ACL shape) for one concrete reason: it's a clean, zero-cost fit with the
 * existing network-boundary enforcement in
 * `p2p/acl-filtering-network-adapter.ts`. `createRepoRoleResolver()` reads
 * `.acl` off *any* doc a `documentId` resolves to (it's not hardcoded to
 * `CanvasDocument`), so simply giving `ProfileDocument` an `.acl` field of
 * the same shape means a friend syncing this doc is already prevented from
 * writing to it, with no changes needed to that file.
 *
 * access control mirrors `CanvasStore.getRole()`'s convention: a *missing*
 * `.acl` entry defaults to `"viewer"`, the safe read-only floor, both for
 * `ProfileStore.getRole()`'s own local reads below and for the
 * network-level `createRepoRoleResolver()` (generic/shared code that reads
 * `.acl` off whatever doc a `documentId` resolves to, not just canvas
 * docs). `grantViewerRole()` still always writes an explicit
 * `{ role: "viewer" }` entry when a profile is shared with a peer, so the
 * doc's `.acl` map stays an accurate record of who it's been shared with,
 * even though an absent entry already resolves to the same read-only
 * outcome.
 *
 * admin/member distinctions are simply never used on this doc — only
 * `"viewer"` (granted or defaulted) is meaningful here; nobody but the
 * owner should ever be able to write to their own profile doc.
 */
export class ProfileStore {
  /** the underlying automerge document handle. */
  readonly handle: DocHandle<ProfileDocument>;
  /** the automerge repo this document belongs to. */
  readonly repo: Repo;

  private constructor(repo: Repo, handle: DocHandle<ProfileDocument>) {
    this.repo = repo;
    this.handle = handle;
  }

  /** create a new profile doc with empty defaults. */
  static create(repo: Repo): ProfileStore {
    const handle = repo.create<ProfileDocument>(emptyProfileDoc());
    return new ProfileStore(repo, handle);
  }

  /** open an existing profile document by id. */
  static async open(repo: Repo, docId: DocumentId): Promise<ProfileStore> {
    // bare repo.find() defaults to allowableStates=["ready"], which blocks on
    // networkSubsystem.whenReady() when the doc isn't already in local storage
    // — use resolveDocReadyCached() like every other doc access instead.
    const handle = await resolveDocReadyCached<ProfileDocument>(repo, docId);
    if (!handle) {
      throw new Error(`profile doc ${docId} did not become ready`);
    }
    return new ProfileStore(repo, handle);
  }

  /** get the current document state. */
  doc(): ProfileDocument {
    return this.handle.doc() ?? emptyProfileDoc();
  }

  /** ISO timestamp of the last content mutation, or `""` if never set
   *  (a brand-new profile doc that's never had `setUsername`/`setBio`/
   *  `setAvatarDataUrl`/`addCanvasToProfile`/`removeCanvasFromProfile`
   *  called on it yet). used by gossip relay for staleness comparison. */
  updatedAt(): string {
    return this.doc().updatedAt ?? "";
  }

  // -- username / bio / avatar --------------------------------------------

  username(): string {
    return this.doc().username;
  }

  setUsername(name: string): void {
    this.handle.change((doc) => {
      doc.username = name;
      doc.updatedAt = new Date().toISOString();
    });
  }

  bio(): string {
    return this.doc().bio;
  }

  setBio(bio: string): void {
    this.handle.change((doc) => {
      doc.bio = bio;
      doc.updatedAt = new Date().toISOString();
    });
  }

  avatarDataUrl(): string {
    return this.doc().avatarDataUrl;
  }

  setAvatarDataUrl(url: string): void {
    this.handle.change((doc) => {
      doc.avatarDataUrl = url;
      doc.updatedAt = new Date().toISOString();
    });
  }

  // -- curated canvas list --------------------------------------------------

  /**
   * all canvas entries on this profile, validated.
   *
   * `.canvases` is regular automerge doc data — for a doc opened from a
   * remote peer (a friend's profile, once sharing/gossip lands in a later
   * phase) it's untrusted synced data with no server-side validation,
   * same posture `CanvasStore.getRole()` already takes for `.acl`. rather
   * than throwing (or trusting garbage) on a malformed entry, this drops
   * only the malformed entries and returns the rest — one bad entry
   * shouldn't make the whole profile unreadable.
   */
  canvases(): ProfileCanvasEntry[] {
    const raw = this.doc().canvases ?? [];
    const result: ProfileCanvasEntry[] = [];
    for (const entry of raw) {
      const parsed = profileCanvasEntrySchema.safeParse(entry);
      if (parsed.success) {
        result.push(parsed.data);
      }
    }
    return result;
  }

  /**
   * add a canvas to this profile, or update it if already present.
   *
   * idempotent by `canvasDocId`: adding the same canvas twice updates the
   * existing entry's title/description/color/previewUrl in place rather
   * than creating a duplicate. `addedAt` is only set the first time a
   * given `canvasDocId` is added — a later update doesn't reset it.
   */
  addCanvasToProfile(entry: Omit<ProfileCanvasEntry, "addedAt">): void {
    this.handle.change((doc) => {
      if (!doc.canvases) doc.canvases = [];
      const existing = doc.canvases.find((c) => c.canvasDocId === entry.canvasDocId);
      if (existing) {
        existing.title = entry.title;
        if (entry.description === undefined) {
          delete existing.description;
        } else {
          existing.description = entry.description;
        }
        if (entry.color === undefined) {
          delete existing.color;
        } else {
          existing.color = entry.color;
        }
        if (entry.previewUrl === undefined) {
          delete existing.previewUrl;
        } else {
          existing.previewUrl = entry.previewUrl;
        }
        return;
      }
      const fresh: ProfileCanvasEntry = {
        canvasDocId: entry.canvasDocId,
        title: entry.title,
        addedAt: new Date().toISOString(),
      };
      if (entry.description !== undefined) fresh.description = entry.description;
      if (entry.color !== undefined) fresh.color = entry.color;
      if (entry.previewUrl !== undefined) fresh.previewUrl = entry.previewUrl;
      doc.canvases.push(fresh);
      doc.updatedAt = new Date().toISOString();
    });
  }

  /** remove a canvas from this profile by its doc id. no-op if not present. */
  removeCanvasFromProfile(canvasDocId: string): void {
    this.handle.change((doc) => {
      if (!doc.canvases) return;
      const index = doc.canvases.findIndex((c) => c.canvasDocId === canvasDocId);
      if (index !== -1) {
        doc.canvases.splice(index, 1);
        doc.updatedAt = new Date().toISOString();
      }
    });
  }

  // -- canvas-bin doc pointer ------------------------------------------------

  /** the local peer's own canvas-bin doc id, if `setCanvasBinDocId()` has
   *  ever been called on this doc — see the schema field's doc comment for
   *  why this rides along on the profile doc. `undefined` means unset. */
  canvasBinDocId(): string | undefined {
    return this.doc().canvasBinDocId;
  }

  /**
   * stamp this profile's canvas-bin doc id. no-op (doesn't bump
   * `updatedAt`) if already set to the same value — this is called every
   * time `ensureMyCanvasBinDoc()` resolves (which returns the same doc id
   * on every call after the first), so guarding against a redundant write
   * avoids bumping staleness metadata for no real content change.
   */
  setCanvasBinDocId(docId: string): void {
    if (this.doc().canvasBinDocId === docId) return;
    this.handle.change((doc) => {
      doc.canvasBinDocId = docId;
      doc.updatedAt = new Date().toISOString();
    });
  }

  // -- access control ----------------------------------------------------------

  /**
   * grant `nodeId` read access to this profile doc. always writes an
   * explicit `"viewer"` entry, so the doc's `.acl` map stays an accurate
   * record of who it's been shared with (see this class's doc comment for
   * why an absent entry already resolves to the same read-only default).
   */
  grantViewerRole(nodeId: string): void {
    this.handle.change((doc) => {
      if (!doc.acl) doc.acl = {};
      doc.acl[nodeId] = { role: "viewer" };
    });
  }

  /** revoke `nodeId`'s access entirely (removes their `.acl` entry). */
  revokeRole(nodeId: string): void {
    this.handle.change((doc) => {
      if (doc.acl && doc.acl[nodeId]) {
        delete doc.acl[nodeId];
      }
    });
  }

  /**
   * effective role for a node id on this profile doc, for local
   * UI-gating purposes only (e.g. "should i show this peer a write
   * control"). defaults a missing entry to `"viewer"`, the same safe
   * default `CanvasStore.getRole()` and the network-level
   * `createRepoRoleResolver()` use for an unrecorded node.
   *
   * validates the raw value through `canvasRoleSchema` before trusting it,
   * same reasoning as `CanvasStore.getRole()` — `.acl` is untrusted synced
   * automerge data once this doc is ever opened from a remote peer.
   */
  getRole(nodeId: string): CanvasRole {
    const raw = this.doc().acl?.[nodeId]?.role;
    const parsed = canvasRoleSchema.safeParse(raw);
    return parsed.success ? parsed.data : "viewer";
  }

  // -- change subscription --------------------------------------------------

  /** subscribe to document changes. returns an unsubscribe function. */
  onChange(handler: (doc: ProfileDocument) => void): () => void {
    const listener = () => {
      handler(this.doc());
    };
    this.handle.on("change", listener);
    return () => {
      this.handle.off("change", listener);
    };
  }
}

// ---------------------------------------------------------------------------
// "my own" profile doc — creation/discovery
// ---------------------------------------------------------------------------

/**
 * meta-db key under which the local peer's own profile doc id is
 * persisted. see the doc comment on `ensureMyProfileDoc()` below for the
 * design reasoning.
 */
const PROFILE_DOC_KEY = "skein-profile-doc-id";

/**
 * read the local peer's own profile doc id, if one has already been
 * created on this device. returns `null` if `ensureMyProfileDoc()` has
 * never been called here before.
 */
export async function getMyProfileDocId(): Promise<DocumentId | null> {
  const id = await getMetaValue(PROFILE_DOC_KEY);
  return (id as DocumentId | null) ?? null;
}

/**
 * get (creating if necessary) the local peer's own profile doc.
 *
 * ## design decision: stored-reference doc id, not one derived from node id
 *
 * two options existed for "how does a peer find their own profile doc":
 *
 * 1. a doc id *deterministically derived* from the local node id (e.g.
 *    hash the node id into something automerge-repo would accept as a
 *    documentId).
 * 2. create the doc once, then persist its repo-assigned id somewhere
 *    local, and look it up by that stored reference on every subsequent
 *    boot — same as every other "one singleton doc per local peer" case
 *    already in this codebase.
 *
 * this picks option 2, for two reasons:
 *
 * - automerge-repo's `Repo.create()` always mints its own `DocumentId`
 *   (a random, repo-generated identifier) — there is no supported way to
 *   force a specific/deterministic id at creation time. building a
 *   deterministic id would mean bypassing `Repo.create()` entirely (e.g.
 *   hand-constructing storage/network records under a chosen id), which
 *   is unsupported, fragile against automerge-repo internals changing, and
 *   buys nothing a stored reference doesn't already give us.
 * - this exact "create once, persist the resulting doc id under a fixed
 *   meta-db key, look it up on every later boot" pattern is already
 *   established and proven for every other singleton doc this app has:
 *   `boot.ts`'s narthex doc (`NARTHEX_DOC_KEY`), social doc
 *   (`SOCIAL_DOC_KEY`), and messagez doc (`MESSAGEZ_DOC_KEY`) — all three
 *   use `getMetaValue`/`setMetaValue` against the same "skein-meta"
 *   IndexedDB store (`storage/meta-db.ts`) that `p2p/identity.ts` also
 *   uses for the node's own keypair. following that precedent exactly
 *   (new key, same mechanism) is more consistent and far less risky than
 *   introducing a second, novel "doc id from identity" scheme for this one
 *   doc type.
 *
 * this function itself only creates/opens the doc — it does not wire the
 * doc id into `boot.ts` (that's a separate, later integration step once
 * this phase's store is verified, consistent with "schema + store first,
 * no gossip/wiring yet" per docs/hub-and-profile-plan.md section 6).
 */
export async function ensureMyProfileDoc(repo: Repo): Promise<ProfileStore> {
  const existingId = await getMyProfileDocId();
  if (existingId) {
    const store = await ProfileStore.open(repo, existingId);
    logDocHistoryStats("profile", store.handle);
    return store;
  }
  const store = ProfileStore.create(repo);
  await setMetaValue(PROFILE_DOC_KEY, store.handle.documentId);
  return store;
}

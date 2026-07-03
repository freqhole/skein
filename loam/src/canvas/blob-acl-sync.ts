/**
 * mirrors a canvas's `.acl` onto the blob-level allow-list that
 * `IrohNetworkAdapter.restrictBlobToPeers()` (which forwards to
 * `MiddenNode::restrict_blob_to_peers` in `midden/src/lib.rs`) enforces at
 * the `iroh-blobs/*` transport layer.
 *
 * this closes the gap `blob-acl.spec.ts` documented: without this, any peer
 * that learns another peer's node id and a blob's blake3 hash can fetch it,
 * regardless of whether they're actually invited to the canvas that
 * references it. the blob-acl gate itself (`midden`'s `EventSender`-based
 * intercept) was already proven in `blob-acl-gate-prototype.spec.ts` with a
 * hardcoded allow-list; this module is the real wiring from canvas ACL data
 * into that gate.
 *
 * any widget with a per-widget automerge doc carrying a non-empty `blake3`
 * field references a P2P-fetchable blob (`widgets/file.ts` and
 * `widgets/audio-recording.ts` today; any future widget type works
 * automatically, no changes needed here) — that field lives on the
 * widget's own doc, not the canvas doc, so this watches both:
 * - the canvas doc itself, for `.acl` changes and widgets being added/
 *   removed
 * - each widget's own doc, for the moment its `blake3` field actually gets
 *   set (upload/snatch completing) — a mutation `CanvasStore.onChange`
 *   never sees, since it lives in a separate automerge document
 *
 * `restrict_blob_to_peers` REPLACES the allow-list for a hash rather than
 * adding to it (confirmed in `midden/src/lib.rs` — `HashMap::insert`
 * overwrites any existing entry). only one canvas is ever open/mounted at
 * a time in this app (see `standalone/boot.ts`'s `SkeinRouter` — one
 * `CanvasBlobAclSync` per open canvas, created in `initCanvas()`, destroyed
 * in `destroyCurrent()`), so simply "recompute and resend this canvas's
 * full current allow-list" would silently revoke access for peers a
 * *different*, currently-closed canvas legitimately still shares the same
 * blob with — whichever canvas synced last would win. `blob-acl-registry.ts`
 * fixes this: every sync reports this canvas's own hash->peers contribution
 * into a shared, session-scoped registry and pushes the UNION across every
 * canvas contribution currently known, not just this one. see that file's
 * doc comment for the full design + accepted limitations.
 */

import type { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import type { CanvasStore } from "./canvas-store";
import { sharedBlobAclRegistry, type BlobAclRegistry } from "./blob-acl-registry";
import { log } from "../utils/log";

const TAG = "canvas.blob-acl-sync";

/** coerce a raw automerge field value to a plain string, same as the
 *  `coerceStr` helper in `widgets/file-utils.ts` — automerge Text objects
 *  (which some string fields can end up as) stringify to their real
 *  content via `toString()`, so a plain `String(v)` round-trips correctly. */
function coerceStr(v: unknown): string {
  // eslint-disable-next-line eqeqeq -- intentional: catches both null and undefined
  if (v == null) return "";
  return String(v);
}

/**
 * watches a canvas's `.acl` and its file widgets, keeping each referenced
 * blob's iroh-blobs allow-list in sync via `restrictBlobToPeers` — computed
 * as the union of this canvas's own contribution and every other canvas's
 * last-known contribution recorded in the shared registry (see
 * `blob-acl-registry.ts`).
 *
 * call `start()` once (after the canvas's widgets have begun mounting) and
 * `destroy()` when the canvas is torn down. `destroy()` deliberately does
 * NOT clear this canvas's registry contribution — see `blob-acl-registry.ts`'s
 * doc comment for why that's required for the union to work across
 * navigations, not a leak.
 */
export class CanvasBlobAclSync {
  private readonly store: CanvasStore;
  private readonly repo: Repo;
  private readonly restrictBlobToPeers: (blake3Hash: string, peerNodeIds: string[]) => Promise<void>;
  private readonly registry: BlobAclRegistry;
  /** this canvas's own document id — the key this instance's contributions
   *  are recorded under in the shared registry. */
  private readonly canvasId: string;

  /** docId -> unsubscribe, for each file widget's own doc we're watching. */
  private readonly widgetUnsubs = new Map<string, () => void>();
  /** docIds currently being looked up via repo.find(), to avoid duplicate lookups. */
  private readonly pendingLookups = new Set<string>();
  private canvasUnsub: (() => void) | null = null;
  private destroyed = false;

  constructor(
    store: CanvasStore,
    repo: Repo,
    restrictBlobToPeers: (blake3Hash: string, peerNodeIds: string[]) => Promise<void>,
    registry: BlobAclRegistry = sharedBlobAclRegistry
  ) {
    this.store = store;
    this.repo = repo;
    this.restrictBlobToPeers = restrictBlobToPeers;
    this.registry = registry;
    this.canvasId = store.handle.documentId;
  }

  /**
   * begin watching. runs an immediate sync (covers blobs already referenced
   * when the canvas was opened), then reconciles on every canvas doc change
   * (ACL changes, file widgets added/removed) and every watched file
   * widget's own doc change (blake3 set after upload/snatch completes).
   */
  start(): void {
    this.reconcileWidgetWatchers();
    this.syncAll();
    this.canvasUnsub = this.store.onChange(() => {
      this.reconcileWidgetWatchers();
      this.syncAll();
    });
  }

  /**
   * stop watching and release all subscriptions. deliberately does NOT
   * clear this canvas's contribution from the shared registry — a closed
   * canvas must keep contributing its last-known peer set to the union so
   * navigating to a different canvas doesn't silently revoke access this
   * canvas still legitimately grants. see `blob-acl-registry.ts`.
   */
  destroy(): void {
    this.destroyed = true;
    this.canvasUnsub?.();
    this.canvasUnsub = null;
    for (const unsub of this.widgetUnsubs.values()) unsub();
    this.widgetUnsubs.clear();
    this.pendingLookups.clear();
  }

  /**
   * whether this canvas should currently be contributing peers to the
   * shared registry at all. false (contribute nothing) when:
   * - the canvas is tombstoned (soft- or hard-deleted) — no longer an
   *   active sharing context, see `blob-acl-registry.ts`'s doc comment.
   * - the local peer's own `.acl` entry has been removed while OTHER
   *   entries still exist — i.e. this device was itself removed from the
   *   canvas's participant list, and has no basis left to keep vouching
   *   for who else the canvas authorizes. distinguished from "this canvas
   *   simply has no ACL data at all" (an empty `.acl`, e.g. a legacy
   *   pre-ACL canvas or a test fixture that never called `stampAdmin()`/
   *   `setRole()`) — that case still contributes normally, matching the
   *   pre-existing behavior of `allowedPeerIds()` computing an empty list
   *   from an empty `.acl` regardless of this check.
   */
  private isStillParticipating(): boolean {
    if (this.store.isDeleted) return false;
    const acl = this.store.doc().acl ?? {};
    const localNodeId = this.store.localNodeId;
    if (!localNodeId) return true; // identity not resolved yet — can't tell, default to contributing
    const aclEntries = Object.keys(acl);
    if (aclEntries.length === 0) return true; // no ACL data at all — not a removal
    return aclEntries.includes(localNodeId);
  }

  /**
   * the current allow-list for this canvas: every node id with an explicit
   * `.acl` entry. the canvas creator/admin is always included here — see
   * `CanvasStore.stampAdmin()`, which writes the admin's own entry into the
   * same `.acl` map at creation time, so there's no separate "creator" case
   * to add on top of this.
   */
  private allowedPeerIds(): string[] {
    return Object.keys(this.store.doc().acl ?? {});
  }

  /**
   * add/remove per-widget doc watchers so a file widget's own doc changing
   * (not just the canvas doc) triggers a resync, and stop watching widgets
   * that no longer exist (removed, or no longer type "file").
   */
  private reconcileWidgetWatchers(): void {
    if (this.destroyed) return;

    const currentWidgetDocIds = new Set<string>();

    for (const entry of this.store.allWidgets()) {
      // any widget with a per-widget doc is a candidate — this isn't
      // narrowed to a hardcoded set of widget types (previously just
      // "file") since any widget type can reference a P2P-fetchable blob
      // by blake3 hash (audio-recording does too now — see
      // `widgets/audio-recording.ts`'s `blake3` schema field). `syncAll()`
      // is what actually filters down to docs with a real blake3 value.
      if (!entry.docId) continue;
      const docId = entry.docId;
      currentWidgetDocIds.add(docId);
      if (this.widgetUnsubs.has(docId) || this.pendingLookups.has(docId)) continue;

      this.pendingLookups.add(docId);
      this.repo
        .find<any>(docId as DocumentId)
        .then((handle: DocHandle<any>) => {
          this.pendingLookups.delete(docId);
          if (this.destroyed) return;
          // the widget may have been removed (or the doc replaced) while
          // this lookup was in flight — don't attach a stale subscription.
          const stillPresent = this.store.allWidgets().some((w) => w.docId === docId);
          if (!stillPresent) return;

          const listener = () => this.syncAll();
          handle.on("change", listener);
          this.widgetUnsubs.set(docId, () => handle.off("change", listener));

          // the blake3 field is often set moments after the widget doc is
          // created (upload/snatch completing) — resync now in case that
          // already happened before this subscription was attached.
          this.syncAll();
        })
        .catch((err) => {
          this.pendingLookups.delete(docId);
          log.warn(TAG, "failed to open widget doc for blob-acl sync:", err);
        });
    }

    for (const [docId, unsub] of this.widgetUnsubs) {
      if (!currentWidgetDocIds.has(docId)) {
        unsub();
        this.widgetUnsubs.delete(docId);
      }
    }
  }

  /**
   * recompute this canvas's own hash->peers contribution and report it
   * into the shared registry, then push the UNION across every canvas
   * contribution currently known (not just this one) for every hash
   * affected by this update. reads widget docs from `repo.handles`
   * (already-cached handles only — `reconcileWidgetWatchers` is what
   * actually opens them) so this never triggers a network fetch itself.
   */
  private syncAll(): void {
    if (this.destroyed) return;

    const contributing = this.isStillParticipating();
    const peerIds = contributing ? this.allowedPeerIds() : [];
    const contribution = new Map<string, string[]>();

    if (contributing) {
      for (const entry of this.store.allWidgets()) {
        if (!entry.docId) continue;
        const handle = this.repo.handles[entry.docId as DocumentId] as DocHandle<any> | undefined;
        if (!handle || !handle.isReady()) continue;

        const raw = handle.doc() as { blake3?: unknown } | undefined;
        const blake3 = coerceStr(raw?.blake3);
        if (blake3) contribution.set(blake3, peerIds);
      }
    }

    const affectedHashes = this.registry.setCanvasContribution(this.canvasId, contribution);
    if (affectedHashes.size === 0) return;

    for (const hash of affectedHashes) {
      const union = this.registry.unionForHash(hash);
      this.restrictBlobToPeers(hash, union).catch((err) => {
        log.warn(TAG, "restrict_blob_to_peers failed for hash", hash.slice(0, 16), err);
      });
    }
  }
}


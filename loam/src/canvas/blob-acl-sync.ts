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
 * overwrites any existing entry), so recomputing and resending the full
 * current allow-list on every change is what makes revocation actually
 * work: a peer removed from `.acl` is simply absent from the next call.
 */

import type { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo";
import type { CanvasStore } from "./canvas-store";
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
 * blob's iroh-blobs allow-list in sync via `restrictBlobToPeers`.
 *
 * call `start()` once (after the canvas's widgets have begun mounting) and
 * `destroy()` when the canvas is torn down.
 */
export class CanvasBlobAclSync {
  private readonly store: CanvasStore;
  private readonly repo: Repo;
  private readonly restrictBlobToPeers: (blake3Hash: string, peerNodeIds: string[]) => Promise<void>;

  /** docId -> unsubscribe, for each file widget's own doc we're watching. */
  private readonly widgetUnsubs = new Map<string, () => void>();
  /** docIds currently being looked up via repo.find(), to avoid duplicate lookups. */
  private readonly pendingLookups = new Set<string>();
  private canvasUnsub: (() => void) | null = null;
  private destroyed = false;

  constructor(
    store: CanvasStore,
    repo: Repo,
    restrictBlobToPeers: (blake3Hash: string, peerNodeIds: string[]) => Promise<void>
  ) {
    this.store = store;
    this.repo = repo;
    this.restrictBlobToPeers = restrictBlobToPeers;
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

  /** stop watching and release all subscriptions. */
  destroy(): void {
    this.destroyed = true;
    this.canvasUnsub?.();
    this.canvasUnsub = null;
    for (const unsub of this.widgetUnsubs.values()) unsub();
    this.widgetUnsubs.clear();
    this.pendingLookups.clear();
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
   * recompute the allow-list and every referenced blob hash, then push the
   * full allow-list to each hash. reads widget docs from `repo.handles`
   * (already-cached handles only — `reconcileWidgetWatchers` is what
   * actually opens them) so this never triggers a network fetch itself.
   */
  private syncAll(): void {
    if (this.destroyed) return;

    const peerIds = this.allowedPeerIds();
    const hashes = new Set<string>();

    for (const entry of this.store.allWidgets()) {
      if (!entry.docId) continue;
      const handle = this.repo.handles[entry.docId as DocumentId] as DocHandle<any> | undefined;
      if (!handle || !handle.isReady()) continue;

      const raw = handle.doc() as { blake3?: unknown } | undefined;
      const blake3 = coerceStr(raw?.blake3);
      if (blake3) hashes.add(blake3);
    }

    if (hashes.size === 0) return;

    for (const hash of hashes) {
      this.restrictBlobToPeers(hash, peerIds).catch((err) => {
        log.warn(TAG, "restrict_blob_to_peers failed for hash", hash.slice(0, 16), err);
      });
    }
  }
}

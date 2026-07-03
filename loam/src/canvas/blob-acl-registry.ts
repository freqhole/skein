/**
 * cross-canvas registry of "which peers does this device currently know
 * are authorized (via some canvas's `.acl`) to fetch a given blob".
 *
 * this exists to fix a real bug in `blob-acl-sync.ts`: `restrict_blob_to_peers`
 * (`midden/src/lib.rs`) REPLACES a hash's allow-list rather than adding to
 * it, and only one canvas is ever open/mounted at a time in this app (see
 * `standalone/boot.ts`'s `SkeinRouter` — exactly one `CanvasBlobAclSync` is
 * ever alive, created in `initCanvas()` and destroyed in `destroyCurrent()`).
 * without this registry, navigating from canvas A (blob H shared with
 * peers X, Y) to canvas B (blob H *also* referenced, shared with peer Z)
 * would push an allow-list of just `[Z]`, silently revoking X and Y's
 * legitimate access granted by A — even though A still shares it with them
 * and A hasn't changed at all.
 *
 * the fix: every `CanvasBlobAclSync` instance reports its own canvas's
 * current hash->peers contribution into this registry (`setCanvasContribution`),
 * and computes the allow-list to actually push as the UNION across every
 * canvas contribution currently known (`unionForHash`) — not just its own.
 *
 * design notes / accepted limitations (deliberate, considered, not
 * oversights — see the cross-canvas blob ACL union task for the full
 * reasoning):
 *
 * - **session-scoped, in-memory only.** a plain module-level singleton,
 *   reset on page reload. bounded by the number of *distinct* canvases this
 *   device opens in one session (small in practice), not "every canvas the
 *   device has ever seen" — no eviction/LRU is needed. this deliberately
 *   does NOT proactively load every canvas the device knows about just to
 *   keep their contributions warm; a canvas contributes only while (and
 *   after) it has actually been opened this session.
 *
 * - **a canvas's contribution is NOT cleared just because the canvas is
 *   closed/navigated away from.** that is the entire point of this
 *   registry — the union must include canvases that aren't currently
 *   open. `CanvasBlobAclSync.destroy()` deliberately does not clear this
 *   canvas's registry entry.
 *
 * - **a canvas that is not currently open has no live `.acl`/widget data to
 *   recompute from, so its cached contribution can go stale** (e.g. a peer
 *   removed from that canvas's `.acl` while the canvas is closed keeps
 *   contributing the old peer to the union until the canvas is reopened
 *   and resyncs). this mirrors the already-accepted "revocation only
 *   affects future access; a peer's already-synced/cached local knowledge
 *   can lag" trust model used elsewhere in this app (canvas-doc ACL
 *   revocation, blob local-caching) — closing that gap would require
 *   proactively loading every canvas the device has ever seen, which is
 *   explicitly out of scope.
 *
 * - **a deleted canvas's peers stop contributing to the union.** a
 *   soft-deleted canvas is a read-only tombstone, not an active sharing
 *   context, and a purged one is gone outright — either way its ACL
 *   shouldn't keep granting blob access on its behalf. `CanvasBlobAclSync`
 *   contributes an empty set the moment it observes its own (open)
 *   canvas's `deleted` tombstone, and callers that hard-delete a canvas
 *   the device isn't even looking at (see `standalone/boot.ts`'s
 *   canvas-card removal hook) call `clearCanvas()` directly.
 *
 * - **a canvas the local peer has itself been removed from also stops
 *   contributing**, for the same reason: once this device is no longer
 *   even a participant on that canvas, it has no basis to keep vouching
 *   for that canvas's peer list on the blob transport layer. detected live
 *   (only while the canvas happens to be open) as "local node id used to
 *   be in `.acl`, now isn't."
 */

/** blake3 hash -> peer node ids this canvas's `.acl` currently authorizes. */
export type CanvasBlobContribution = Map<string, string[]>;

export class BlobAclRegistry {
  /** canvasDocId -> (blake3Hash -> peerNodeIds) */
  private readonly byCanvas = new Map<string, CanvasBlobContribution>();

  /**
   * replace a canvas's full set of hash->peer contributions (a canvas
   * always reports its *complete* current state, not a delta — this is
   * what makes a widget/hash removal on that canvas correctly disappear
   * from its contribution instead of lingering).
   *
   * returns every hash affected by this update (present before, present
   * now, or both) so the caller knows which hashes' unions need
   * recomputing and re-pushing to `restrictBlobToPeers`.
   */
  setCanvasContribution(canvasId: string, contribution: CanvasBlobContribution): Set<string> {
    const previous = this.byCanvas.get(canvasId);
    const affected = new Set<string>();
    if (previous) for (const hash of previous.keys()) affected.add(hash);
    for (const hash of contribution.keys()) affected.add(hash);

    if (contribution.size === 0) {
      this.byCanvas.delete(canvasId);
    } else {
      this.byCanvas.set(canvasId, contribution);
    }
    return affected;
  }

  /** remove a canvas's contribution entirely (deletion, or local removal
   *  from that canvas). equivalent to `setCanvasContribution(canvasId, new Map())`. */
  clearCanvas(canvasId: string): Set<string> {
    return this.setCanvasContribution(canvasId, new Map());
  }

  /** the union of peer ids across every canvas currently contributing to
   *  this hash — this is the allow-list `CanvasBlobAclSync` should push. */
  unionForHash(hash: string): string[] {
    const union = new Set<string>();
    for (const contribution of this.byCanvas.values()) {
      const peers = contribution.get(hash);
      if (peers) for (const peerId of peers) union.add(peerId);
    }
    return [...union];
  }

  /** every hash any currently-known canvas contribution references. */
  allHashes(): Set<string> {
    const hashes = new Set<string>();
    for (const contribution of this.byCanvas.values()) {
      for (const hash of contribution.keys()) hashes.add(hash);
    }
    return hashes;
  }
}

/**
 * shared app-wide singleton — one registry for the whole session. a device
 * only has one set of "canvases known this session" regardless of which
 * canvas happens to be currently mounted, so this is a module singleton
 * rather than something threaded through per-canvas construction. tests
 * that need isolation construct their own `new BlobAclRegistry()` instead
 * of using this one (see `blob-acl-registry.test.ts`).
 */
export const sharedBlobAclRegistry = new BlobAclRegistry();

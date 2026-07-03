/**
 * blob ACL e2e coverage: does blob-level access mirror canvas-level ACL?
 *
 * background: `AclFilteringNetworkAdapter` (src/p2p/acl-filtering-network-adapter.ts,
 * proven by acl-enforcement.spec.ts) enforces per-canvas "viewer" read-only
 * access, but it does this by wrapping the automerge-repo `NetworkAdapter`
 * used for CRDT doc sync over the `iroh/automerge-repo/1` ALPN. blob transfer
 * is a **completely separate code path**:
 *
 * - `skein/1` ALPN (handled in JS by src/p2p/skein-handler.ts): proxy_request,
 *   compute_blake3_request, ensure_blob_request. these dispatch off
 *   `stream.peer_node_id()` for *logging only* — none of them check the
 *   caller's identity against anything.
 * - `iroh-blobs/*` ALPN (handled entirely in Rust/WASM inside midden, see
 *   `MiddenNode::accept()` in midden/src/lib.rs): incoming connections on
 *   this ALPN are handed off to `iroh_blobs::BlobsProtocol::accept()` — the
 *   upstream `iroh-blobs` crate's own protocol implementation.
 *
 * **originally found (2026-07-01): there was no access-control check of any
 * kind on blob fetches between two browser peers** — neither canvas-doc ACL
 * (`CanvasStore.getRole()` / `.acl`) nor canvas membership (`.peers`) was
 * consulted anywhere in the fetch path.
 *
 * **fixed the same day**, in two layers:
 * 1. `midden/src/lib.rs`'s `build_gated_blobs_events()` — a real gate on the
 *    `iroh-blobs/*` wire protocol itself, using `iroh_blobs::BlobsProtocol`'s
 *    `EventSender`/`ConnectMode`/`RequestMode::Intercept` extension point to
 *    check each requested hash against a per-hash allow-list
 *    (`MiddenNode::restrict_blob_to_peers()`). proven in isolation (with a
 *    hardcoded allow-list) by `blob-acl-gate-prototype.spec.ts`.
 * 2. `src/canvas/blob-acl-sync.ts`'s `CanvasBlobAclSync` — the real wiring
 *    from canvas ACL data into that gate: watches a `CanvasStore` via its
 *    `onChange()` mechanism and keeps every referenced blob's allow-list in
 *    sync with `.acl` (invite grants access, revocation removes it — modulo
 *    the local-caching caveat documented on `blob-acl-live-sync.spec.ts`,
 *    which is the dedicated end-to-end coverage for this wiring: invite,
 *    role-change, and revoke scenarios all live there, not in this file).
 *    wired into the real app in `standalone/boot.ts` and into this test
 *    fixture's harness (`src/dev/p2p-test-bootstrap.ts`).
 *
 * **`AclFilteringNetworkAdapter` still has zero bearing on this** — it only
 * ever touches the `NetworkAdapter` passed to automerge-repo's `Repo`; blob
 * transfer is a different ALPN, different transport, gated by the two
 * layers above instead.
 *
 * this file keeps the original "invited peer can fetch, uninvited peer
 * cannot" baseline coverage (using the `p2pPage` two-peer fixture directly,
 * simpler setup than `blob-acl-live-sync.spec.ts`'s role-transition
 * coverage) — it no longer documents a gap, it proves the fix holds for
 * the simplest possible case too.
 *
 * tag: @p2p
 * run with: npx playwright test tests/blob-acl.spec.ts --workers=1
 */

import { test, expect } from "./fixtures/p2p-page";
import type { Page } from "@playwright/test";
import { addPeer, getWidgetCount, joinCanvas, waitForPeerCount, waitForWidgetCount } from "./helpers/skein-bridge";
import { fromEvaluateArray, randomBlobBytes, toEvaluateArray } from "./helpers/blob-fixtures";

/**
 * import bytes into `page`'s own iroh-blobs store and create a "file"
 * widget on its canvas referencing them by blake3 hash — mirrors the real
 * upload flow in `widgets/file.ts` (same pattern used by blob-sync.spec.ts
 * against a reliquary hub instead of a second browser peer).
 */
async function importBlobAndCreateFileWidget(
  page: Page,
  bytes: Uint8Array
): Promise<{ blake3: string; widgetDocId: string }> {
  return page.evaluate(async (byteArray: number[]) => {
    const bridge = (window as any).__skeinTest;
    const bytes = Uint8Array.from(byteArray);
    const blake3Hash: string = await bridge.p2p.importBlob(bytes);

    const repo = bridge.canvas.repo;
    const store = bridge.canvas.store;

    const widgetHandle = repo.create();
    widgetHandle.change((doc: any) => {
      doc.blobId = blake3Hash;
      doc.blake3 = blake3Hash;
      doc.domain = "file";
      doc.filename = "blob-acl-test.bin";
      doc.mime = "application/octet-stream";
      doc.size = bytes.byteLength;
      doc.thumbnailDataUrl = "";
    });

    store.addWidget({
      id: crypto.randomUUID(),
      type: "file",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: widgetHandle.documentId,
      parentId: null,
    });

    return { blake3: blake3Hash, widgetDocId: widgetHandle.documentId as string };
  }, toEvaluateArray(bytes));
}

/**
 * fetch a blob directly from `peerNodeId` by hash, retrying a handful of
 * times. a cold first dial between two iroh endpoints can occasionally hit
 * the same relay-discovery lag documented on `IrohNetworkAdapter.openBiWithRetry()`
 * (no equivalent retry exists inside midden's `download_verified_with_ensure`
 * itself) — retrying here is a test-robustness concern, not a workaround for
 * the access-control question this spec is about.
 */
async function fetchBlobWithRetry(
  page: Page,
  peerNodeId: string,
  blake3Hash: string,
  attempts = 4,
  delayMs = 1000
): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.evaluate(
        async ([peerId, hash]) => {
          const bridge = (window as any).__skeinTest;
          const bytes: Uint8Array = await bridge.p2p.fetchBlob(peerId, hash);
          return Array.from(bytes);
        },
        [peerNodeId, blake3Hash] as const
      );
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// baseline: an invited peer really can fetch a blob referenced by the canvas
// ---------------------------------------------------------------------------

test("an invited canvas peer can fetch a blob referenced by a widget on that canvas @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const member = await p2pPage();

  const sourceBytes = randomBlobBytes();
  const { blake3 } = await importBlobAndCreateFileWidget(owner.page, sourceBytes);

  // dial + join the canvas as an invited peer, then get explicitly recorded
  // in the owner's ACL — either "member" or "viewer" counts as "has access"
  // for this test's purposes (see CanvasStore.getRole()'s doc comment).
  await addPeer(member.page, owner.nodeId);
  await waitForPeerCount(member.page, 1, 30_000);

  await owner.page.evaluate((peerId: string) => {
    const store = (window as any).__skeinTest.canvas.store;
    store.addPeer(peerId);
    store.setRole(peerId, "viewer");
  }, member.nodeId);

  const joinedDocId = await joinCanvas(member.page, owner.canvasDocId);
  expect(joinedDocId).toBe(owner.canvasDocId);
  await waitForWidgetCount(member.page, 1, 15_000);

  // fetch the blob using the owner's node id + the hash the widget
  // references. this is the "should work" side of the ACL requirement:
  // an invited peer must be able to fetch blobs referenced from a canvas
  // it has legitimate access to.
  const fetchedBytes = await fetchBlobWithRetry(member.page, owner.nodeId, blake3);
  expect(fromEvaluateArray(fetchedBytes)).toEqual(sourceBytes);
});

// ---------------------------------------------------------------------------
// widget doc sync for an ALREADY-connected peer (as opposed to a peer that
// joins after the widget already exists, which the test above covers via
// joinCanvas() batching up every existing widget at connect time). this is
// the exact shape of a real user-reported bug, 2026-07-03: "user-a creates
// a new audio recording on a canvas, and then as user-b i can see the new
// widget... sometimes two different browser peers don't sync the [widget]
// widget, sometimes it's only on one canvas" — root-caused to a race in
// canvas-scoped-share-policy.ts's per-widget-doc reverse lookup: a widget
// doc's docSynchronizer starts announcing/access-checking itself against
// connected peers essentially the instant it's created, which can race
// ahead of the *separate* canvas-doc sync message that tells a remote peer
// about the new widget's docId in the first place (see CanvasStore's
// constructor comment for the fix, `reevaluateDocumentShare()` on every
// canvas doc change).
// ---------------------------------------------------------------------------

test("a widget added to a canvas AFTER a peer already joined still syncs to that peer @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const member = await p2pPage();

  await addPeer(member.page, owner.nodeId);
  await waitForPeerCount(member.page, 1, 30_000);

  await owner.page.evaluate((peerId: string) => {
    const store = (window as any).__skeinTest.canvas.store;
    store.addPeer(peerId);
    store.setRole(peerId, "viewer");
  }, member.nodeId);

  const joinedDocId = await joinCanvas(member.page, owner.canvasDocId);
  expect(joinedDocId).toBe(owner.canvasDocId);

  // member is fully connected and has joined, but the owner hasn't created
  // any widgets yet — confirms what follows is genuinely "widget added
  // after the fact", not batched up as part of the join itself.
  expect(await getWidgetCount(member.page)).toBe(0);

  const sourceBytes = randomBlobBytes();
  const { blake3 } = await importBlobAndCreateFileWidget(owner.page, sourceBytes);

  // the already-connected member should see the new widget show up on its
  // own, with no reconnect/rejoin — this is the part that used to be
  // flaky/one-sided before the reevaluateDocumentShare() fix.
  await waitForWidgetCount(member.page, 1, 15_000);

  const fetchedBytes = await fetchBlobWithRetry(member.page, owner.nodeId, blake3);
  expect(fromEvaluateArray(fetchedBytes)).toEqual(sourceBytes);
});

// ---------------------------------------------------------------------------
// the fix: a peer with zero canvas access is now denied the same blob
// ---------------------------------------------------------------------------

test("a peer with no canvas access cannot fetch a blob by node id + hash alone @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const stranger = await p2pPage();

  const { blake3 } = await importBlobAndCreateFileWidget(owner.page, randomBlobBytes());

  // confirm the stranger genuinely has no footprint on the owner's canvas
  // doc at all — never invited, never joined, no ACL entry, no peers entry.
  // this is deliberately checked *before* the fetch below, so a future
  // reader can't mistake this for an accidentally-authorized peer.
  const strangerFootprint = await owner.page.evaluate((peerId: string) => {
    const doc = (window as any).__skeinTest.canvas.store.doc();
    return {
      inPeers: !!doc.peers?.[peerId],
      inAcl: !!doc.acl?.[peerId],
    };
  }, stranger.nodeId);
  expect(strangerFootprint).toEqual({ inPeers: false, inAcl: false });

  // the stranger never calls addPeer() (that's the automerge-sync-oriented
  // connection, tracked in IrohNetworkAdapter's intendedPeers/streams) and
  // never calls joinCanvas() — it never touches the canvas doc in any way.
  // all it has is the owner's node id and the blob's blake3 hash, both of
  // which are realistically learnable out-of-band (a pasted link, a log
  // line, a screenshot) independent of ever being invited to the canvas
  // that references the blob — exactly the leak scenario "blob ACL must
  // mirror canvas ACL" exists to guard against. this must now fail: the
  // owner's `CanvasBlobAclSync` restricts `blake3` to just its own `.acl`
  // (itself, since it's the admin) the moment the file widget above is
  // added, and the stranger was never added to it.
  await expect(fetchBlobWithRetry(stranger.page, owner.nodeId, blake3)).rejects.toThrow();
});

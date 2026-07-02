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
 *   this ALPN are hand off straight to `iroh_blobs::BlobsProtocol::accept()`
 *   — the upstream `iroh-blobs` crate's own protocol implementation, which
 *   serves any hash present in the local store to any peer that can open a
 *   connection. this is where the actual blob bytes are transferred
 *   (`download_verified` / `download_verified_with_ensure`); it never goes
 *   through `skein-handler.ts` or any TypeScript code skein owns, and it
 *   never touches automerge-repo's `NetworkAdapter` machinery at all.
 *
 * **finding: there is currently NO access-control check of any kind on blob
 * fetches between two browser peers** — neither canvas-doc ACL
 * (`CanvasStore.getRole()` / `.acl`) nor canvas membership (`.peers`) is
 * consulted anywhere in the fetch path. any peer that knows another peer's
 * iroh node id and a blob's blake3 hash can fetch that blob's bytes, full
 * stop, regardless of whether it has ever been invited to (or even heard
 * of) any canvas referencing that blob.
 *
 * **`AclFilteringNetworkAdapter` has zero bearing on this** — confirmed by
 * reading both the adapter (it only ever touches the `NetworkAdapter` passed
 * to automerge-repo's `Repo`) and midden's raw iroh `Endpoint.accept()` loop
 * (which dispatches `skein/1` and `iroh-blobs/*` connections directly,
 * without ever routing through the `Repo`/`NetworkAdapter` layer the ACL
 * adapter wraps). they are different ALPNs, different transports, and
 * different code entirely.
 *
 * this matches `docs/skein-runtime-plan.md`'s own "blob service and
 * filesystem abstraction" section, which describes a `BlobService` that
 * "checks canvas ACL before serving a fetch" as a **planned, not-yet-built**
 * piece of infrastructure — i.e. this is a known, documented gap, not a
 * surprise. this spec makes it concrete and reproducible with an e2e test
 * (previously: no e2e coverage of blob access control existed at all).
 *
 * tag: @p2p
 * run with: npx playwright test tests/blob-acl.spec.ts --workers=1
 */

import { test, expect } from "./fixtures/p2p-page";
import type { Page } from "@playwright/test";
import { addPeer, joinCanvas, waitForPeerCount, waitForWidgetCount } from "./helpers/skein-bridge";

/**
 * import bytes into `page`'s own iroh-blobs store and create a "file"
 * widget on its canvas referencing them by blake3 hash — mirrors the real
 * upload flow in `widgets/file.ts` (same pattern used by blob-sync.spec.ts
 * against a reliquary hub instead of a second browser peer).
 */
async function importBlobAndCreateFileWidget(
  page: Page,
  content: string
): Promise<{ blake3: string; widgetDocId: string }> {
  return page.evaluate(async (text: string) => {
    const bridge = (window as any).__skeinTest;
    const bytes = new TextEncoder().encode(text);
    const blake3Hash: string = await bridge.p2p.importBlob(bytes);

    const repo = bridge.canvas.repo;
    const store = bridge.canvas.store;

    const widgetHandle = repo.create();
    widgetHandle.change((doc: any) => {
      doc.blobId = blake3Hash;
      doc.blake3 = blake3Hash;
      doc.domain = "file";
      doc.filename = "blob-acl-test.txt";
      doc.mime = "text/plain";
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
  }, content);
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

  const marker = `blob-acl-member ${Date.now()}`;
  const { blake3 } = await importBlobAndCreateFileWidget(owner.page, marker);

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
  expect(new TextDecoder().decode(Uint8Array.from(fetchedBytes))).toBe(marker);
});

// ---------------------------------------------------------------------------
// the gap: a peer with zero canvas access can fetch the same blob anyway
// ---------------------------------------------------------------------------

test("KNOWN GAP: a peer with no canvas access can still fetch a blob by node id + hash alone @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const stranger = await p2pPage();

  const marker = `blob-acl-stranger ${Date.now()}`;
  const { blake3 } = await importBlobAndCreateFileWidget(owner.page, marker);

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
  // mirror canvas ACL" exists to guard against.
  const strangerBytes = await fetchBlobWithRetry(stranger.page, owner.nodeId, blake3);

  // ==========================================================================
  // THIS IS THE GAP. per this file's header comment: blob fetches (skein/1's
  // ensure_blob/compute_blake3 plus the iroh-blobs/* ALPN handled entirely
  // in Rust/WASM by iroh_blobs::BlobsProtocol) have no access-control check
  // of any kind, independent of canvas ACL. `AclFilteringNetworkAdapter`
  // only wraps automerge-repo's doc-sync NetworkAdapter and never runs on
  // this path at all. the assertion below documents the CURRENT (insecure)
  // behavior on purpose — it is expected to PASS today. once a
  // canvas-ACL-aware `BlobService` lands (see docs/skein-runtime-plan.md
  // "blob service and filesystem abstraction"), this test should be
  // rewritten to expect the fetch to reject instead of succeeding.
  // ==========================================================================
  expect(new TextDecoder().decode(Uint8Array.from(strangerBytes))).toBe(marker);
});

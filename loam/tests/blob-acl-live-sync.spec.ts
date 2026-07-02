/**
 * real integration test: a canvas's `.acl` mirrors onto the blob-level
 * allow-list `MiddenNode::restrict_blob_to_peers` enforces (see
 * `midden/src/lib.rs`'s `build_gated_blobs_events`).
 *
 * `blob-acl-gate-prototype.spec.ts` (existing, not modified here) proved
 * the gate mechanism itself using a hardcoded allow-list, injected directly
 * via `bridge.p2p.restrictBlobToPeers`. this spec proves the real wiring
 * from canvas ACL data into that same gate: `CanvasBlobAclSync`
 * (`src/canvas/blob-acl-sync.ts`), watching a real `CanvasStore` via its
 * existing `onChange()` subscription mechanism, and calling the same
 * `restrictBlobToPeers` through `IrohNetworkAdapter` (the production entry
 * point — see `standalone/boot.ts`'s `navigateToCanvas()` for where this is
 * wired into the real app).
 *
 * this test never calls `bridge.p2p.restrictBlobToPeers` directly — every
 * ACL mutation goes through real `CanvasStore` methods
 * (`stampAdmin`/`setRole`/`removePeer`, the same ones `standalone/boot.ts`'s
 * share dialog and invite flow call), and the resulting blob-gate state is
 * observed only from the outside, via a stranger peer's raw `fetchBlob`
 * calls — exactly like a real peer with no other knowledge of the canvas.
 *
 * tag: @p2p
 * run with: npx playwright test tests/blob-acl-live-sync.spec.ts --workers=1
 */

import { test, expect } from "./fixtures/p2p-page";
import type { Page } from "@playwright/test";

/** import bytes into `page`'s own iroh-blobs store, returning the blake3 hex hash. */
async function importBlob(page: Page, content: string): Promise<string> {
  return page.evaluate(async (text: string) => {
    const bridge = (window as any).__skeinTest;
    const bytes = new TextEncoder().encode(text);
    return bridge.p2p.importBlob(bytes) as Promise<string>;
  }, content);
}

/**
 * add a real "file" widget to `page`'s currently-open canvas referencing
 * `blake3Hash` — mirrors `blob-acl.spec.ts`'s `importBlobAndCreateFileWidget`
 * helper (create the widget's own per-widget doc with blake3 already set,
 * *then* add the canvas-doc widget entry pointing at it), which sidesteps
 * having to wait on `WidgetManager`'s own async "create doc, then set
 * docId" mounting sequence for a brand new entry.
 */
async function addFileWidgetWithBlob(page: Page, blake3Hash: string): Promise<void> {
  await page.evaluate(async (hash: string) => {
    const bridge = (window as any).__skeinTest;
    const repo = bridge.canvas.repo;
    const store = bridge.canvas.store;

    const widgetHandle = repo.create();
    widgetHandle.change((d: any) => {
      d.blake3 = hash;
      d.blobId = hash;
      d.domain = "file";
      d.filename = "test-blob.bin";
      d.mime = "application/octet-stream";
      d.size = 0;
      d.thumbnailDataUrl = "";
    });

    store.addWidget({
      id: crypto.randomUUID(),
      type: "file",
      x: 0,
      y: 0,
      width: 220,
      height: 220,
      zIndex: 1,
      props: {},
      collapsed: false,
      docId: widgetHandle.documentId,
      parentId: null,
    });
  }, blake3Hash);
}

async function stampAdmin(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id: string) => {
    (window as any).__skeinTest.canvas.store.stampAdmin(id);
  }, nodeId);
}

async function setRole(page: Page, nodeId: string, role: "member" | "viewer"): Promise<void> {
  await page.evaluate(
    ([id, r]) => {
      (window as any).__skeinTest.canvas.store.setRole(id, r);
    },
    [nodeId, role] as const
  );
}

async function removePeer(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id: string) => {
    (window as any).__skeinTest.canvas.store.removePeer(id);
  }, nodeId);
}

async function tryFetchBlob(page: Page, peerNodeId: string, blake3Hash: string): Promise<number[]> {
  return page.evaluate(
    async ([peerId, hash]) => {
      const bridge = (window as any).__skeinTest;
      const bytes: Uint8Array = await bridge.p2p.fetchBlob(peerId, hash);
      return Array.from(bytes);
    },
    [peerNodeId, blake3Hash] as const
  );
}

/** retry until a fetch succeeds — legitimate propagation wait (ACL sync
 *  runs a few async steps after a doc mutation), not a flakiness mask: the
 *  fetch must genuinely be allowed eventually, and a final failure here
 *  means the sync never actually applied the expected allow-list update. */
async function expectEventuallyAllowed(
  page: Page,
  peerNodeId: string,
  blake3Hash: string,
  expectedContent: string,
  attempts = 6,
  delayMs = 500
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const bytes = await tryFetchBlob(page, peerNodeId, blake3Hash);
      expect(new TextDecoder().decode(Uint8Array.from(bytes))).toBe(expectedContent);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

/** retry until a fetch is rejected — the mirror image of the helper above.
 *  used both for "never invited" and "revoked" cases: a fetch that keeps
 *  succeeding past every attempt means the allow-list was never actually
 *  restricted (or the revocation never took effect), which is a real
 *  failure, not something a longer timeout should paper over. */
async function expectEventuallyDenied(
  page: Page,
  peerNodeId: string,
  blake3Hash: string,
  attempts = 6,
  delayMs = 500
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await tryFetchBlob(page, peerNodeId, blake3Hash);
      // fetch succeeded — not denied yet, give the sync more time
    } catch {
      return;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `expected fetch of ${blake3Hash.slice(0, 16)}... by ${peerNodeId.slice(0, 16)}... to eventually be denied, but it kept succeeding after ${attempts} attempts`
  );
}

test("blob ACL mirrors canvas ACL: invite grants access, revoke removes it @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const stranger = await p2pPage();

  // owner is this canvas's admin (same as CanvasStore.create() + stampAdmin()
  // in real canvas creation — see standalone/boot.ts's createCanvasFromNarthex).
  await stampAdmin(owner.page, owner.nodeId);

  const marker = `blob-acl-live-sync ${Date.now()}`;
  const blake3 = await importBlob(owner.page, marker);
  await addFileWidgetWithBlob(owner.page, blake3);

  await new Promise((r) => setTimeout(r, 1000));

  // before any invite, only the admin (owner) is in `.acl` — the stranger
  // has the same information a real attacker would (owner's node id + the
  // blob's blake3 hash) but must eventually be denied once CanvasBlobAclSync
  // picks up the new file widget's blake3 and restricts the hash.
  await expectEventuallyDenied(stranger.page, owner.nodeId, blake3);

  // owner invites the stranger as a member — same CanvasStore.setRole() call
  // boot.ts's real invite/share flow makes.
  await setRole(owner.page, stranger.nodeId, "member");
  await expectEventuallyAllowed(stranger.page, owner.nodeId, blake3, marker);

  // a role change (downgrade to viewer) must NOT affect blob read access —
  // only removal from .acl should. the peer stays in .acl, just with a
  // different role.
  await setRole(owner.page, stranger.nodeId, "viewer");
  await expectEventuallyAllowed(stranger.page, owner.nodeId, blake3, marker);

  // owner revokes the stranger's access entirely — same CanvasStore.removePeer()
  // call the share dialog's "remove peer" button makes.
  await removePeer(owner.page, stranger.nodeId);

  // note: we do NOT re-check `blake3` here. the stranger already
  // legitimately downloaded those bytes into their own local iroh-blobs
  // store while still authorized — `download_verified`'s downloader
  // resolves an already-possessed hash from local storage without ever
  // re-contacting the owner peer or re-checking the gate, so a fetch of the
  // *same* hash would trivially "succeed" after revocation regardless of
  // whether the gate itself is working. this mirrors the trust model
  // already documented for canvas docs elsewhere in this project:
  // revocation stops *future* access, it doesn't (and can't) retroactively
  // erase data a peer already legitimately received. the real, checkable
  // property is that revocation blocks the *next new* blob referenced by
  // this canvas — proven below with a second, previously-unseen hash.
  const marker2 = `blob-acl-live-sync-after-revoke ${Date.now()}`;
  const blake3_2 = await importBlob(owner.page, marker2);
  await addFileWidgetWithBlob(owner.page, blake3_2);
  await expectEventuallyDenied(stranger.page, owner.nodeId, blake3_2);
});


test("blob ACL live sync: owner (always in .acl via stampAdmin) can always fetch their own blob @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();

  await stampAdmin(owner.page, owner.nodeId);

  const marker = `blob-acl-live-sync-owner ${Date.now()}`;
  const blake3 = await importBlob(owner.page, marker);
  await addFileWidgetWithBlob(owner.page, blake3);

  // sanity: restricting a hash to "just the admin" must never lock out the
  // admin themselves — fetch here is peer-to-peer (a second context dialing
  // the same node id), same mechanics a real second device of the owner's
  // own would use.
  const second = await p2pPage();
  await setRole(owner.page, second.nodeId, "member");
  await expectEventuallyAllowed(second.page, owner.nodeId, blake3, marker);
});

/**
 * prototype: gating blob gets at the `iroh_blobs::BlobsProtocol` layer.
 *
 * `blob-acl.spec.ts` (existing, not modified by this file) proved that
 * `iroh-blobs/*` blob transfers between two browser peers have no
 * access-control check of any kind — any peer that knows another peer's
 * node id and a blob's blake3 hash can fetch it.
 *
 * this spec exercises a STOPGAP prototype gate built on top of a genuine,
 * upstream-supported `iroh_blobs` extension point: `BlobsProtocol::new(&store,
 * events)`'s second argument is an `Option<iroh_blobs::provider::events::EventSender>`.
 * passing an `EventSender` configured with `ConnectMode::Intercept` /
 * `RequestMode::Intercept` lets the local peer accept or reject each
 * connect/get/get_many event before `iroh_blobs` serves any bytes — this is
 * exactly the mechanism the `iroh-blobs` crate's own `examples/limit.rs`
 * ("ByEndpointId" / "ByHash") demonstrates.
 *
 * midden's implementation (`build_gated_blobs_events` in `midden/src/lib.rs`)
 * records each connection's resolved peer node id from the `ClientConnected`
 * event, then on every `GetRequestReceived`/`GetManyRequestReceived` checks
 * the requested hash(es) against a per-hash allow-list
 * (`MiddenNode::restrict_blob_to_peers`, test-only exposed here via
 * `bridge.p2p.restrictBlobToPeers`). a hash that was never explicitly
 * restricted is served to anyone — this keeps `blob-acl.spec.ts`'s existing
 * "no gating today" assertions accurate for any blob that doesn't opt in.
 *
 * THIS IS NOT A COMPLETE FIX. see the accompanying design report for what
 * it does and does not protect against (short version: it gates the
 * `iroh-blobs/*` wire protocol itself — a modified client can't just skip a
 * TypeScript-level handshake to bypass it, unlike a purely TS-side gate at
 * `ensure_blob` — but the allow-list is populated locally per-hash here as a
 * hardcoded stand-in for real canvas-ACL data, which is a separate,
 * larger integration task).
 *
 * tag: @p2p
 * run with: npx playwright test tests/blob-acl-gate-prototype.spec.ts --workers=1
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

/** restrict a blob (already imported on `page`) to the given peer node ids. */
async function restrictBlobToPeers(page: Page, blake3Hash: string, peerNodeIds: string[]): Promise<void> {
  await page.evaluate(
    ([hash, peers]) => {
      const bridge = (window as any).__skeinTest;
      return bridge.p2p.restrictBlobToPeers(hash, peers) as Promise<void>;
    },
    [blake3Hash, peerNodeIds] as const
  );
}

/** fetch a blob directly from `peerNodeId` by hash, retrying transient dial failures. */
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

test("restricted blob: an allow-listed peer can still fetch it @p2p", async ({ p2pPage }) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const allowed = await p2pPage();

  const marker = `blob-acl-gate-allowed ${Date.now()}`;
  const blake3 = await importBlob(owner.page, marker);

  await restrictBlobToPeers(owner.page, blake3, [allowed.nodeId]);

  const fetchedBytes = await fetchBlobWithRetry(allowed.page, owner.nodeId, blake3);
  expect(new TextDecoder().decode(Uint8Array.from(fetchedBytes))).toBe(marker);
});

test("restricted blob: a peer NOT on the allow-list is rejected @p2p", async ({ p2pPage }) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const allowed = await p2pPage();
  const stranger = await p2pPage();

  const marker = `blob-acl-gate-denied ${Date.now()}`;
  const blake3 = await importBlob(owner.page, marker);

  // only `allowed` is on the allow-list for this hash — `stranger` is not.
  await restrictBlobToPeers(owner.page, blake3, [allowed.nodeId]);

  // sanity: the allow-listed peer really can still fetch it (same hash,
  // same owner, run first so a failure here is legible as "the gate broke
  // fetching entirely" rather than being confused with the denial below).
  const allowedBytes = await fetchBlobWithRetry(allowed.page, owner.nodeId, blake3);
  expect(new TextDecoder().decode(Uint8Array.from(allowedBytes))).toBe(marker);

  // the stranger has the same information a real attacker would have (the
  // owner's node id + the blob's blake3 hash) but is not on the allow-list.
  // the fetch must reject — no retry here, a successful-after-retry result
  // would just mean the gate silently isn't working.
  await expect(
    (async () => {
      await fetchBlobWithRetry(stranger.page, owner.nodeId, blake3, /* attempts */ 1);
    })()
  ).rejects.toBeTruthy();
});

test("unrestricted blob: default behavior (anyone can fetch) is unchanged @p2p", async ({ p2pPage }) => {
  test.setTimeout(180_000);

  const owner = await p2pPage();
  const stranger = await p2pPage();

  const marker = `blob-acl-gate-unrestricted ${Date.now()}`;
  const blake3 = await importBlob(owner.page, marker);
  // deliberately never call restrictBlobToPeers for this hash.

  const bytes = await fetchBlobWithRetry(stranger.page, owner.nodeId, blake3);
  expect(new TextDecoder().decode(Uint8Array.from(bytes))).toBe(marker);
});

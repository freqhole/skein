/**
 * outgoing blob-transfer progress e2e coverage: does the newly-added
 * `getActiveTransfers()` (browser/midden peers) and `AdminRequest::ActiveTransfers`
 * (reliquary hub) surface a transfer while it's actually in flight, for
 * every direction the file widget's transfer-progress UI cares about
 * (`p2p/transfer-progress.ts`)?
 *
 * three directions are covered, in priority order (peer<->hub matters more
 * than peer<->peer per this feature's own scoping discussion):
 * 1. hub SERVES a blob to a peer that fetches it directly (`fetchBlob`) —
 *    polls the hub's `AdminRequest::ActiveTransfers` via the existing
 *    generic `bridge.p2p.hubAdminRequest` (needs `adminAllow()` first).
 * 2. hub SNATCHES a blob FROM a peer (mirrors `blob-sync.spec.ts`'s real
 *    snatch flow) — polls the PEER's own `getActiveTransfers()`, now
 *    meaningful since midden's `build_gated_blobs_events` was upgraded from
 *    `RequestMode::Intercept` to `RequestMode::InterceptLog` (see
 *    `tomb/lib/midden/src/transfers.rs`).
 * 3. two browser peers, one serves and one fetches directly — polls the
 *    SERVING peer's own `getActiveTransfers()`.
 *
 * every scenario uses a large-enough random blob
 * (`LARGE_BLOB_SIZE`, well past `blob-fixtures.ts`'s `DEFAULT_RANDOM_BLOB_SIZE`,
 * which "transfers effectively instantly" per that module's own doc
 * comment) so the transfer has a real chance of still being in flight
 * across a handful of ~100ms-spaced polls, instead of completing between
 * two polls and never being observed.
 *
 * tag: @hub for the two hub-involving scenarios, @p2p for the pure
 * browser-to-browser one.
 * run with: npx playwright test tests/transfer-progress.spec.ts --workers=1
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/p2p-page";
import { addPeer, waitForPeerCount } from "./helpers/skein-bridge";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";
import { randomBlobBytes, toEvaluateArray } from "./helpers/blob-fixtures";
import type { AdminRequest, AdminResponse } from "../src/dev/test-bridge";

/** bigger than `blob-fixtures.ts`'s `DEFAULT_RANDOM_BLOB_SIZE` (96 KiB,
 *  which "transfers effectively instantly" over loopback per that module's
 *  own doc comment) — large enough to still be observably in flight across
 *  several 100ms-spaced polls, small enough that passing it through
 *  `page.evaluate()` as a plain `number[]` (see `toEvaluateArray`) stays
 *  reasonably fast. */
const LARGE_BLOB_SIZE = 6 * 1024 * 1024; // 6 MiB

/** poll `pollOnce` every `intervalMs` until it returns true or `timeoutMs`
 *  elapses. returns whether the condition was observed. */
async function pollUntil(
  pollOnce: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pollOnce()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** import bytes into `peer`'s own iroh-blobs store, returning the blake3 hash. */
async function importBlob(peer: Page, bytes: Uint8Array): Promise<string> {
  return peer.evaluate(async (byteArray: number[]) => {
    const bridge = (window as any).__skeinTest;
    return bridge.p2p.importBlob(Uint8Array.from(byteArray));
  }, toEvaluateArray(bytes));
}

/** poll a browser peer's own outgoing `getActiveTransfers()` for an entry
 *  matching `blake3` — see `p2p/iroh-network-adapter.ts`'s `getActiveTransfers`. */
function pollPeerActiveTransfers(peer: Page, blake3: string): () => Promise<boolean> {
  return async () => {
    const transfers: Array<{ blake3: string; bytesSent: number }> = await peer.page.evaluate(async () => {
      const bridge = (window as any).__skeinTest;
      return bridge.p2p.getActiveTransfers();
    });
    return transfers.some((t) => t.blake3 === blake3);
  };
}

/** poll a hub's `AdminRequest::ActiveTransfers` (via the caller's already-
 *  admin-allowed browser peer) for an entry matching `blake3`. */
function pollHubActiveTransfers(caller: Page, hubNodeId: string, blake3: string): () => Promise<boolean> {
  return async () => {
    const response: AdminResponse = await caller.evaluate(
      async ([nodeId, req]) => {
        const bridge = (window as any).__skeinTest;
        return bridge.p2p.hubAdminRequest(nodeId, req);
      },
      [hubNodeId, { kind: "activeTransfers" } as AdminRequest] as const
    );
    return response.kind === "activeTransfers" && response.transfers.some((t) => t.blake3 === blake3);
  };
}

/** path the hub writes a blake3-keyed blob to, mirroring blobz.rs's layout
 *  (same helper as blob-sync.spec.ts). */
function blobPathFor(dataDir: string, blake3: string): string {
  const prefix = blake3.slice(0, 2);
  const rest = blake3.slice(2);
  return join(dataDir, "blob-files", prefix, rest);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`file did not appear within ${timeoutMs}ms: ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** create a "file" widget referencing `blake3`/`size` on `peer`'s canvas,
 *  marking `peer` as the holder — mirrors blob-sync.spec.ts's helper of the
 *  same shape. */
async function createFileWidget(
  peer: Page,
  blake3: string,
  size: number,
  filename: string
): Promise<void> {
  await peer.evaluate(
    async ([hash, byteSize, name]) => {
      const bridge = (window as any).__skeinTest;
      const nodeId: string = await bridge.p2p.getNodeId();
      const repo = bridge.canvas.repo;
      const store = bridge.canvas.store;

      const widgetHandle = repo.create();
      widgetHandle.change((doc: any) => {
        doc.blobId = hash;
        doc.blake3 = hash;
        doc.domain = "file";
        doc.filename = name;
        doc.mime = "application/octet-stream";
        doc.size = byteSize;
        doc.thumbnailDataUrl = "";
        doc.snatchedBy = [nodeId];
      });

      store.addWidget({
        id: crypto.randomUUID(),
        type: "file",
        x: 100,
        y: 100,
        width: 280,
        height: 200,
        zIndex: 1,
        props: {},
        collapsed: false,
        docId: widgetHandle.documentId,
        parentId: null,
      });
      store.addPeer(nodeId);
    },
    [blake3, size, filename] as const
  );
}

async function stampAdminAndShareWithHub(peer: Page, hubNodeId: string): Promise<void> {
  await peer.evaluate(
    async ([nodeId]) => {
      const bridge = (window as any).__skeinTest;
      const store = bridge.canvas.store;
      const ownNodeId: string = await bridge.p2p.getNodeId();
      store.stampAdmin(ownNodeId);
      store.setRole(nodeId, "member");
    },
    [hubNodeId] as const
  );
}

// ---------------------------------------------------------------------------
// 1. hub serves a blob to a peer that fetches it directly — polls the
//    hub's ActiveTransfers admin query.
// ---------------------------------------------------------------------------

test.describe("outgoing transfer progress: hub -> peer @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("a peer downloading a blob directly from a hub shows up in the hub's ActiveTransfers query @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(120_000);

    hub = await startReliquaryHub();
    const peer = await p2pPage();

    // the polling caller needs to be a hub admin to read ActiveTransfers.
    await hub.adminAllow(peer.nodeId);
    await addPeer(peer.page, hub.nodeId);
    await waitForPeerCount(peer.page, 1, 30_000);

    // import the blob into a first peer's own store, then let the hub
    // snatch it (exactly like blob-sync.spec.ts) so the hub ends up
    // genuinely holding the bytes — simplest way to get real content onto
    // the hub without a separate CLI-import code path just for this test.
    const sourceBytes = randomBlobBytes(LARGE_BLOB_SIZE);
    const blake3 = await importBlob(peer.page, sourceBytes);

    await stampAdminAndShareWithHub(peer.page, hub.nodeId);
    await createFileWidget(peer.page, blake3, sourceBytes.byteLength, "hub-serve-test.bin");

    const blobPath = blobPathFor(hub.dataDir, blake3);
    try {
      await waitForFile(blobPath, 60_000);
    } catch (err) {
      // eslint-disable-next-line no-console -- debug aid on failure
      console.log("=== hub log on failure ===\n", hub.getLog());
      throw err;
    }
    // hub now holds the blob (snatched from `peer`) — confirm byte-for-byte.
    const written = readFileSync(blobPath);
    expect(written.equals(Buffer.from(sourceBytes))).toBe(true);

    // now the real subject of this test: a SECOND peer fetches the same
    // blob directly FROM the hub, while we poll the hub's ActiveTransfers.
    const downloader = await p2pPage();
    await hub.adminAllow(downloader.nodeId);
    await addPeer(downloader.page, hub.nodeId);
    await waitForPeerCount(downloader.page, 1, 30_000);

    const fetchPromise = downloader.page.evaluate(
      async ([nodeId, hash]) => {
        const bridge = (window as any).__skeinTest;
        const bytes: Uint8Array = await bridge.p2p.fetchBlob(nodeId, hash);
        return Array.from(bytes);
      },
      [hub.nodeId, blake3] as const
    );

    const sawTransfer = await pollUntil(pollHubActiveTransfers(peer.page, hub.nodeId, blake3), 30_000, 150);

    const fetchedBytes = await fetchPromise;
    expect(Uint8Array.from(fetchedBytes)).toEqual(sourceBytes);
    expect(sawTransfer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. hub snatches a blob FROM a peer — polls the peer's own
//    getActiveTransfers() (mirrors blob-sync.spec.ts's snatch flow).
// ---------------------------------------------------------------------------

test.describe("outgoing transfer progress: peer -> hub (snatch) @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("a hub snatching a blob from a peer shows up in that peer's own getActiveTransfers() @hub", async ({
    p2pPage,
  }) => {
    test.setTimeout(120_000);

    hub = await startReliquaryHub();
    const peer = await p2pPage();

    await hub.friendAllow(peer.nodeId);
    await addPeer(peer.page, hub.nodeId);
    await waitForPeerCount(peer.page, 1, 30_000);

    await stampAdminAndShareWithHub(peer.page, hub.nodeId);

    const sourceBytes = randomBlobBytes(LARGE_BLOB_SIZE);
    const blake3 = await importBlob(peer.page, sourceBytes);
    await createFileWidget(peer.page, blake3, sourceBytes.byteLength, "snatch-progress-test.bin");

    const blobPath = blobPathFor(hub.dataDir, blake3);

    const sawTransfer = await pollUntil(pollPeerActiveTransfers(peer, blake3), 60_000, 150);

    try {
      await waitForFile(blobPath, 60_000);
    } catch (err) {
      // eslint-disable-next-line no-console -- debug aid on failure
      console.log("=== hub log on failure ===\n", hub.getLog());
      throw err;
    }

    const written = readFileSync(blobPath);
    expect(written.equals(Buffer.from(sourceBytes))).toBe(true);
    expect(sawTransfer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. two browser peers, one serves and one fetches directly — polls the
//    serving peer's own getActiveTransfers().
// ---------------------------------------------------------------------------

test("a browser peer serving a blob to another browser peer shows up in its own getActiveTransfers() @p2p", async ({
  p2pPage,
}) => {
  test.setTimeout(120_000);

  const server = await p2pPage();
  const downloader = await p2pPage();

  await addPeer(downloader.page, server.nodeId);
  await waitForPeerCount(downloader.page, 1, 30_000);

  await server.page.evaluate((peerId: string) => {
    const store = (window as any).__skeinTest.canvas.store;
    store.addPeer(peerId);
    store.setRole(peerId, "viewer");
  }, downloader.nodeId);

  const sourceBytes = randomBlobBytes(LARGE_BLOB_SIZE);
  const blake3 = await importBlob(server.page, sourceBytes);

  const fetchPromise = downloader.page.evaluate(
    async ([nodeId, hash]) => {
      const bridge = (window as any).__skeinTest;
      const bytes: Uint8Array = await bridge.p2p.fetchBlob(nodeId, hash);
      return Array.from(bytes);
    },
    [server.nodeId, blake3] as const
  );

  const sawTransfer = await pollUntil(pollPeerActiveTransfers(server, blake3), 30_000, 100);

  const fetchedBytes = await fetchPromise;
  expect(Uint8Array.from(fetchedBytes)).toEqual(sourceBytes);
  expect(sawTransfer).toBe(true);
});

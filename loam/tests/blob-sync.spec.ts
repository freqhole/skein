/**
 * real cross-peer blob transfer: browser peer -> reliquary hub.
 *
 * spins up a real `reliquary serve` process (same fixture as
 * `reliquary-hub.spec.ts`) and one real-iroh browser peer. the peer creates
 * a canvas with a "file" widget referencing a blob it has imported into its
 * own midden iroh-blobs store (mirroring what `widgets/file.ts` does on
 * upload), then connects to the hub. once the canvas + widget docs sync to
 * the hub over `iroh/automerge-repo/1`, the hub's `BlobSnatcher`
 * (reliquary/src/snatch.rs) should notice the file widget, probe the
 * browser peer over `skein/1` (`ensure_blob_request`), download the blob
 * via iroh-blobs verified transfer, and write it into its own blobz store.
 *
 * this is the first e2e coverage of the full blob snatch pipeline between
 * two real peers — `blob-worker.test.ts` only exercises the browser-side
 * worker in isolation (hashing/OPFS), and `reliquary-hub.spec.ts` only
 * covers transport-level connectivity, not doc sync or blob transfer.
 *
 * tag: @hub
 * run with: npx playwright test tests/blob-sync.spec.ts --workers=1
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/p2p-page";
import { addPeer, waitForPeerCount } from "./helpers/skein-bridge";
import { startReliquaryHub, type ReliquaryHubHandle } from "./helpers/reliquary-hub";

/** path the hub writes a blake3-keyed blob to, mirroring blobz.rs's layout. */
function blobPathFor(dataDir: string, blake3: string): string {
  const prefix = blake3.slice(0, 2);
  const rest = blake3.slice(2);
  return join(dataDir, "blob-files", prefix, rest);
}

/** poll until a file exists (or timeoutMs elapses). */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`file did not appear within ${timeoutMs}ms: ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.describe("cross-peer blob snatch @hub", () => {
  let hub: ReliquaryHubHandle | undefined;

  test.afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  test("hub snatches a blob referenced by a peer's file widget @hub", async ({ p2pPage }) => {
    test.setTimeout(120_000);

    hub = await startReliquaryHub();
    const peer = await p2pPage();
    peer.page.on("console", (msg) => {
      if (
        msg.text().includes("file-widget") ||
        msg.text().includes("skein.handler") ||
        msg.text().includes("test-debug")
      ) {
        // eslint-disable-next-line no-console -- temporary debug aid
        console.log("[browser]", msg.text());
      }
    });

    await hub.friendAllow(peer.nodeId);
    await addPeer(peer.page, hub.nodeId);
    await waitForPeerCount(peer.page, 1, 30_000);

    // stamp the browser peer as this canvas's admin (matching real canvas
    // creation, see CanvasStore.create() + stampAdmin() in
    // standalone/boot.ts's createCanvasFromNarthex()) and grant the hub a
    // canvas role too, matching the real "share this canvas with a
    // reliquary hub peer" flow (see ROADMAP.md's north-star scenario step
    // 2: sharing with a hub goes through the same admin/member/viewer ACL
    // as sharing with a friend). without this, `.acl` stays empty and
    // `CanvasBlobAclSync` (wired into this test's harness via
    // `p2p-test-bootstrap.ts`) restricts every blob to an empty allow-list
    // — denying even the hub itself, not just uninvited strangers.
    await peer.page.evaluate(
      async ([hubNodeId]) => {
        const bridge = (window as any).__skeinTest;
        const store = bridge.canvas.store;
        const ownNodeId: string = await bridge.p2p.getNodeId();
        store.stampAdmin(ownNodeId);
        store.setRole(hubNodeId, "member");
      },
      [hub.nodeId] as const
    );

    const marker = `blob-sync-spec ${Date.now()}`;

    const { blake3, size } = await peer.page.evaluate(async (content: string) => {
      const bridge = (window as any).__skeinTest;
      const bytes = new TextEncoder().encode(content);

      // register the bytes with this peer's own iroh-blobs store AND its
      // local blob record — mirrors what widgets/file.ts does on upload
      // (see importBlob()'s doc comment in test-bridge.ts for why both
      // matter: the file widget's own locality check only looks at the
      // local blob record, not midden's in-memory iroh-blobs store).
      const blake3Hash: string = await bridge.p2p.importBlob(bytes, {
        filename: "blob-sync-test.txt",
        mime: "text/plain",
      });
      const nodeId: string = await bridge.p2p.getNodeId();

      const repo = bridge.canvas.repo;
      const store = bridge.canvas.store;

      // widget state doc — the fields reliquary's snatch.rs reads directly
      // off the automerge doc root (see read_widget_state in snatch.rs).
      const widgetHandle = repo.create();
      widgetHandle.change((doc: any) => {
        doc.blobId = blake3Hash;
        doc.blake3 = blake3Hash;
        doc.domain = "file";
        doc.filename = "blob-sync-test.txt";
        doc.mime = "text/plain";
        doc.size = bytes.byteLength;
        doc.thumbnailDataUrl = "";
        // mark ourselves as having the blob — the hub only probes peers
        // listed here (or in its own peer-blob-inventory gossip cache,
        // which is unpopulated in this test), see snatch_blob() in
        // snatch.rs.
        doc.snatchedBy = [nodeId];
      });

      // eslint-disable-next-line no-console -- temporary debug aid
      console.log(
        "[test-debug] widgetHandle.doc() after change:",
        JSON.stringify(widgetHandle.doc())
      );

      // canvas doc: register the file widget entry + ourselves as a canvas
      // peer (so the hub's canvas scan has someone to probe).
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

      return { blake3: blake3Hash, size: bytes.byteLength };
    }, marker);

    expect(blake3).toMatch(/^[0-9a-f]{64}$/);

    const blobPath = blobPathFor(hub.dataDir, blake3);
    try {
      await waitForFile(blobPath, 60_000);
    } catch (err) {
      // eslint-disable-next-line no-console -- temporary debug aid, see session notes
      console.log("=== hub log on failure ===\n", hub.getLog());
      throw err;
    }

    const written = readFileSync(blobPath);
    expect(written.byteLength).toBe(size);
    expect(written.toString("utf8")).toBe(marker);
  });
});

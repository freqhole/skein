import { describe, expect, it, vi } from "vitest";
import { createTestRepo, waitFor } from "../test-helpers/automerge-helpers";
import { CanvasStore } from "./canvas-store";
import { CanvasBlobAclSync } from "./blob-acl-sync";
import { BlobAclRegistry } from "./blob-acl-registry";

/** create a fresh per-widget doc carrying `blake3` and register it as a
 *  "file" widget on `store` — same shape the real `widgets/file.ts` upload
 *  flow and this repo's e2e blob-acl specs use. */
function addFileWidget(store: CanvasStore, blake3: string): string {
  const widgetHandle = store.repo.create<{ blake3?: string }>();
  widgetHandle.change((d) => {
    d.blake3 = blake3;
  });
  const id = crypto.randomUUID();
  store.addWidget({
    id,
    type: "file",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 1,
    props: {},
    collapsed: false,
    docId: widgetHandle.documentId,
    parentId: null,
  });
  return id;
}

/** capture every `restrictBlobToPeers` call, most recent last. */
function captureRestrictCalls(): {
  fn: (hash: string, peers: string[]) => Promise<void>;
  calls: Array<{ hash: string; peers: string[] }>;
} {
  const calls: Array<{ hash: string; peers: string[] }> = [];
  const fn = vi.fn(async (hash: string, peers: string[]) => {
    calls.push({ hash, peers: [...peers] });
  });
  return { fn, calls };
}

describe("CanvasBlobAclSync — cross-canvas union (the fix for restrict_blob_to_peers' replace-not-add semantics)", () => {
  it("a second canvas referencing the same blob unions its peers with the first canvas's, even after the first canvas has been closed (destroy()'d)", async () => {
    const repo = createTestRepo();
    const registry = new BlobAclRegistry();
    const { fn: restrictBlobToPeers, calls } = captureRestrictCalls();

    const canvasA = CanvasStore.create(repo);
    canvasA.setLocalNodeId("owner");
    canvasA.stampAdmin("owner");
    canvasA.setRole("x", "member");
    canvasA.setRole("y", "member");
    addFileWidget(canvasA, "hash1");

    const syncA = new CanvasBlobAclSync(canvasA, repo, restrictBlobToPeers, registry);
    syncA.start();

    await waitFor(() => registry.unionForHash("hash1").length === 3);
    expect(registry.unionForHash("hash1").sort()).toEqual(["owner", "x", "y"]);

    // canvas A is navigated away from — its CanvasBlobAclSync is destroyed,
    // exactly like `standalone/boot.ts`'s destroyCurrent() does. its
    // contribution must survive this.
    syncA.destroy();
    expect(registry.unionForHash("hash1").sort()).toEqual(["owner", "x", "y"]);

    const canvasB = CanvasStore.create(repo);
    canvasB.setLocalNodeId("owner");
    canvasB.stampAdmin("owner");
    canvasB.setRole("z", "member");
    addFileWidget(canvasB, "hash1"); // same blob, different canvas, different peer set

    const syncB = new CanvasBlobAclSync(canvasB, repo, restrictBlobToPeers, registry);
    syncB.start();

    await waitFor(() => {
      const last = calls.at(-1);
      return !!last && last.hash === "hash1" && last.peers.length === 4;
    });

    // the crucial assertion: the allow-list pushed while B is open still
    // includes A's peers (x, y) — the whole point of this fix. without it,
    // this would be just ["owner", "z"].
    const last = calls.at(-1)!;
    expect(last.peers.sort()).toEqual(["owner", "x", "y", "z"]);
  });

  it("revocation still works: removing a peer from the currently-open canvas's ACL drops them from the union", async () => {
    const repo = createTestRepo();
    const registry = new BlobAclRegistry();
    const { fn: restrictBlobToPeers, calls } = captureRestrictCalls();

    const canvas = CanvasStore.create(repo);
    canvas.setLocalNodeId("owner");
    canvas.stampAdmin("owner");
    canvas.setRole("x", "member");
    addFileWidget(canvas, "hash1");

    const sync = new CanvasBlobAclSync(canvas, repo, restrictBlobToPeers, registry);
    sync.start();

    await waitFor(() => registry.unionForHash("hash1").includes("x"));

    canvas.removePeer("x");

    await waitFor(() => {
      const last = calls.at(-1);
      return !!last && !last.peers.includes("x");
    });
    expect(calls.at(-1)!.peers.sort()).toEqual(["owner"]);
  });

  it("a soft-deleted canvas stops contributing its peers to the union", async () => {
    const repo = createTestRepo();
    const registry = new BlobAclRegistry();
    const { fn: restrictBlobToPeers, calls } = captureRestrictCalls();

    const canvas = CanvasStore.create(repo);
    canvas.setLocalNodeId("owner");
    canvas.stampAdmin("owner");
    canvas.setRole("x", "member");
    addFileWidget(canvas, "hash1");

    const sync = new CanvasBlobAclSync(canvas, repo, restrictBlobToPeers, registry);
    sync.start();

    await waitFor(() => registry.unionForHash("hash1").length === 2);

    canvas.deleteCanvas("soft");

    await waitFor(() => registry.unionForHash("hash1").length === 0);
    expect(calls.at(-1)!.peers).toEqual([]);
  });

  it("a device removed from a canvas's ACL (while other peers remain) stops vouching for that canvas's peers", async () => {
    const repo = createTestRepo();
    const registry = new BlobAclRegistry();
    const { fn: restrictBlobToPeers, calls } = captureRestrictCalls();

    const canvas = CanvasStore.create(repo);
    // "admin" owns the canvas; "memberX" is this device's own local node,
    // a regular member who also happens to be serving this blob locally.
    canvas.stampAdmin("admin");
    canvas.setRole("memberX", "member");
    canvas.setRole("memberY", "member");
    canvas.setLocalNodeId("memberX");
    addFileWidget(canvas, "hash1");

    const sync = new CanvasBlobAclSync(canvas, repo, restrictBlobToPeers, registry);
    sync.start();

    await waitFor(() => registry.unionForHash("hash1").length === 3);
    expect(registry.unionForHash("hash1").sort()).toEqual(["admin", "memberX", "memberY"]);

    // this device (memberX) is removed from the canvas entirely — admin
    // and memberY remain.
    canvas.removePeer("memberX");

    await waitFor(() => registry.unionForHash("hash1").length === 0);
    expect(calls.at(-1)!.peers).toEqual([]);
  });

  it("a canvas with no ACL data at all still contributes normally (not mistaken for a removal)", async () => {
    const repo = createTestRepo();
    const registry = new BlobAclRegistry();
    const { fn: restrictBlobToPeers, calls } = captureRestrictCalls();

    // legacy/test-fixture-style canvas: never called stampAdmin()/setRole(),
    // so .acl stays undefined/empty — same precedent as several older p2p
    // test fixtures in this repo (see skein-testing-notes.md).
    const canvas = CanvasStore.create(repo);
    canvas.setLocalNodeId("owner");
    addFileWidget(canvas, "hash1");

    const sync = new CanvasBlobAclSync(canvas, repo, restrictBlobToPeers, registry);
    sync.start();

    await waitFor(() => calls.length > 0);
    // empty .acl means an empty peer list, same as pre-fix behavior — the
    // point of this test is that this does NOT throw/skip differently than
    // the "genuinely removed" case above; it's exercised the same code path.
    expect(calls.at(-1)!.peers).toEqual([]);
  });

  it("removing the last widget referencing a blob drops that canvas's contribution for it", async () => {
    const repo = createTestRepo();
    const registry = new BlobAclRegistry();
    const { fn: restrictBlobToPeers } = captureRestrictCalls();

    const canvas = CanvasStore.create(repo);
    canvas.setLocalNodeId("owner");
    canvas.stampAdmin("owner");
    canvas.setRole("x", "member");
    const widgetId = addFileWidget(canvas, "hash1");

    const sync = new CanvasBlobAclSync(canvas, repo, restrictBlobToPeers, registry);
    sync.start();

    await waitFor(() => registry.unionForHash("hash1").length === 2);

    canvas.removeWidget(widgetId);

    await waitFor(() => registry.unionForHash("hash1").length === 0);
  });
});

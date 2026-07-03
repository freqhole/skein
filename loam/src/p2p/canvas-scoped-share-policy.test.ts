// ---------------------------------------------------------------------------
// unit tests for createCanvasScopedSharePolicy()
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { createCanvasScopedSharePolicy } from "./canvas-scoped-share-policy";
import type { PeerId } from "@automerge/automerge-repo";

const PEER = "peer-node-id" as PeerId;
const STRANGER = "some-other-node-id" as PeerId;

const noFriends = (): boolean => false;
const onlyFriend =
  (friendId: string) =>
  (nodeId: string): boolean =>
    nodeId === friendId;

describe("createCanvasScopedSharePolicy", () => {
  it("denies a document with no .acl and no ownerCanvasId (narthex/social/messagez-shaped docs)", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ widgets: Record<string, unknown> }>({ widgets: {} });
    await handle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, noFriends);
    expect(await policy(PEER, handle.documentId)).toBe(false);
  });

  it("denies a document with no .acl/ownerCanvasId even for a friend — no fallback for this bucket", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ widgets: Record<string, unknown> }>({ widgets: {} });
    await handle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, onlyFriend(PEER));
    expect(await policy(PEER, handle.documentId)).toBe(false);
  });

  it("denies a canvas-shaped doc (.acl present) when the peer has no entry in it, even if they're a friend", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ acl: Record<string, { role: string }>; widgets: Record<string, unknown> }>({
      acl: { "local-admin": { role: "admin" } },
      widgets: {},
    });
    await handle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, onlyFriend(PEER));
    expect(await policy(PEER, handle.documentId)).toBe(false);
  });

  it("allows a canvas-shaped doc when the peer has any role in its .acl", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ acl: Record<string, { role: string }>; widgets: Record<string, unknown> }>({
      acl: { "local-admin": { role: "admin" }, [PEER]: { role: "member" } },
      widgets: {},
    });
    await handle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, noFriends);
    expect(await policy(PEER, handle.documentId)).toBe(true);
    // a peer NOT in the acl still gets denied, even though someone else does.
    expect(await policy(STRANGER, handle.documentId)).toBe(false);
  });

  it("allows a viewer-role entry too (any recorded role counts, role gating is a separate concern)", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ acl: Record<string, { role: string }>; widgets: Record<string, unknown> }>({
      acl: { [PEER]: { role: "viewer" } },
      widgets: {},
    });
    await handle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, noFriends);
    expect(await policy(PEER, handle.documentId)).toBe(true);
  });

  it("denies an unknown document id the repo has never seen", async () => {
    const repo = createTestRepo();
    const policy = createCanvasScopedSharePolicy(repo, onlyFriend(PEER));
    expect(await policy(PEER, "totally-unknown-doc-id" as any)).toBe(false);
  });

  it("denies when documentId is undefined", async () => {
    const repo = createTestRepo();
    const policy = createCanvasScopedSharePolicy(repo, onlyFriend(PEER));
    expect(await policy(PEER, undefined)).toBe(false);
  });

  it("resolves a per-widget state doc (ownerCanvasId, no .acl of its own) via its owning canvas's .acl", async () => {
    const repo = createTestRepo();

    const canvasHandle = repo.create<{ acl: Record<string, { role: string }> }>({
      acl: { [PEER]: { role: "member" } },
    });
    await canvasHandle.whenReady();

    const widgetHandle = repo.create<{ blake3: string; ownerCanvasId: string }>({
      blake3: "abc123",
      ownerCanvasId: canvasHandle.documentId,
    });
    await widgetHandle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, noFriends);
    expect(await policy(PEER, widgetHandle.documentId)).toBe(true);
    expect(await policy(STRANGER, widgetHandle.documentId)).toBe(false);
  });

  it("denies a per-widget state doc whose owning canvas denies the peer, even as a friend", async () => {
    const repo = createTestRepo();

    const canvasHandle = repo.create<{ acl: Record<string, { role: string }> }>({
      acl: { "local-admin": { role: "admin" } },
    });
    await canvasHandle.whenReady();

    const widgetHandle = repo.create<{ blake3: string; ownerCanvasId: string }>({
      blake3: "abc123",
      ownerCanvasId: canvasHandle.documentId,
    });
    await widgetHandle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, onlyFriend(PEER));
    expect(await policy(PEER, widgetHandle.documentId)).toBe(false);
  });

  it("falls back to the friend-gate for a widget doc whose owning canvas isn't locally resolvable yet", async () => {
    const repo = createTestRepo();

    // ownerCanvasId points at a doc id the repo has never actually seen
    // locally (e.g. the canvas doc's own sync hasn't arrived yet) — this is
    // the exact scenario rule 2's friend-gate floor exists for.
    const widgetHandle = repo.create<{ blake3: string; ownerCanvasId: string }>({
      blake3: "abc123",
      ownerCanvasId: "2xNotYetKnownCanvasDocId000000",
    });
    await widgetHandle.whenReady();

    const friendPolicy = createCanvasScopedSharePolicy(repo, onlyFriend(PEER));
    expect(await friendPolicy(PEER, widgetHandle.documentId)).toBe(true);
    expect(await friendPolicy(STRANGER, widgetHandle.documentId)).toBe(false);

    const noFriendPolicy = createCanvasScopedSharePolicy(repo, noFriends);
    expect(await noFriendPolicy(PEER, widgetHandle.documentId)).toBe(false);
  });

  it("denies a widget doc with no ownerCanvasId at all (legacy doc, pre-migration) even for a friend", async () => {
    const repo = createTestRepo();
    const widgetHandle = repo.create<{ blake3: string }>({ blake3: "abc123" });
    await widgetHandle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, onlyFriend(PEER));
    expect(await policy(PEER, widgetHandle.documentId)).toBe(false);
  });
});


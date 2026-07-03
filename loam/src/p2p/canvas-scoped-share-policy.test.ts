// ---------------------------------------------------------------------------
// unit tests for createCanvasScopedSharePolicy()
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { createCanvasScopedSharePolicy } from "./canvas-scoped-share-policy";
import type { PeerId } from "@automerge/automerge-repo";

const PEER = "peer-node-id" as PeerId;
const STRANGER = "some-other-node-id" as PeerId;

describe("createCanvasScopedSharePolicy", () => {
  it("denies a document with no .acl field at all (narthex/social/messagez-shaped docs)", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ widgets: Record<string, unknown> }>({ widgets: {} });
    await handle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo);
    expect(await policy(PEER, handle.documentId)).toBe(false);
  });

  it("denies a canvas-shaped doc (.acl present) when the peer has no entry in it", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ acl: Record<string, { role: string }>; widgets: Record<string, unknown> }>({
      acl: { "local-admin": { role: "admin" } },
      widgets: {},
    });
    await handle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo);
    expect(await policy(PEER, handle.documentId)).toBe(false);
  });

  it("allows a canvas-shaped doc when the peer has any role in its .acl", async () => {
    const repo = createTestRepo();
    const handle = repo.create<{ acl: Record<string, { role: string }>; widgets: Record<string, unknown> }>({
      acl: { "local-admin": { role: "admin" }, [PEER]: { role: "member" } },
      widgets: {},
    });
    await handle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo);
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

    const policy = createCanvasScopedSharePolicy(repo);
    expect(await policy(PEER, handle.documentId)).toBe(true);
  });

  it("denies an unknown document id the repo has never seen", async () => {
    const repo = createTestRepo();
    const policy = createCanvasScopedSharePolicy(repo);
    expect(await policy(PEER, "totally-unknown-doc-id" as any)).toBe(false);
  });

  it("denies when documentId is undefined", async () => {
    const repo = createTestRepo();
    const policy = createCanvasScopedSharePolicy(repo);
    expect(await policy(PEER, undefined)).toBe(false);
  });

  it("resolves a per-widget state doc (no .acl of its own) via its owning canvas's .acl", async () => {
    const repo = createTestRepo();

    const widgetHandle = repo.create<{ blake3: string }>({ blake3: "abc123" });
    await widgetHandle.whenReady();

    const canvasHandle = repo.create<{
      acl: Record<string, { role: string }>;
      widgets: Record<string, { docId: string }>;
    }>({
      acl: { [PEER]: { role: "member" } },
      widgets: { "widget-1": { docId: widgetHandle.documentId } },
    });
    await canvasHandle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo);
    expect(await policy(PEER, widgetHandle.documentId)).toBe(true);
    expect(await policy(STRANGER, widgetHandle.documentId)).toBe(false);
  });

  it("denies a per-widget state doc whose owning canvas denies the peer", async () => {
    const repo = createTestRepo();

    const widgetHandle = repo.create<{ blake3: string }>({ blake3: "abc123" });
    await widgetHandle.whenReady();

    const canvasHandle = repo.create<{
      acl: Record<string, { role: string }>;
      widgets: Record<string, { docId: string }>;
    }>({
      acl: { "local-admin": { role: "admin" } },
      widgets: { "widget-1": { docId: widgetHandle.documentId } },
    });
    await canvasHandle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo);
    expect(await policy(PEER, widgetHandle.documentId)).toBe(false);
  });

  it("denies a widget doc with no locally-known owning canvas at all (orphaned/not-yet-loaded)", async () => {
    const repo = createTestRepo();
    const widgetHandle = repo.create<{ blake3: string }>({ blake3: "abc123" });
    await widgetHandle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo);
    expect(await policy(PEER, widgetHandle.documentId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unit tests for backfillOwnerCanvasId()
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { createTestRepo } from "../test-helpers/automerge-helpers";
import { createCanvasScopedSharePolicy } from "../p2p/canvas-scoped-share-policy";
import type { PeerId } from "@automerge/automerge-repo";
import { backfillOwnerCanvasId } from "./widget-manager";

const PEER = "peer-node-id" as PeerId;

describe("backfillOwnerCanvasId", () => {
  it("stamps ownerCanvasId onto a widget doc that predates the stamping mechanism", async () => {
    const repo = createTestRepo();
    const canvasHandle = repo.create<{ acl: Record<string, { role: string }> }>({ acl: {} });
    await canvasHandle.whenReady();

    // simulate a legacy per-widget doc created before ownerCanvasId existed.
    const widgetHandle = repo.create<{ blake3: string }>({ blake3: "abc123" });
    await widgetHandle.whenReady();
    expect(widgetHandle.doc()).not.toHaveProperty("ownerCanvasId");

    backfillOwnerCanvasId(widgetHandle, canvasHandle.documentId);

    expect((widgetHandle.doc() as { ownerCanvasId?: string }).ownerCanvasId).toBe(
      canvasHandle.documentId
    );
  });

  it("is a no-op when ownerCanvasId is already present", async () => {
    const repo = createTestRepo();
    const canvasHandle = repo.create<{ acl: Record<string, { role: string }> }>({ acl: {} });
    await canvasHandle.whenReady();

    const otherCanvasHandle = repo.create<{ acl: Record<string, { role: string }> }>({ acl: {} });
    await otherCanvasHandle.whenReady();

    const widgetHandle = repo.create<{ blake3: string; ownerCanvasId: string }>({
      blake3: "abc123",
      ownerCanvasId: otherCanvasHandle.documentId,
    });
    await widgetHandle.whenReady();

    backfillOwnerCanvasId(widgetHandle, canvasHandle.documentId);

    // untouched — does not overwrite an existing (correct) value.
    expect((widgetHandle.doc() as { ownerCanvasId: string }).ownerCanvasId).toBe(
      otherCanvasHandle.documentId
    );
  });

  it("fixes a legacy widget doc's sync eligibility under canvas-scoped-share-policy.ts", async () => {
    // reproduces the real regression: a per-widget doc created before
    // ownerCanvasId stamping existed permanently fails rule 3 ("ready, no
    // .acl, no ownerCanvasId — denied, no fallback") and can never sync to
    // a peer who doesn't already have it — until this backfill runs.
    const repo = createTestRepo();
    const canvasHandle = repo.create<{ acl: Record<string, { role: string }> }>({
      acl: { [PEER]: { role: "member" } },
    });
    await canvasHandle.whenReady();

    const widgetHandle = repo.create<{ blake3: string }>({ blake3: "abc123" });
    await widgetHandle.whenReady();

    const policy = createCanvasScopedSharePolicy(repo, () => false);
    expect(await policy(PEER, widgetHandle.documentId)).toBe(false);

    backfillOwnerCanvasId(widgetHandle, canvasHandle.documentId);

    expect(await policy(PEER, widgetHandle.documentId)).toBe(true);
  });
});

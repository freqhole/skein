/**
 * lightweight test bootstrap for background sync peers.
 *
 * loads no PixiJS — just an automerge Repo + BroadcastChannelNetworkAdapter
 * + CanvasStore. used by multi-peer tests where background peers only need
 * to observe or mutate automerge state; they don't need a rendered canvas.
 *
 * exposes the same window.__skein.store interface as the full bootstrap so
 * existing test helpers and assertions work without modification.
 */

import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import type { DocumentId } from "@automerge/automerge-repo";
import { CanvasStore } from "../canvas/canvas-store";

interface SyncTestInitOptions {
  canvasDocId?: string | null;
}

interface SyncTestInitResult {
  canvasDocId: string;
}

async function initSkeinForTest(options: SyncTestInitOptions = {}): Promise<SyncTestInitResult> {
  const repo = new Repo({
    network: [new BroadcastChannelNetworkAdapter()],
    // intentionally no storage adapter — the sync-only repo is ephemeral.
    // the doc is always fetched from the primary peer via BroadcastChannel.
    // this avoids IndexedDB write-lock contention with the primary peer's repo.
  });

  let store: CanvasStore;
  if (options.canvasDocId) {
    store = await CanvasStore.open(repo, options.canvasDocId as DocumentId);
  } else {
    store = CanvasStore.create(repo);
  }

  // expose the same window.__skein interface so test assertions work identically
  // to the full canvas bootstrap — only store, repo, and peerId are available.
  (window as any).__skein = {
    store,
    repo,
    peerId: repo.peerId,
    // stubs so callers that check for canvas/widgetManager don't crash
    widgetManager: null,
    app: null,
  };

  return { canvasDocId: store.handle.documentId };
}

(window as any).__initSkeinForTest = initSkeinForTest;

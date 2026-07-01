/**
 * lightweight test bootstrap for background sync peers.
 *
 * loads no PixiJS — just an automerge Repo + BroadcastChannelNetworkAdapter
 * + CanvasStore (via `createSkeinHarness`, see harness/skein-harness.ts).
 * used by multi-peer tests where background peers only need to observe or
 * mutate automerge state; they don't need a rendered canvas.
 *
 * exposes the same window.__skein.store interface as the full bootstrap so
 * existing test helpers and assertions work without modification.
 */

import { createSkeinHarness } from "../harness/skein-harness";

interface SyncTestInitOptions {
  canvasDocId?: string | null;
}

interface SyncTestInitResult {
  canvasDocId: string;
}

async function initSkeinForTest(options: SyncTestInitOptions = {}): Promise<SyncTestInitResult> {
  // intentionally ephemeral storage — the sync-only repo doesn't need its own
  // IndexedDB copy, the doc is always fetched from the primary peer via
  // BroadcastChannel. this avoids IDB write-lock contention with the primary
  // peer's repo (see createSkeinHarness's `ephemeralStorage` option).
  const harness = await createSkeinHarness({
    ephemeralStorage: true,
    canvasDocId: options.canvasDocId ?? null,
  });

  // expose the same window.__skein interface so test assertions work identically
  // to the full canvas bootstrap — only store, repo, and peerId are available.
  (window as any).__skein = {
    store: harness.store,
    repo: harness.repo,
    peerId: harness.repo.peerId,
    // stubs so callers that check for canvas/widgetManager don't crash
    widgetManager: null,
    app: null,
  };

  return { canvasDocId: harness.store.handle.documentId };
}

(window as any).__initSkeinForTest = initSkeinForTest;

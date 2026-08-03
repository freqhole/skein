// transfer-progress.ts — ephemeral, session-scoped polling of OUTGOING
// (this node serving a peer) blob transfer progress, so the file widget can
// show "peer: NN%"/"hub: NN%" labels distinct from the existing doc-backed
// "peer uploading... NN%" label (which tracks the opposite direction —
// someone else uploading bytes TO this widget's doc).
//
// two sources feed this, chosen per-runtime:
// - tauri mode: the `blob_transfer_progress` dispatch action, which reads
//   `freqhole_reliquary::gate::TransferRegistry` — see
//   `skein/tauri/src/commands.rs`.
// - browser/wasm (midden) mode: `getActiveTransfers()`
//   (`p2p/iroh-network-adapter.ts`), which reads midden's own
//   `TransferRegistry` (`tomb/lib/midden/src/transfers.rs`) — wired in by
//   `setBrowserTransferSource()` once an `IrohNetworkAdapter` exists (see
//   `standalone/boot.ts`). until that's called, browser mode is a no-op,
//   same as before this source existed.
//
// deliberately a tiny polling registry (mirrors `canvas/peer-names.ts`'s
// simplicity), not a global reactive store — see the file-widget-transfer-
// progress feature discussion for why a bigger global UI-state mechanism
// was explicitly deferred.

import { dispatch, isTauriMode } from "./tauri-transport";
import { log } from "@freqhole/reliquary/utils";

const TAG = "p2p.transfer-progress";

// short interval - small files can finish an entire transfer between two
// polls, so a chattier poll gives the widget a real chance of catching it.
const POLL_INTERVAL_MS = 300;

/** cap how many peers are shown per blob when a lot of peers/hubs are
 *  simultaneously snatching the same file - the rest are summarized as
 *  "+N more" by the caller. */
export const MAX_VISIBLE_TRANSFERS_PER_BLOB = 3;

export interface TransferProgressEntry {
  peerId: string;
  /** 0..1 */
  fraction: number;
}

type Listener = (entries: TransferProgressEntry[], truncatedCount: number) => void;

interface Subscription {
  listener: Listener;
  /** resolves whether `peerId` is a hub, for hub-first sorting/truncation -
   *  passed in per-subscription rather than as a shared global so this
   *  module never needs to know about `CanvasStore`. */
  isHubNode: (peerId: string) => boolean;
}

const subscriptionsByBlake3 = new Map<string, Set<Subscription>>();
let pollHandle: ReturnType<typeof setInterval> | null = null;

interface RawTransferRow {
  peerId: string;
  blake3: string;
  bytesSent: number;
  totalSize: number;
}

/** registered by `standalone/boot.ts` once a real `IrohNetworkAdapter`
 *  exists in browser mode - see this module's header comment. `null` in
 *  tauri mode (never called) and before boot wiring runs. */
let browserSource: (() => Promise<RawTransferRow[]>) | null = null;

/**
 * register the browser-mode active-transfers source. pass `null` to clear
 * it (e.g. on identity/adapter teardown). a no-op call in tauri mode is
 * harmless — `pollOnce` never consults `browserSource` there.
 */
export function setBrowserTransferSource(source: (() => Promise<RawTransferRow[]>) | null): void {
  browserSource = source;
}

function stopPollingIfIdle(): void {
  if (subscriptionsByBlake3.size === 0 && pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function pollOnce(): Promise<void> {
  if (subscriptionsByBlake3.size === 0) {
    stopPollingIfIdle();
    return;
  }
  let rows: RawTransferRow[];
  if (isTauriMode()) {
    try {
      const raw = await dispatch("blob_transfer_progress", {});
      rows = Array.isArray(raw) ? (raw as RawTransferRow[]) : [];
    } catch (err) {
      log.warn(TAG, "blob_transfer_progress dispatch failed:", err);
      return;
    }
  } else if (browserSource) {
    try {
      rows = await browserSource();
    } catch (err) {
      log.warn(TAG, "browser active-transfers source failed:", err);
      return;
    }
  } else {
    return;
  }

  const entriesByBlake3 = new Map<string, TransferProgressEntry[]>();
  for (const row of rows) {
    const fraction = row.totalSize > 0 ? row.bytesSent / row.totalSize : 0;
    const list = entriesByBlake3.get(row.blake3) ?? [];
    list.push({ peerId: row.peerId, fraction });
    entriesByBlake3.set(row.blake3, list);
  }

  for (const [blake3, subscriptions] of subscriptionsByBlake3) {
    const entries = entriesByBlake3.get(blake3) ?? [];
    for (const sub of subscriptions) {
      const sorted = [...entries].sort(
        (a, b) => Number(sub.isHubNode(b.peerId)) - Number(sub.isHubNode(a.peerId))
      );
      const visible = sorted.slice(0, MAX_VISIBLE_TRANSFERS_PER_BLOB);
      const truncatedCount = Math.max(0, sorted.length - visible.length);
      sub.listener(visible, truncatedCount);
    }
  }
}

function ensurePolling(): void {
  if (pollHandle !== null || (!isTauriMode() && !browserSource)) return;
  pollHandle = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

/** subscribe to outgoing-transfer progress for one blob (by blake3).
 *  returns an unsubscribe function. never calls back in browser mode until
 *  `setBrowserTransferSource()` has been called (see this module's header
 *  comment). */
export function subscribeTransferProgress(
  blake3: string,
  isHubNode: (peerId: string) => boolean,
  listener: Listener
): () => void {
  if (!blake3 || (!isTauriMode() && !browserSource)) {
    return () => {};
  }

  const sub: Subscription = { listener, isHubNode };
  let set = subscriptionsByBlake3.get(blake3);
  if (!set) {
    set = new Set();
    subscriptionsByBlake3.set(blake3, set);
  }
  set.add(sub);
  ensurePolling();
  // catch a transfer already in flight without waiting a full interval
  void pollOnce();

  return () => {
    set?.delete(sub);
    if (set && set.size === 0) {
      subscriptionsByBlake3.delete(blake3);
    }
    stopPollingIfIdle();
  };
}

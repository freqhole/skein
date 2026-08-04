/**
 * pending-transfers — merges every source of in-flight blob transfer into
 * one list for the filez narthex widget's tab 1 ("pending transfers"):
 * this node's own uploads/downloads (queued or active, from
 * `transfer-queue.ts`) plus blobs this node is currently serving OUT to a
 * peer/hub (from `p2p/transfer-progress.ts`'s wildcard feed), plus a
 * capped, clearable history of recently-finished rows. data-layer
 * only — no widget/UI code here. tab 2 (a full local-file inventory) is
 * explicitly out of scope for now; the shape below is kept generic enough
 * not to preclude it later, but nothing here builds it.
 */

import { log } from "@freqhole/reliquary/utils";
import { listPendingTransfers, cancelPendingTransfer, type PendingTransferEntry } from "./transfer-queue";
import {
  subscribeAllTransferProgress,
  type AllTransferProgressEntry,
} from "../p2p/transfer-progress";
import { getBlobCanvasRefs } from "./blob-canvas-refs";
import { peerNameFor } from "../canvas/peer-names";
import { pauseSnatchDownload, discardPausedDownload } from "./snatch";

const TAG = "widgets.pending-transfers";

// matches transfer-progress.ts's own poll cadence — no point ticking our
// merge any faster than the outgoing-transfer feed can actually change.
const POLL_INTERVAL_MS = 300;

// finished transfers are kept around this many entries deep (oldest first
// dropped) so the flyout doesn't grow forever across a long session — see
// clearCompletedTransfers() for the user-driven "clear now" path.
const MAX_COMPLETED_HISTORY = 100;

/**
 * one row of the merged pending-transfers list.
 *
 * `fraction` is only ever populated for "serving" rows — the outgoing-
 * transfer feed tracks real bytes-sent/total-size (see
 * `AllTransferProgressEntry`), but `listPendingTransfers()` (this node's
 * own uploads/downloads) only tracks queue state, not live byte progress;
 * upload.ts's and snatch.ts's `onProgress` callbacks report progress
 * per-call to whoever started that transfer, not into any globally
 * queryable store, so there's nothing honest to put here for those two
 * directions today.
 *
 * `state` becomes "completed" the moment a row drops out of the live
 * queue/outgoing feed (see emit()'s diffing below) — this layer can't
 * distinguish success from failure/cancellation, so "completed" just means
 * "no longer in flight", not "succeeded". completed rows are retained
 * (capped, see MAX_COMPLETED_HISTORY) until cleared via
 * clearCompletedTransfers(), not wiped the instant they finish.
 *
 * `canPause`/`canCancel` describe what's mechanically possible for a row's
 * direction/state, and are wired to real actions via pauseTransfer()/
 * cancelTransfer() below (downloads: both; uploads: cancel only; serving:
 * neither — not interruptible from the serving side at all; completed:
 * neither, nothing left to act on).
 */
export interface PendingTransferItem {
  id: string;
  direction: "upload" | "download" | "serving";
  state: "queued" | "active" | "completed";
  blobId?: string;
  filename?: string;
  /** for "serving": who's downloading from us. */
  peerId?: string;
  /** resolved display name for `peerId`, when known this session. */
  peerName?: string;
  /** canvas doc ids referencing `blobId`, when one is known. */
  canvasIds?: string[];
  /** 0..1 — only ever set for "serving" rows, see this interface's doc comment. */
  fraction?: number;
  startedAt?: number;
  /** set once state becomes "completed" — when this row left the live feed. */
  completedAt?: number;
  canPause: boolean;
  canCancel: boolean;
}

async function safeGetCanvasRefs(hash: string | undefined): Promise<string[] | undefined> {
  if (!hash) return undefined;
  try {
    const refs = await getBlobCanvasRefs(hash, hash);
    return refs.length > 0 ? refs : undefined;
  } catch (err) {
    log.debug(TAG, "getBlobCanvasRefs failed (non-fatal):", err);
    return undefined;
  }
}

async function toItem(entry: PendingTransferEntry): Promise<PendingTransferItem> {
  return {
    id: entry.id,
    direction: entry.direction,
    state: entry.state,
    blobId: entry.blobId,
    filename: entry.filename,
    canvasIds: await safeGetCanvasRefs(entry.blobId),
    startedAt: entry.startedAt,
    // pausing targets an in-flight download specifically (see
    // snatch.ts's pauseSnatchDownload) — nothing to pause while still
    // queued, and uploads have no pause mechanism at all.
    canPause: entry.direction === "download" && entry.state === "active",
    // both directions support cancellation via AbortSignal (queued
    // entries abort out of the wait; active ones abort mid-transfer) —
    // see cancelTransfer() below, which calls transfer-queue.ts's
    // cancelPendingTransfer(id) to actually trigger it.
    canCancel: true,
  };
}

async function toServingItem(row: AllTransferProgressEntry): Promise<PendingTransferItem> {
  return {
    id: `serving:${row.peerId}:${row.blake3}`,
    direction: "serving",
    state: "active",
    blobId: row.blake3,
    peerId: row.peerId,
    peerName: peerNameFor(row.peerId) ?? undefined,
    canvasIds: await safeGetCanvasRefs(row.blake3),
    fraction: row.fraction,
    // once iroh-blobs has accepted the request, this node is just serving
    // bytes — reliquary's TransferRegistry (gate.rs) and midden's mirror
    // (transfers.rs) expose no interrupt/cancel hook from the serving
    // side, only a read-only snapshot. not fabricating an affordance that
    // doesn't exist.
    canPause: false,
    canCancel: false,
  };
}

type Listener = (items: PendingTransferItem[]) => void;

const listeners = new Set<Listener>();
let pollHandle: ReturnType<typeof setInterval> | null = null;
let unsubOutgoing: (() => void) | null = null;
let latestOutgoing: AllTransferProgressEntry[] = [];
let emitInFlight = false;

// ids seen live (queued/active) as of the last emitted snapshot, plus their
// last-known item — used to detect completion the moment an id disappears
// from the live feeds (see emit() below).
let previousLiveIds = new Set<string>();
let previousLiveById = new Map<string, PendingTransferItem>();

// finished transfers, newest first, capped at MAX_COMPLETED_HISTORY — never
// persisted across a reload (in-memory only), cleared on demand via
// clearCompletedTransfers().
const completedHistory: PendingTransferItem[] = [];

async function emit(): Promise<void> {
  if (listeners.size === 0 || emitInFlight) return;
  emitInFlight = true;
  try {
    const local = listPendingTransfers();
    const liveItems = await Promise.all([
      ...local.map(toItem),
      ...latestOutgoing.map(toServingItem),
    ]);

    const liveIds = new Set(liveItems.map((item) => item.id));
    for (const id of previousLiveIds) {
      if (liveIds.has(id)) continue;
      const finished = previousLiveById.get(id);
      if (!finished) continue;
      completedHistory.unshift({
        ...finished,
        state: "completed",
        completedAt: Date.now(),
        fraction: undefined,
        canPause: false,
        canCancel: false,
      });
    }
    while (completedHistory.length > MAX_COMPLETED_HISTORY) completedHistory.pop();

    previousLiveIds = liveIds;
    previousLiveById = new Map(liveItems.map((item) => [item.id, item]));

    const allItems = [...liveItems, ...completedHistory];
    for (const listener of listeners) {
      listener(allItems);
    }
  } finally {
    emitInFlight = false;
  }
}

function ensurePolling(): void {
  if (pollHandle !== null) return;
  // listPendingTransfers() has no change-notification hook of its own (a
  // plain Map snapshot, see transfer-queue.ts), so this module polls it on
  // its own cadence rather than adding one there for a single caller.
  // reuses the same wildcard subscription as the widget's serving feed —
  // no second poll loop for that half.
  unsubOutgoing = subscribeAllTransferProgress((entries) => {
    latestOutgoing = entries;
  });
  pollHandle = setInterval(() => void emit(), POLL_INTERVAL_MS);
  void emit();
}

function stopPollingIfIdle(): void {
  if (listeners.size > 0) return;
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  unsubOutgoing?.();
  unsubOutgoing = null;
  latestOutgoing = [];
}

/**
 * subscribe to the merged pending-transfers list (uploads, downloads, and
 * outgoing-serving rows all in one feed). calls `listener` immediately with
 * a first snapshot, then again whenever the underlying sources tick.
 * returns an unsubscribe function.
 */
export function subscribeToPendingTransfers(listener: Listener): () => void {
  listeners.add(listener);
  ensurePolling();

  return () => {
    listeners.delete(listener);
    stopPollingIfIdle();
  };
}

/**
 * drop every retained "completed" row (does not touch anything still
 * queued/active) and re-emit immediately so an open flyout updates without
 * waiting for the next poll tick.
 */
export function clearCompletedTransfers(): void {
  completedHistory.length = 0;
  void emit();
}

/**
 * cancel a pending/active own transfer (upload or download). "serving"
 * rows and already-"completed" rows report canCancel: false and this
 * returns false for them without attempting anything.
 *
 * aborting transfer-queue.ts's AbortController alone is only enough to
 * drop a still-queued (not yet started) transfer — reliquary's
 * `snatchBlob`/`snatchBlobToDisk` only check `signal.aborted` between
 * peer-loop iterations, never during a single peer's in-flight download
 * call, so an already-started download keeps running against midden
 * regardless of that controller. for downloads, also fire the real
 * midden-level interrupt (snatch.ts's pauseSnatchDownload, which reaches
 * `download_cancel`/`download_cancel_by_blake3` in browser mode or the
 * `blob_iroh_download_cancel` IPC command in tauri mode) and discard the
 * paused partial so this is a genuine cancel, not a resumable pause.
 * uploads have no equivalent black-box network call to interrupt — the
 * controller abort is the whole mechanism there (browser: checked inside
 * the hashing/write loop; tauri: also fires blob_insert_cancel, see
 * upload.ts).
 */
export async function cancelTransfer(item: PendingTransferItem): Promise<boolean> {
  if (!item.canCancel) return false;
  const aborted = cancelPendingTransfer(item.id);
  let interrupted = false;
  if (item.direction === "download" && item.blobId) {
    try {
      interrupted = await pauseSnatchDownload({ blake3: item.blobId });
      await discardPausedDownload(item.blobId);
    } catch (err) {
      log.debug(TAG, `cancelTransfer(${item.id}): native interrupt failed (non-fatal):`, err);
    }
  }
  log.debug(
    TAG,
    `cancelTransfer(${item.id}): controller ${aborted ? "aborted" : "not registered"}` +
      (item.direction === "download" ? `, native interrupt ${interrupted ? "fired" : "no-op"}` : "")
  );
  return aborted || interrupted;
}

/**
 * pause an in-flight download (see PendingTransferItem's canPause doc
 * comment for exactly which rows this applies to). delegates to snatch.ts's
 * blake3-keyed pauseSnatchDownload — no AbortController handle needed for
 * this one, it's a separate midden-level pause mechanism.
 */
export async function pauseTransfer(item: PendingTransferItem): Promise<boolean> {
  if (!item.canPause || !item.blobId) return false;
  try {
    const ok = await pauseSnatchDownload({ blake3: item.blobId });
    log.debug(TAG, `pauseTransfer(${item.id}): ${ok ? "paused" : "nothing in flight to pause"}`);
    return ok;
  } catch (err) {
    log.debug(TAG, "pauseTransfer failed (non-fatal):", err);
    return false;
  }
}


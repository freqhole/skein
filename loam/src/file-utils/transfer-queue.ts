/**
 * app-wide transfer concurrency queues — a FIFO, abortable slot queue for
 * downloads and a separate one for uploads, so no single widget/batch can
 * flood the app with unbounded concurrent P2P downloads or local uploads.
 * standalone: no dependency on any other new file in this directory.
 */

/**
 * app-wide cap on simultaneous blob downloads, regardless of which widget
 * or batch started them. without this, several bins (each running its own
 * sequential download loop) or several file widgets snatching at once
 * could pile up an unbounded number of concurrent P2P downloads. mirrors
 * reliquary rust's `max_per_peer_downloads` default (4, bumped to 5 here) —
 * a number already proven reasonable for this kind of cap, just applied
 * here across peers rather than per-peer. runtime-adjustable via
 * `setMaxConcurrentDownloads()` (for a future settings UI).
 */
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;

/** app-wide cap on simultaneous uploads — kept separate from the download cap since the two compete for different resources (peer bandwidth vs local disk/hash throughput). */
const DEFAULT_MAX_CONCURRENT_UPLOADS = 5;

/** entry for a future "pending transfers" status UI. */
export interface PendingTransferEntry {
  id: string;
  direction: "upload" | "download";
  state: "active" | "queued";
  blobId?: string;
  filename?: string;
  startedAt: number;
}

/** live bookkeeping backing listPendingTransfers() — populated by createSlotQueue()'s acquire/release below. */
const pendingTransfers = new Map<string, PendingTransferEntry>();

/** snapshot of every transfer currently active or queued, across both directions — for a future queue-status UI. */
export function listPendingTransfers(): PendingTransferEntry[] {
  return Array.from(pendingTransfers.values());
}

interface SlotWaiter {
  release: () => void;
  onAbort: () => void;
}

/** metadata attached to a pending-transfer entry so the future status UI has something to show beyond a bare id. */
interface SlotMeta {
  blobId?: string;
  filename?: string;
}

/**
 * FIFO concurrency-gated slot queue — the mechanics (active count, waiter
 * list, abort handling, pending-transfer bookkeeping) are identical for
 * downloads and uploads, only the direction tag and default cap differ, so
 * both queues below share this one implementation instead of duplicating it.
 */
function createSlotQueue(direction: "upload" | "download", defaultMax: number) {
  let max = defaultMax;
  let activeCount = 0;
  const waiters: SlotWaiter[] = [];

  async function acquire(signal?: AbortSignal, meta?: SlotMeta): Promise<string> {
    if (signal?.aborted) {
      throw new DOMException("cancelled", "AbortError");
    }
    const id = crypto.randomUUID();
    // "queued" from the moment acquire is called, not from when a slot is
    // actually free, so callers can measure real queue wait time.
    const entry: PendingTransferEntry = {
      id,
      direction,
      state: "queued",
      blobId: meta?.blobId,
      filename: meta?.filename,
      startedAt: Date.now(),
    };
    pendingTransfers.set(id, entry);

    if (activeCount < max) {
      activeCount++;
      entry.state = "active";
      return id;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = {
        release: () => {
          signal?.removeEventListener("abort", waiter.onAbort);
          activeCount++;
          entry.state = "active";
          resolve();
        },
        onAbort: () => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          pendingTransfers.delete(id);
          reject(new DOMException("cancelled", "AbortError"));
        },
      };
      waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
    return id;
  }

  /** release a slot reserved via acquire(), waking the next queued caller (if any) and clearing its pending-transfer entry. */
  function release(id: string): void {
    activeCount--;
    pendingTransfers.delete(id);
    const next = waiters.shift();
    next?.release();
  }

  return {
    acquire,
    release,
    activeCount: () => activeCount,
    queuedCount: () => waiters.length,
    setMax: (n: number) => {
      max = n;
    },
  };
}

const downloadQueue = createSlotQueue("download", DEFAULT_MAX_CONCURRENT_DOWNLOADS);
const uploadQueue = createSlotQueue("upload", DEFAULT_MAX_CONCURRENT_UPLOADS);

/**
 * reserve one of the app-wide download slots, waiting in FIFO order if
 * none are free. resolves once a slot is held; rejects with an AbortError
 * if `signal` fires while still queued. always release the slot via
 * `releaseDownloadSlot()` in a `finally`, whatever the transfer's outcome —
 * that's what makes the queue resume correctly on finish, stall (timeout),
 * or abort alike.
 */
export async function acquireDownloadSlot(signal?: AbortSignal, meta?: SlotMeta): Promise<string> {
  return downloadQueue.acquire(signal, meta);
}

export function releaseDownloadSlot(slotId: string): void {
  downloadQueue.release(slotId);
}

/** number of downloads actually in flight right now — for a future queue-status UI. */
export function getActiveDownloadCount(): number {
  return downloadQueue.activeCount();
}

/** number of downloads waiting for a free slot right now — for a future queue-status UI. */
export function getQueuedDownloadCount(): number {
  return downloadQueue.queuedCount();
}

/** adjust the download concurrency cap at runtime — for a future settings UI. */
export function setMaxConcurrentDownloads(n: number): void {
  downloadQueue.setMax(n);
}

/** reserve one of the app-wide upload slots — same FIFO/abort semantics as acquireDownloadSlot(), just against the separate upload cap. */
export async function acquireUploadSlot(signal?: AbortSignal, meta?: SlotMeta): Promise<string> {
  return uploadQueue.acquire(signal, meta);
}

export function releaseUploadSlot(slotId: string): void {
  uploadQueue.release(slotId);
}

/** number of uploads actually in flight right now — for a future queue-status UI. */
export function getActiveUploadCount(): number {
  return uploadQueue.activeCount();
}

/** number of uploads waiting for a free slot right now — for a future queue-status UI. */
export function getQueuedUploadCount(): number {
  return uploadQueue.queuedCount();
}

/** adjust the upload concurrency cap at runtime — for a future settings UI. */
export function setMaxConcurrentUploads(n: number): void {
  uploadQueue.setMax(n);
}

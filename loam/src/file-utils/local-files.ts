/**
 * local-files — thin subscribe wrapper around phase 2's `listLocalBlobs()`
 * for the filez narthex widget's tab 2 ("local files"). unlike
 * `pending-transfers.ts`'s fixed-interval poll (a live, quickly-changing
 * feed with no natural "please refresh" signal), the local-file inventory
 * only changes on a caller-driven event (switch tab, change sort/search/
 * page, or a purge completes) — so this re-queries on demand via
 * `query()` rather than ticking on a timer.
 *
 * guards against out-of-order async responses (e.g. a fast search-box
 * retype firing several overlapping queries): only the LATEST in-flight
 * `query()` call's result is ever delivered to the listener — an older
 * one that resolves after a newer one was started is silently dropped.
 *
 * loading-state and page-accumulation (for infinite scroll) are left to
 * the caller — this module only ever reports "here's a fresh page (or an
 * error) for the most recent request", nothing more.
 */

import { log } from "@freqhole/reliquary/utils";
import { listLocalBlobs, type LocalBlobItem, type ListLocalBlobsOptions } from "./local-blobs";

const TAG = "widgets.local-files";

export type LocalFilesOptions = ListLocalBlobsOptions;

export type LocalFilesResult =
  | { ok: true; items: LocalBlobItem[]; totalCount: number; totalSize: number }
  | { ok: false; error: string };

export interface LocalFilesSubscription {
  /**
   * run a query and report its result to the listener once it settles.
   * a query started after this one supersedes it — this one's result is
   * silently discarded if it resolves after the newer one already has.
   */
  query(options: LocalFilesOptions): Promise<void>;
  /** stop delivering results to the listener (any still-in-flight query is dropped). */
  unsubscribe(): void;
}

export function subscribeToLocalFiles(
  listener: (result: LocalFilesResult) => void
): LocalFilesSubscription {
  let disposed = false;
  let requestSeq = 0;

  return {
    async query(options: LocalFilesOptions): Promise<void> {
      if (disposed) return;
      const seq = ++requestSeq;
      try {
        const page = await listLocalBlobs(options);
        if (disposed || seq !== requestSeq) return;
        listener({
          ok: true,
          items: page.items,
          totalCount: page.totalCount,
          totalSize: page.totalSize,
        });
      } catch (err) {
        if (disposed || seq !== requestSeq) return;
        log.debug(TAG, "listLocalBlobs failed:", err);
        listener({ ok: false, error: "failed to load local files" });
      }
    },

    unsubscribe(): void {
      disposed = true;
    },
  };
}

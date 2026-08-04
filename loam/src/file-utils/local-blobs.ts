/**
 * local-files listing — backs the filez widget's "local files" tab. unifies
 * browser (reliquary ts / IndexedDB, via storage/blob-store.ts's listBlobs)
 * and tauri (rust/sqlite, via the `blob_list` dispatch command) behind one
 * shape, since neither backend's raw response matches the other (browser
 * keys by `blob_id`+`created_at`; tauri keys by `blake3`+`created_at` and
 * additionally knows about `external` — user-picked files outside
 * skein's managed `blob-files/` dir, a concept that doesn't exist in the
 * browser build at all since OPFS storage there is 100% skein-managed).
 */

import { dispatch, isTauriMode } from "../p2p/tauri-transport";
import { listBlobs } from "../storage/blob-store";

export interface LocalBlobItem {
  /** browser: the blob_id (== blake3 for every record this store creates).
   *  tauri: the blake3 hex (tauri's blobz table has no separate blob_id). */
  blobId: string;
  blake3: string;
  filename?: string;
  mime?: string;
  size: number;
  createdAt: number;
  /** tauri-only: true for a user-picked file outside skein's managed
   *  blob-files/ dir (always false in the browser build). */
  external: boolean;
}

export interface ListLocalBlobsOptions {
  sort?: "size" | "filename" | "created_at";
  direction?: "asc" | "desc";
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListLocalBlobsPage {
  items: LocalBlobItem[];
  /** rows matching `search` (or every local file, with no `search`) - not
   *  just this page. */
  totalCount: number;
  /** bytes across every row matching `search` (or every local file). */
  totalSize: number;
}

interface TauriBlobListResponse {
  items: Array<{
    blake3: string;
    iroh_hash: string;
    filename: string | null;
    mime: string | null;
    size: number;
    created_at: number;
    external: boolean;
  }>;
  totalCount: number;
  totalSize: number;
}

export async function listLocalBlobs(options: ListLocalBlobsOptions = {}): Promise<ListLocalBlobsPage> {
  if (isTauriMode()) {
    const res = (await dispatch("blob_list", {
      limit: options.limit,
      offset: options.offset,
      sort: options.sort,
      direction: options.direction,
      search: options.search,
    })) as TauriBlobListResponse;

    return {
      items: res.items.map((b) => ({
        blobId: b.blake3,
        blake3: b.blake3,
        filename: b.filename ?? undefined,
        mime: b.mime ?? undefined,
        size: b.size,
        createdAt: b.created_at,
        external: b.external,
      })),
      totalCount: res.totalCount,
      totalSize: res.totalSize,
    };
  }

  const page = await listBlobs(options);
  return {
    items: page.items.map((r) => ({
      blobId: r.blob_id,
      blake3: r.blake3,
      filename: r.filename,
      mime: r.mime,
      size: r.size,
      createdAt: r.created_at,
      external: false,
    })),
    totalCount: page.totalCount,
    totalSize: page.totalSize,
  };
}

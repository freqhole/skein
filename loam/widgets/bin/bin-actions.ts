/**
 * batch actions for the bin widget — currently provides "snatch all" which
 * downloads all remote file blobs from P2P peers via a single batched
 * probe-and-download (see `snatchBlobBatch`).
 */

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import { resolveDocReady } from "../../src/p2p/doc-ready";
import { deepUnwrapAmStrings } from "../../src/canvas/automerge-values";
import type { CanvasStore } from "../../src/canvas/canvas-store";
import { getThumbnailDataUrl } from "../../src/file-utils/thumbnail-utils";
import {
  snatchBlobBatch,
  type PauseGate,
} from "../../src/file-utils/snatch";
import type { FileUploadResult, PeersMap, SnatchBlobInfo } from "../../src/file-utils/file-shared";
import { fileSchema, type FileState } from "../file";
import { binSchema, type BinState } from "./bin-schema";

// bounded wait for a child doc to sync before giving up on it — long
// enough for a cold/slow peer, short enough that one stuck doc doesn't
// hang the whole "snatch all" pass indefinitely.
const CHILD_DOC_READY_TIMEOUT_MS = 15_000;

// -----------------------------------------------------------------------
// types
// -----------------------------------------------------------------------

export interface SnatchAllProgress {
  /** total items to check */
  total: number;
  /** items already local (skipped) */
  alreadyLocal: number;
  /** items successfully snatched so far */
  snatched: number;
  /** items that failed */
  failed: number;
  /** currently downloading item index (0-based across all items) */
  currentIndex: number;
  /** widgetId of the item currently downloading (or that just completed),
   *  or null when no download is in flight (e.g. before start / after done).
   *  use this (not currentIndex) to target UI updates at a specific card. */
  currentWidgetId: string | null;
  /** download progress of current item (0.0 to 1.0; 0 between items) */
  currentProgress: number;
  /** whether the operation is complete */
  done: boolean;
}

export type SnatchAllCallback = (progress: SnatchAllProgress) => void;

export interface SnatchAllOptions {
  onProgress?: SnatchAllCallback;
  signal?: AbortSignal;
  /** pauses the download loop between blobs without aborting it — see `PauseGate`. */
  pauseGate?: PauseGate;
}

const TAG = "bin.actions";

// -----------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------

/** info about a file widget child of a bin */
interface BinFileChild {
  widgetId: string;
  docId: string;
  state: FileState;
}

/**
 * recursively collect all file widget children of a bin, including files
 * nested inside child bins. returns a flat list of widget IDs paired with
 * their doc IDs and parsed file state.
 */
async function collectFileChildren(
  binWidgetId: string,
  store: CanvasStore,
  repo: Repo
): Promise<BinFileChild[]> {
  const binEntry = store.getWidget(binWidgetId);
  if (!binEntry || !binEntry.docId) return [];

  // `repo.handles[...]` only holds docs this peer has already `repo.find()`'d
  // this session (e.g. by rendering that widget) — a nested bin that was
  // never individually opened/rendered would silently look empty. resolve
  // (and wait for) the handle properly instead, same fix as boot.ts's
  // otherCanvasStores gap.
  const handle = await resolveDocReady<BinState>(repo, binEntry.docId as DocumentId, {
    timeoutMs: CHILD_DOC_READY_TIMEOUT_MS,
  });
  if (!handle) return [];

  const doc = handle.doc();
  if (!doc) return [];

  // parse through bin schema to get the items array
  let items: Array<{ widgetId: string }>;
  try {
    const parsed = binSchema.parse(deepUnwrapAmStrings(doc));
    items = parsed.items;
  } catch {
    log.warn(TAG, "failed to parse bin doc for", binWidgetId);
    return [];
  }

  const result: BinFileChild[] = [];

  for (const item of items) {
    const childEntry = store.getWidget(item.widgetId);
    if (!childEntry) continue;

    // recurse into nested bins
    if (childEntry.type === "bin") {
      const nested = await collectFileChildren(item.widgetId, store, repo);
      result.push(...nested);
      continue;
    }

    // only process file widgets
    if (childEntry.type !== "file") continue;
    if (!childEntry.docId) continue;

    const childHandle = await resolveDocReady<FileState>(repo, childEntry.docId as DocumentId, {
      timeoutMs: CHILD_DOC_READY_TIMEOUT_MS,
    });
    if (!childHandle) continue;

    const childDoc = childHandle.doc();
    if (!childDoc) continue;

    try {
      // a widget doc the tumulus hub has ever written into directly (e.g.
      // stamping `snatchedBy` after a p2p snatch) round-trips string
      // fields as `ImmutableString` instances, which zod's `z.string()`
      // rejects outright — see `automerge-values.ts`'s own doc comment.
      const state = fileSchema.parse(deepUnwrapAmStrings(childDoc));
      if (!state.blobId) continue;
      result.push({
        widgetId: item.widgetId,
        docId: childEntry.docId,
        state,
      });
    } catch {
      log.warn(TAG, "failed to parse file doc for", item.widgetId);
    }
  }

  return result;
}

/**
 * write a successful snatch result back into the corresponding file
 * widget's automerge doc, then best-effort fetch + write a thumbnail.
 */
async function applySnatchResult(
  child: BinFileChild,
  result: FileUploadResult,
  repo: Repo
): Promise<void> {
  const childHandle = repo.handles[child.docId as DocumentId];
  if (!childHandle) return;

  childHandle.change((draft: any) => {
    draft.blobId = result.blobId;
    draft.domain = result.domain;
    draft.mime = result.mime;
    draft.size = result.size;
    draft.blake3 = result.blake3 ?? "";
  });

  try {
    const thumbDataUrl = await getThumbnailDataUrl(result.blobId, { size: 200 });
    if (thumbDataUrl) {
      childHandle.change((draft: any) => {
        draft.thumbnailDataUrl = thumbDataUrl;
      });
    }
  } catch {
    // thumbnail generation is best-effort — don't fail the snatch
    log.debug(TAG, "thumbnail generation failed for", result.blobId);
  }
}

// -----------------------------------------------------------------------
// main
// -----------------------------------------------------------------------

/**
 * download all remote file blobs inside a bin (and nested bins) via a
 * single batched probe-and-download. already-local files are skipped (the
 * batch helper handles that internally via locality cache + grimoire
 * lookup). progress is reported via the callback.
 *
 * graceful failure modes:
 *   - empty bin: returns immediately with done=true
 *   - all already local: returns done=true with alreadyLocal=total
 *   - no peers available: marks all remote files failed (no throw)
 *   - per-blob download failure: counted as failed, others continue
 *   - aborted: returns early with done=true
 */
export async function snatchAllInBin(
  binWidgetId: string,
  store: CanvasStore,
  repo: Repo,
  peers: PeersMap,
  options?: SnatchAllOptions
): Promise<SnatchAllProgress> {
  const { onProgress, signal, pauseGate } = options ?? {};

  const progress: SnatchAllProgress = {
    total: 0,
    alreadyLocal: 0,
    snatched: 0,
    failed: 0,
    currentIndex: 0,
    currentWidgetId: null,
    currentProgress: 0,
    done: false,
  };

  const emit = () => onProgress?.({ ...progress });

  // step 1: collect all file children (recursing into nested bins)
  const allFiles = await collectFileChildren(binWidgetId, store, repo);
  progress.total = allFiles.length;
  emit();

  if (allFiles.length === 0) {
    progress.done = true;
    emit();
    return progress;
  }

  if (signal?.aborted) {
    progress.done = true;
    emit();
    return progress;
  }

  // step 2: build SnatchBlobInfo[] parallel to allFiles. snatchBlobBatch
  // handles already-local detection internally so we don't need a
  // separate locality pass here.
  const blobInfos: SnatchBlobInfo[] = allFiles.map((file) => ({
    blobId: file.state.blobId,
    filename: file.state.filename,
    mime: file.state.mime,
    size: file.state.size,
    blake3: file.state.blake3,
    domain: file.state.domain,
  }));

  // step 3: short-circuit when no peers — snatchBlobBatch would throw
  // "no peers available", which is a poor UX when the user just isn't
  // connected to anyone yet. mark everything failed and surface that
  // through the normal progress channel.
  const peerCount = Object.keys(peers).length;
  if (peerCount === 0) {
    log.warn(TAG, "snatch all: no peers connected, nothing to snatch from");
    progress.failed = allFiles.length;
    progress.done = true;
    emit();
    return progress;
  }

  // step 4: hand the batch off. onBlobComplete fires for both
  // already-local and successfully-downloaded blobs (distinguished by
  // result.existing). per-blob failures show up as `null` entries in the
  // returned array.
  try {
    const results = await snatchBlobBatch(blobInfos, peers, {
      signal,
      pauseGate,
      isPeerOnline: (nodeId: string) => store.isPeerOnline(nodeId),
      onBlobComplete: (index, result) => {
        if (result.existing) {
          progress.alreadyLocal++;
        } else {
          progress.snatched++;
          // fire-and-forget doc update for the freshly-snatched blob.
          // batch advances to the next download while this settles, so
          // we don't await it here.
          void applySnatchResult(allFiles[index], result, repo);
        }
        progress.currentIndex = index;
        progress.currentWidgetId = allFiles[index]?.widgetId ?? null;
        progress.currentProgress = 1;
        emit();
      },
      onProgress: (_completed, _total, blobProgress, currentIndex) => {
        // blobProgress is -1 between downloads, 0..1 during one. only
        // emit fractional updates so we don't spam the renderer.
        if (blobProgress >= 0) {
          progress.currentIndex = currentIndex;
          progress.currentWidgetId = allFiles[currentIndex]?.widgetId ?? null;
          progress.currentProgress = blobProgress;
          emit();
        }
      },
    });

    // count blobs that came back null — the batch couldn't snatch them
    // from any peer.
    for (const r of results) {
      if (r === null) progress.failed++;
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      // user-initiated cancel — leave counters as they stand
    } else {
      // batch threw an unexpected error (e.g. all peers vanished
      // mid-flight). attribute anything un-accounted-for to failures so
      // the progress bar reflects reality.
      log.warn(TAG, "snatch all: batch threw:", err);
      const accounted = progress.alreadyLocal + progress.snatched + progress.failed;
      progress.failed += Math.max(0, allFiles.length - accounted);
    }
  }

  progress.done = true;
  progress.currentProgress = 0;
  progress.currentWidgetId = null;
  emit();
  return progress;
}

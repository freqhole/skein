/**
 * cross-canvas `snatchedBy` cleanup for local blob purges. when a blob's
 * local copy is freed/purged, every OTHER canvas still referencing that
 * blob (per `getBlobCanvasRefs`) would otherwise keep this peer listed in
 * its widgets' `snatchedBy`, so peers keep probing us for a blob we no
 * longer have. this walks every referencing canvas and splices this
 * peer's node id out of every file/audio-recording/voice-recording
 * widget whose blobId/blake3 matches — the same single-widget splice
 * `widgets/file.ts` already does for its own currently-open widget (see
 * its "blob is not local — remove ourselves from snatchedBy" comment),
 * generalized to run across every widget on every referencing canvas.
 *
 * best-effort: a canvas we can't currently open (unreachable peer, no
 * access, etc.) is silently skipped, matching this whole feature's
 * bounded-timeout/best-effort semantics (see the plan doc's "cross-canvas
 * unregister on purge" design decision) — not an error, since the
 * blob-canvas-ref-index row and the actual purge proceed either way.
 *
 * doesn't use `bin-actions.ts`'s `collectFileChildren()` — nested-bin
 * widgets already live in the flat canvas-doc `widgets` map (a bin's own
 * separate document tracks membership/ordering only, see
 * `CanvasStore.getChildren()`), so `store.allWidgets()` alone already
 * covers every widget on the canvas regardless of bin nesting.
 */

import type { DocumentId, Repo } from "@automerge/automerge-repo";
import { log } from "@freqhole/reliquary/utils";
import { CanvasStore } from "../canvas/canvas-store";
import { resolveDocReady } from "../p2p/doc-ready";
import { getBlobCanvasRefs } from "./blob-canvas-refs";
import { getLocalNodeId } from "./file-shared";

const TAG = "file-utils.unregister-blob";

// bounded per-canvas/per-widget waits so one unreachable doc can't hang
// the whole purge — matches bin-actions.ts's own CHILD_DOC_READY_TIMEOUT_MS.
const CANVAS_OPEN_TIMEOUT_MS = 15_000;
const WIDGET_DOC_READY_TIMEOUT_MS = 15_000;

const MEDIA_WIDGET_TYPES = new Set(["file", "audio-recording", "voice-recording"]);

interface MediaWidgetDoc {
  blobId?: string;
  blake3?: string;
  snatchedBy?: string[];
}

/**
 * remove the local peer's node id from `snatchedBy` on every file/
 * audio-recording/voice-recording widget matching `blobId`/`blake3`,
 * across every canvas currently known to reference that blob.
 */
export async function unregisterBlobFromAllCanvases(
  repo: Repo,
  blobId: string,
  blake3: string | null | undefined
): Promise<void> {
  const localNodeId = await getLocalNodeId();
  if (!localNodeId) return;

  const canvasDocIds = await getBlobCanvasRefs(blobId, blake3).catch((err) => {
    log.debug(TAG, "getBlobCanvasRefs failed (non-fatal):", err);
    return [] as string[];
  });
  if (canvasDocIds.length === 0) return;

  await Promise.allSettled(
    canvasDocIds.map((canvasDocId) =>
      unregisterInCanvas(repo, canvasDocId as DocumentId, blobId, blake3, localNodeId)
    )
  );
}

async function unregisterInCanvas(
  repo: Repo,
  canvasDocId: DocumentId,
  blobId: string,
  blake3: string | null | undefined,
  localNodeId: string
): Promise<void> {
  let store: CanvasStore;
  try {
    store = await CanvasStore.open(repo, canvasDocId, { timeoutMs: CANVAS_OPEN_TIMEOUT_MS });
  } catch (err) {
    log.debug(TAG, `skipping canvas ${canvasDocId} (couldn't open):`, err);
    return;
  }

  const mediaWidgets = store.allWidgets().filter((w) => MEDIA_WIDGET_TYPES.has(w.type) && w.docId);
  await Promise.allSettled(
    mediaWidgets.map((w) =>
      unregisterInWidget(repo, w.docId as DocumentId, blobId, blake3, localNodeId)
    )
  );
}

async function unregisterInWidget(
  repo: Repo,
  widgetDocId: DocumentId,
  blobId: string,
  blake3: string | null | undefined,
  localNodeId: string
): Promise<void> {
  const handle = await resolveDocReady<MediaWidgetDoc>(repo, widgetDocId, {
    timeoutMs: WIDGET_DOC_READY_TIMEOUT_MS,
  });
  if (!handle) return;

  const doc = handle.doc();
  if (!doc) return;

  const matches = (blake3 && doc.blake3 === blake3) || doc.blobId === blobId;
  if (!matches) return;

  const snatchedBy = (doc.snatchedBy ?? []).map(String);
  if (!snatchedBy.includes(localNodeId)) return;

  handle.change((draft) => {
    if (!draft.snatchedBy) return;
    const idx = draft.snatchedBy.findIndex((id: string) => String(id) === localNodeId);
    if (idx >= 0) draft.snatchedBy.splice(idx, 1);
  });
}
